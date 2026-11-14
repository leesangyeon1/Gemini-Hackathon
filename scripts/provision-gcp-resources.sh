#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Foreal-Estate — Idempotent Google Cloud Provisioning Helper
#
# Zero local ADC requirement: uses active `gcloud` CLI auth (`gcloud auth login`),
# NOT `~/.config/gcloud/application_default_credentials.json`.
#
# Prepares a billing-linked GCP project for Cloud Run deployment (`us-west1` default):
#   1. Verifies GOOGLE_CLOUD_PROJECT, CLOUD_RUN_REGION (defaults to `us-west1`),
#      active gcloud auth, and linked Cloud Billing (`billingEnabled: true`).
#   2. Enables ONLY required APIs:
#      run.googleapis.com, cloudbuild.googleapis.com,
#      artifactregistry.googleapis.com, secretmanager.googleapis.com,
#      firestore.googleapis.com, maps-backend.googleapis.com
#   3. Creates least-privilege runtime SA:
#      foreal-estate-runtime@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com
#      and grants `roles/datastore.user`.
#   4. Creates (default) Firestore Native database if absent.
#   5. Creates individual Secret Manager entries `foreal-rentcast-api-key`,
#      `foreal-gemini-api-key` (and optional `foreal-google-places-server-key`
#      ONLY when ENABLE_PLACES_SERVER_SECRET=true), grants per-secret
#      `roles/secretmanager.secretAccessor` (never project-wide secret access!),
#      prompts securely via `read -r -s` + `--data-file=-`, and verifies the
#      resulting ENABLED numeric secret version ID (never assumes `1` or `latest`).
# ==============================================================================

GCLOUD_BIN="${GCLOUD_BIN:-$(command -v gcloud 2>/dev/null || echo /opt/homebrew/bin/gcloud)}"
CLOUD_RUN_REGION="${CLOUD_RUN_REGION:-us-west1}"
SA_NAME="${CLOUD_RUN_SA_NAME:-foreal-estate-runtime}"
RENTCAST_SECRET_NAME="${RENTCAST_SECRET_NAME:-foreal-rentcast-api-key}"
GEMINI_SECRET_NAME="${GEMINI_SECRET_NAME:-foreal-gemini-api-key}"
GOOGLE_PLACES_SECRET_NAME="${GOOGLE_PLACES_SECRET_NAME:-foreal-google-places-server-key}"
ENABLE_PLACES_SERVER_SECRET="${ENABLE_PLACES_SERVER_SECRET:-false}"
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-}"

fail() {
  echo "[provision-gcp] ERROR: $*" >&2
  exit 1
}

require_env() {
  local var_name="$1"
  local value="${!var_name:-}"
  if [[ -z "${value// }" ]]; then
    fail "Required environment variable '${var_name}' is not set."
  fi
}

echo "[provision-gcp] Running preflight checks (region=${CLOUD_RUN_REGION})..."

if [[ ! -x "${GCLOUD_BIN}" ]]; then
  fail "'gcloud' CLI was not found or is not executable (${GCLOUD_BIN})."
fi

require_env "GOOGLE_CLOUD_PROJECT"
require_env "CLOUD_RUN_REGION"

if [[ -z "${FIRESTORE_LOCATION}" ]]; then
  FIRESTORE_LOCATION="${CLOUD_RUN_REGION}"
fi

if [[ "${CONFIRM_GCP_PROVISIONING:-}" != "true" ]]; then
  fail "Set CONFIRM_GCP_PROVISIONING=true after confirming project '${GOOGLE_CLOUD_PROJECT}' and region '${CLOUD_RUN_REGION}'."
fi

if ! "${GCLOUD_BIN}" auth list --filter="status:ACTIVE" --format="value(account)" --quiet 2>/dev/null | grep -q .; then
  fail "No active gcloud account found. Run '${GCLOUD_BIN} auth login' first."
fi

BILLING_ENABLED="$("${GCLOUD_BIN}" billing projects describe "${GOOGLE_CLOUD_PROJECT}" --format='value(billingEnabled)' --quiet 2>/dev/null || echo "")"
if [[ "${BILLING_ENABLED}" != "True" && "${BILLING_ENABLED}" != "true" ]]; then
  fail "Billing is not enabled on project '${GOOGLE_CLOUD_PROJECT}' (billingEnabled='${BILLING_ENABLED:-unknown}'). Link a Cloud Billing account before provisioning."
fi

RUNTIME_SA_EMAIL="${SA_NAME}@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com"

echo "[provision-gcp] Enabling required APIs on '${GOOGLE_CLOUD_PROJECT}'..."
"${GCLOUD_BIN}" services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  firestore.googleapis.com \
  maps-backend.googleapis.com \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --quiet

