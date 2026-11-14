#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Foreal-Estate — Google Cloud Run Deployment Script
#
# Zero local ADC requirement: uses active `gcloud` CLI auth (`gcloud auth login`),
# NOT `~/.config/gcloud/application_default_credentials.json`. Cloud Run runtime
# authenticates to Firestore via its attached service account metadata token.
#
# Strict preflight checks enforce:
#   - Confirmed GCP project, Cloud Run region (defaults to `us-west1`), and SA
#   - Explicit user confirmation of billing & hard spending/quota controls
#   - Verified ENABLED numeric Secret Manager versions (never assumes `1` or `latest`)
#   - Optional GOOGLE_PLACES_SERVER_KEY only when ENABLE_PLACES_SERVER_SECRET=true
#   - Best-effort session affinity + max-instances=1 + durable Firestore budget/session store
#   - RentCast global monthly limit strictly below the 50-call free tier
# ==============================================================================

GCLOUD_BIN="${GCLOUD_BIN:-$(command -v gcloud 2>/dev/null || echo /opt/homebrew/bin/gcloud)}"
SERVICE_NAME="${CLOUD_RUN_SERVICE_NAME:-foreal-estate}"
CLOUD_RUN_REGION="${CLOUD_RUN_REGION:-us-west1}"

RENTCAST_SECRET_NAME="${RENTCAST_SECRET_NAME:-foreal-rentcast-api-key}"
GEMINI_SECRET_NAME="${GEMINI_SECRET_NAME:-foreal-gemini-api-key}"
GOOGLE_PLACES_SECRET_NAME="${GOOGLE_PLACES_SECRET_NAME:-foreal-google-places-server-key}"
ENABLE_PLACES_SERVER_SECRET="${ENABLE_PLACES_SERVER_SECRET:-false}"

RENTCAST_SECRET_VERSION="${RENTCAST_SECRET_VERSION:-}"
GEMINI_SECRET_VERSION="${GEMINI_SECRET_VERSION:-}"
GOOGLE_PLACES_SECRET_VERSION="${GOOGLE_PLACES_SECRET_VERSION:-}"

CLOUD_RUN_MIN_INSTANCES="${CLOUD_RUN_MIN_INSTANCES:-0}"
CLOUD_RUN_MAX_INSTANCES="${CLOUD_RUN_MAX_INSTANCES:-1}"
CLOUD_RUN_CONCURRENCY="${CLOUD_RUN_CONCURRENCY:-20}"
CLOUD_RUN_TIMEOUT="${CLOUD_RUN_TIMEOUT:-30}"

RENTCAST_GLOBAL_MONTHLY_LIMIT="${RENTCAST_GLOBAL_MONTHLY_LIMIT:-35}"
RENTCAST_INITIAL_SPENT_CALLS="${RENTCAST_INITIAL_SPENT_CALLS:-0}"
FIRESTORE_BUDGET_COLLECTION="${FIRESTORE_BUDGET_COLLECTION:-rentcast_budget}"
GEMINI_EXPLAIN_MODEL="${GEMINI_EXPLAIN_MODEL:-gemini-4-hydrogen}"
GEMINI_EXPLAIN_FALLBACK_MODEL="${GEMINI_EXPLAIN_FALLBACK_MODEL:-gemini-2.5-flash}"
OSM_OVERPASS_URL="${OSM_OVERPASS_URL:-https://overpass-api.de/api/interpreter}"
ENABLE_SYNTHETIC_DEMO_MODE="${ENABLE_SYNTHETIC_DEMO_MODE:-false}"
GOOGLE_MAPS_BROWSER_KEY="${GOOGLE_MAPS_BROWSER_KEY:-}"

fail() {
  echo "[deploy-cloud-run] ERROR: $*" >&2
  exit 1
}

require_env() {
  local var_name="$1"
  local value="${!var_name:-}"
  if [[ -z "${value// }" ]]; then
    fail "Required environment variable '${var_name}' is not set."
  fi
}

