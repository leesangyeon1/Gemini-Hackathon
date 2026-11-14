#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Foreal-Estate — Idempotent Google Cloud Provisioning Helper
#
# Prepares a billing-linked GCP project for Cloud Run deployment:
#   1. Verifies GOOGLE_CLOUD_PROJECT, CLOUD_RUN_REGION, active gcloud auth,
#      and linked Cloud Billing (`billingEnabled: true`).
#   2. Enables ONLY required APIs:
#      run.googleapis.com, cloudbuild.googleapis.com,
#      artifactregistry.googleapis.com, secretmanager.googleapis.com,
#      firestore.googleapis.com, maps-backend.googleapis.com
#   3. Creates least-privilege runtime SA:
#      foreal-estate-runtime@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com
#      and grants `roles/datastore.user`.
#   4. Creates (default) Firestore Native database if absent.
#   5. Creates Secret Manager entries `foreal-rentcast-api-key` and
#      `foreal-gemini-api-key` (never project-wide secret access!), binds
#      per-secret `roles/secretmanager.secretAccessor` to the runtime SA,
#      and prompts securely via `read -r -s` without shell history or CLI args.
# ==============================================================================

SA_NAME="${CLOUD_RUN_SA_NAME:-foreal-estate-runtime}"
RENTCAST_SECRET_NAME="${RENTCAST_SECRET_NAME:-foreal-rentcast-api-key}"
GEMINI_SECRET_NAME="${GEMINI_SECRET_NAME:-foreal-gemini-api-key}"
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

echo "[provision-gcp] Running preflight checks..."

if ! command -v gcloud >/dev/null 2>&1; then
  fail "'gcloud' CLI was not found in PATH."
fi

require_env "GOOGLE_CLOUD_PROJECT"
require_env "CLOUD_RUN_REGION"

if [[ -z "${FIRESTORE_LOCATION}" ]]; then
  FIRESTORE_LOCATION="${CLOUD_RUN_REGION}"
fi

if [[ "${CONFIRM_GCP_PROVISIONING:-}" != "true" ]]; then
  fail "Set CONFIRM_GCP_PROVISIONING=true after confirming project '${GOOGLE_CLOUD_PROJECT}' and region '${CLOUD_RUN_REGION}'."
fi

if ! gcloud auth list --filter="status:ACTIVE" --format="value(account)" --quiet 2>/dev/null | grep -q .; then
  fail "No active gcloud account found. Run 'gcloud auth login' first."
fi

BILLING_ENABLED="$(gcloud billing projects describe "${GOOGLE_CLOUD_PROJECT}" --format='value(billingEnabled)' --quiet 2>/dev/null || echo "")"
if [[ "${BILLING_ENABLED}" != "True" && "${BILLING_ENABLED}" != "true" ]]; then
  fail "Billing is not enabled on project '${GOOGLE_CLOUD_PROJECT}' (billingEnabled='${BILLING_ENABLED:-unknown}'). Link a Cloud Billing account before provisioning."
fi

RUNTIME_SA_EMAIL="${SA_NAME}@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com"

echo "[provision-gcp] Enabling required APIs on '${GOOGLE_CLOUD_PROJECT}'..."
gcloud services enable \
  run.googleapis.com \
  cloudbuild.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  firestore.googleapis.com \
  maps-backend.googleapis.com \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --quiet

echo "[provision-gcp] Ensuring least-privilege runtime service account '${RUNTIME_SA_EMAIL}' exists..."
if ! gcloud iam service-accounts describe "${RUNTIME_SA_EMAIL}" --project="${GOOGLE_CLOUD_PROJECT}" --quiet >/dev/null 2>&1; then
  gcloud iam service-accounts create "${SA_NAME}" \
    --project="${GOOGLE_CLOUD_PROJECT}" \
    --display-name="Foreal-Estate Cloud Run Runtime" \
    --description="Least-privilege runtime identity for Foreal-Estate Cloud Run service" \
    --quiet
fi

echo "[provision-gcp] Granting roles/datastore.user to '${RUNTIME_SA_EMAIL}'..."
gcloud projects add-iam-policy-binding "${GOOGLE_CLOUD_PROJECT}" \
  --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
  --role="roles/datastore.user" \
  --quiet >/dev/null

echo "[provision-gcp] Ensuring (default) Firestore Native database exists (location=${FIRESTORE_LOCATION})..."
if ! gcloud firestore databases describe --database="(default)" --project="${GOOGLE_CLOUD_PROJECT}" --quiet >/dev/null 2>&1; then
  gcloud firestore databases create \
    --database="(default)" \
    --location="${FIRESTORE_LOCATION}" \
    --type="firestore-native" \
    --project="${GOOGLE_CLOUD_PROJECT}" \
    --quiet
fi

ensure_secret_and_bind() {
  local secret_name="$1"
  local prompt_label="$2"

  if ! gcloud secrets describe "${secret_name}" --project="${GOOGLE_CLOUD_PROJECT}" --quiet >/dev/null 2>&1; then
    echo "[provision-gcp] Creating Secret Manager secret '${secret_name}'..."
    gcloud secrets create "${secret_name}" \
      --replication-policy="automatic" \
      --project="${GOOGLE_CLOUD_PROJECT}" \
      --quiet
  fi

  echo "[provision-gcp] Granting per-secret roles/secretmanager.secretAccessor on '${secret_name}' to '${RUNTIME_SA_EMAIL}'..."
  gcloud secrets add-iam-policy-binding "${secret_name}" \
    --project="${GOOGLE_CLOUD_PROJECT}" \
    --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
    --role="roles/secretmanager.secretAccessor" \
    --quiet >/dev/null

  if [[ -t 0 ]]; then
    local secret_val=""
    printf "[provision-gcp] Enter %s value (hidden; leave blank to skip adding a new version): " "${prompt_label}"
    IFS= read -r -s secret_val
    echo ""
    if [[ -n "${secret_val}" ]]; then
      printf '%s' "${secret_val}" | gcloud secrets versions add "${secret_name}" \
        --project="${GOOGLE_CLOUD_PROJECT}" \
        --data-file=- \
        --quiet >/dev/null
      unset secret_val
      echo "[provision-gcp] Added new secret version to '${secret_name}'."
    else
      echo "[provision-gcp] Skipped adding version for '${secret_name}'."
    fi
  else
    echo "[provision-gcp] Non-interactive shell: run 'read -r -s val && printf \"%s\" \"\$val\" | gcloud secrets versions add ${secret_name} --project=${GOOGLE_CLOUD_PROJECT} --data-file=-' to populate '${secret_name}'."
  fi
}

ensure_secret_and_bind "${RENTCAST_SECRET_NAME}" "RENTCAST_API_KEY"
ensure_secret_and_bind "${GEMINI_SECRET_NAME}" "GEMINI_API_KEY"

echo ""
echo "[provision-gcp] Provisioning complete."
echo "Runtime Service Account: ${RUNTIME_SA_EMAIL}"
echo "Next step: export CLOUD_RUN_SERVICE_ACCOUNT='${RUNTIME_SA_EMAIL}' CONFIRM_BILLING_AND_SPENDING_LIMITS=true && ./scripts/deploy-cloud-run.sh"