echo "[provision-gcp] Ensuring least-privilege runtime service account '${RUNTIME_SA_EMAIL}' exists..."
if ! "${GCLOUD_BIN}" iam service-accounts describe "${RUNTIME_SA_EMAIL}" --project="${GOOGLE_CLOUD_PROJECT}" --quiet >/dev/null 2>&1; then
  "${GCLOUD_BIN}" iam service-accounts create "${SA_NAME}" \
    --project="${GOOGLE_CLOUD_PROJECT}" \
    --display-name="Foreal-Estate Cloud Run Runtime" \
    --description="Least-privilege runtime identity for Foreal-Estate Cloud Run service" \
    --quiet
fi

echo "[provision-gcp] Granting roles/datastore.user to '${RUNTIME_SA_EMAIL}'..."
"${GCLOUD_BIN}" projects add-iam-policy-binding "${GOOGLE_CLOUD_PROJECT}" \
  --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
  --role="roles/datastore.user" \
  --quiet >/dev/null

echo "[provision-gcp] Ensuring (default) Firestore Native database exists (location=${FIRESTORE_LOCATION})..."
if ! "${GCLOUD_BIN}" firestore databases describe --database="(default)" --project="${GOOGLE_CLOUD_PROJECT}" --quiet >/dev/null 2>&1; then
  "${GCLOUD_BIN}" firestore databases create \
    --database="(default)" \
    --location="${FIRESTORE_LOCATION}" \
    --type="firestore-native" \
    --project="${GOOGLE_CLOUD_PROJECT}" \
    --quiet
fi

ensure_secret_and_bind() {
  local secret_name="$1"
  local prompt_label="$2"

  if ! "${GCLOUD_BIN}" secrets describe "${secret_name}" --project="${GOOGLE_CLOUD_PROJECT}" --quiet >/dev/null 2>&1; then
    echo "[provision-gcp] Creating Secret Manager secret '${secret_name}'..."
    "${GCLOUD_BIN}" secrets create "${secret_name}" \
      --replication-policy="automatic" \
      --project="${GOOGLE_CLOUD_PROJECT}" \
      --quiet
  fi

  echo "[provision-gcp] Granting per-secret roles/secretmanager.secretAccessor on '${secret_name}' to '${RUNTIME_SA_EMAIL}'..."
  "${GCLOUD_BIN}" secrets add-iam-policy-binding "${secret_name}" \
    --project="${GOOGLE_CLOUD_PROJECT}" \
    --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" \
    --quiet >/dev/null

  if [[ -t 0 ]]; then
    local secret_val=""
    printf "[provision-gcp] Enter %s value (hidden; leave blank to keep existing ENABLED version): " "${prompt_label}"
    IFS= read -r -s secret_val
    echo ""
    if [[ -n "${secret_val}" ]]; then
      printf '%s' "${secret_val}" | "${GCLOUD_BIN}" secrets versions add "${secret_name}" \
        --project="${GOOGLE_CLOUD_PROJECT}" \
        --data-file=- \
        --quiet >/dev/null
      unset secret_val
      echo "[provision-gcp] Added new secret version to '${secret_name}'."
    else
      echo "[provision-gcp] Skipped adding version for '${secret_name}'."
    fi
  else
    echo "[provision-gcp] Non-interactive shell: run 'read -r -s val && printf \"%s\" \"\$val\" | ${GCLOUD_BIN} secrets versions add ${secret_name} --project=${GOOGLE_CLOUD_PROJECT} --data-file=-' to populate '${secret_name}'."
  fi

  local raw_ver verified_ver
  raw_ver="$("${GCLOUD_BIN}" secrets versions list "${secret_name}" \
    --project="${GOOGLE_CLOUD_PROJECT}" \
    --filter='state=ENABLED' \
    --sort-by='~createTime' \
    --limit=1 \
    --format='value(name)' \
    --quiet || echo "")"
  verified_ver="${raw_ver##*/}"
  if [[ "${verified_ver}" =~ ^[0-9]+$ ]]; then
    echo "[provision-gcp] Verified ENABLED version for '${secret_name}': ${verified_ver}"
  else
    echo "[provision-gcp] WARNING: No ENABLED numeric version found yet for '${secret_name}'."
  fi
}

ensure_secret_and_bind "${RENTCAST_SECRET_NAME}" "RENTCAST_API_KEY"
ensure_secret_and_bind "${GEMINI_SECRET_NAME}" "GEMINI_API_KEY"

if [[ "${ENABLE_PLACES_SERVER_SECRET}" == "true" ]]; then
  ensure_secret_and_bind "${GOOGLE_PLACES_SECRET_NAME}" "GOOGLE_PLACES_SERVER_KEY"
fi

echo ""
echo "[provision-gcp] Provisioning complete."
echo "Runtime Service Account: ${RUNTIME_SA_EMAIL}"
echo "Next step: export CLOUD_RUN_REGION='${CLOUD_RUN_REGION}' CLOUD_RUN_SERVICE_ACCOUNT='${RUNTIME_SA_EMAIL}' CONFIRM_BILLING_AND_SPENDING_LIMITS=true && ./scripts/deploy-cloud-run.sh"