resolve_verified_secret_version() {
  local secret_name="$1"
  local explicit_version="$2"

  # Ensure secret resource exists first (metadata only; never reads secret payload)
  "${GCLOUD_BIN}" secrets describe "${secret_name}" \
    --project="${GOOGLE_CLOUD_PROJECT}" \
    --quiet >/dev/null || fail "Secret '${secret_name}' was not found in project '${GOOGLE_CLOUD_PROJECT}'."

  local resolved_version=""
  if [[ -n "${explicit_version}" ]]; then
    if ! [[ "${explicit_version}" =~ ^[0-9]+$ ]]; then
      fail "Explicit version '${explicit_version}' for secret '${secret_name}' must be a numeric version ID (never 'latest')."
    fi
    local state
    state="$("${GCLOUD_BIN}" secrets versions describe "${explicit_version}" \
      --secret="${secret_name}" \
      --project="${GOOGLE_CLOUD_PROJECT}" \
      --format='value(state)' \
      --quiet)"
    if [[ "${state}" != "ENABLED" ]]; then
      fail "Secret '${secret_name}' version '${explicit_version}' is not ENABLED (state='${state:-unknown}')."
    fi
    resolved_version="${explicit_version}"
  else
    local raw_name
    raw_name="$("${GCLOUD_BIN}" secrets versions list "${secret_name}" \
      --project="${GOOGLE_CLOUD_PROJECT}" \
      --filter='state=ENABLED' \
      --sort-by='~createTime' \
      --limit=1 \
      --format='value(name)' \
      --quiet)"
    resolved_version="${raw_name##*/}"
    if ! [[ "${resolved_version}" =~ ^[0-9]+$ ]]; then
      fail "No ENABLED numeric version found for secret '${secret_name}' in project '${GOOGLE_CLOUD_PROJECT}'."
    fi
  fi

  echo "${resolved_version}"
}

echo "[deploy-cloud-run] Running strict preflight checks (region=${CLOUD_RUN_REGION})..."

if [[ ! -x "${GCLOUD_BIN}" ]]; then
  fail "'gcloud' CLI was not found or is not executable (${GCLOUD_BIN})."
fi

require_env "GOOGLE_CLOUD_PROJECT"
require_env "CLOUD_RUN_REGION"
require_env "CLOUD_RUN_SERVICE_ACCOUNT"

if [[ "${CONFIRM_BILLING_AND_SPENDING_LIMITS:-}" != "true" ]]; then
  fail "Set CONFIRM_BILLING_AND_SPENDING_LIMITS=true after verifying GCP billing alerts/caps, Cloud Run max-instances, and RentCast monthly limits."
fi

if ! [[ "${RENTCAST_GLOBAL_MONTHLY_LIMIT}" =~ ^[0-9]+$ ]] || (( RENTCAST_GLOBAL_MONTHLY_LIMIT < 1 || RENTCAST_GLOBAL_MONTHLY_LIMIT > 49 )); then
  fail "RENTCAST_GLOBAL_MONTHLY_LIMIT must be an integer between 1 and 49 (strictly below RentCast's 50-call monthly tier). Got: '${RENTCAST_GLOBAL_MONTHLY_LIMIT}'."
fi

if ! [[ "${RENTCAST_INITIAL_SPENT_CALLS}" =~ ^[0-9]+$ ]]; then
  fail "RENTCAST_INITIAL_SPENT_CALLS must be a non-negative integer. Got: '${RENTCAST_INITIAL_SPENT_CALLS}'."
fi

if ! [[ "${CLOUD_RUN_MIN_INSTANCES}" =~ ^[0-9]+$ ]]; then
  fail "CLOUD_RUN_MIN_INSTANCES must be a non-negative integer. Got: '${CLOUD_RUN_MIN_INSTANCES}'."
fi

if ! [[ "${CLOUD_RUN_MAX_INSTANCES}" =~ ^[0-9]+$ ]] || (( CLOUD_RUN_MAX_INSTANCES < 1 )); then
  fail "CLOUD_RUN_MAX_INSTANCES must be a positive integer. Got: '${CLOUD_RUN_MAX_INSTANCES}'."
fi

if ! [[ "${CLOUD_RUN_CONCURRENCY}" =~ ^[0-9]+$ ]] || (( CLOUD_RUN_CONCURRENCY < 1 )); then
  fail "CLOUD_RUN_CONCURRENCY must be a positive integer. Got: '${CLOUD_RUN_CONCURRENCY}'."
fi

# Reject commas in non-secret env vars that use comma-delimited gcloud flags
for env_val in \
  "${GOOGLE_CLOUD_PROJECT}" \
  "${CLOUD_RUN_REGION}" \
  "${CLOUD_RUN_SERVICE_ACCOUNT}" \
  "${GOOGLE_MAPS_BROWSER_KEY}" \
  "${OSM_OVERPASS_URL}"; do
  if [[ "${env_val}" == *","* ]]; then
    fail "Environment value '${env_val}' contains a comma, which breaks gcloud --set-env-vars parsing."
  fi
done

# Verify active gcloud CLI authentication (zero ADC required)
if ! "${GCLOUD_BIN}" auth list --filter="status:ACTIVE" --format="value(account)" --quiet 2>/dev/null | grep -q .; then
  fail "No active gcloud account found. Run '${GCLOUD_BIN} auth login' before deploying."
fi

echo "[deploy-cloud-run] Resolving verified ENABLED numeric Secret Manager versions in '${GOOGLE_CLOUD_PROJECT}'..."
RENTCAST_VER="$(resolve_verified_secret_version "${RENTCAST_SECRET_NAME}" "${RENTCAST_SECRET_VERSION}")"
GEMINI_VER="$(resolve_verified_secret_version "${GEMINI_SECRET_NAME}" "${GEMINI_SECRET_VERSION}")"
echo "[deploy-cloud-run] Verified secret versions: ${RENTCAST_SECRET_NAME}:${RENTCAST_VER}, ${GEMINI_SECRET_NAME}:${GEMINI_VER}"

SECRETS_ARG="RENTCAST_API_KEY=${RENTCAST_SECRET_NAME}:${RENTCAST_VER},GEMINI_API_KEY=${GEMINI_SECRET_NAME}:${GEMINI_VER}"
if [[ "${ENABLE_PLACES_SERVER_SECRET}" == "true" ]]; then
  PLACES_VER="$(resolve_verified_secret_version "${GOOGLE_PLACES_SECRET_NAME}" "${GOOGLE_PLACES_SECRET_VERSION}")"
  echo "[deploy-cloud-run] Verified optional secret version: ${GOOGLE_PLACES_SECRET_NAME}:${PLACES_VER}"
  SECRETS_ARG="${SECRETS_ARG},GOOGLE_PLACES_SERVER_KEY=${GOOGLE_PLACES_SECRET_NAME}:${PLACES_VER}"
fi

ENV_VARS_ARG="NODE_ENV=production"
ENV_VARS_ARG="${ENV_VARS_ARG},BUDGET_STORE_MODE=firestore"
ENV_VARS_ARG="${ENV_VARS_ARG},GOOGLE_CLOUD_PROJECT=${GOOGLE_CLOUD_PROJECT}"
ENV_VARS_ARG="${ENV_VARS_ARG},FIRESTORE_BUDGET_COLLECTION=${FIRESTORE_BUDGET_COLLECTION}"
ENV_VARS_ARG="${ENV_VARS_ARG},RENTCAST_GLOBAL_MONTHLY_LIMIT=${RENTCAST_GLOBAL_MONTHLY_LIMIT}"
ENV_VARS_ARG="${ENV_VARS_ARG},RENTCAST_INITIAL_SPENT_CALLS=${RENTCAST_INITIAL_SPENT_CALLS}"
ENV_VARS_ARG="${ENV_VARS_ARG},GEMINI_EXPLAIN_MODEL=${GEMINI_EXPLAIN_MODEL}"
ENV_VARS_ARG="${ENV_VARS_ARG},GEMINI_EXPLAIN_FALLBACK_MODEL=${GEMINI_EXPLAIN_FALLBACK_MODEL}"
ENV_VARS_ARG="${ENV_VARS_ARG},OSM_OVERPASS_URL=${OSM_OVERPASS_URL}"
ENV_VARS_ARG="${ENV_VARS_ARG},ENABLE_SYNTHETIC_DEMO_MODE=${ENABLE_SYNTHETIC_DEMO_MODE}"

if [[ -n "${GOOGLE_MAPS_BROWSER_KEY}" ]]; then
  ENV_VARS_ARG="${ENV_VARS_ARG},GOOGLE_MAPS_BROWSER_KEY=${GOOGLE_MAPS_BROWSER_KEY}"
fi

echo "[deploy-cloud-run] Deploying '${SERVICE_NAME}' to Cloud Run (${CLOUD_RUN_REGION})..."
"${GCLOUD_BIN}" run deploy "${SERVICE_NAME}" \
  --source=. \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --region="${CLOUD_RUN_REGION}" \
  --port=8080 \
  --service-account="${CLOUD_RUN_SERVICE_ACCOUNT}" \
  --min-instances="${CLOUD_RUN_MIN_INSTANCES}" \
  --max-instances="${CLOUD_RUN_MAX_INSTANCES}" \
  --session-affinity \
  --concurrency="${CLOUD_RUN_CONCURRENCY}" \
  --timeout="${CLOUD_RUN_TIMEOUT}" \
  --allow-unauthenticated \
  --set-secrets="${SECRETS_ARG}" \
  --set-env-vars="${ENV_VARS_ARG}" \
  --quiet

SERVICE_URL="$("${GCLOUD_BIN}" run services describe "${SERVICE_NAME}" \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --region="${CLOUD_RUN_REGION}" \
  --format='value(status.url)' \
  --quiet)"

if [[ -z "${SERVICE_URL}" ]]; then
  fail "Deployment completed, but failed to retrieve status.url for '${SERVICE_NAME}'."
fi

echo ""
echo "[deploy-cloud-run] Deployment succeeded."
echo "Service URL: ${SERVICE_URL}"
echo ""
echo "Post-deploy smoke test commands (verify HTTP 200 and zero secret leakage):"
echo "  curl -fsS \"${SERVICE_URL}/api/health\""
echo "  curl -fsS \"${SERVICE_URL}/api/config\""
echo "  curl -fsSI \"${SERVICE_URL}/\""
