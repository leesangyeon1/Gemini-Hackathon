#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Foreal-Estate — Google Cloud Run Deployment Script
#
# Strict preflight checks enforce:
#   - Confirmed GCP project, Cloud Run region, and runtime service account
#   - Explicit user confirmation of billing & hard spending/quota controls
#   - Secret Manager separation for server-only keys (RENTCAST_API_KEY, GEMINI_API_KEY,
#     optional GOOGLE_PLACES_SERVER_KEY) vs. restricted browser key (GOOGLE_MAPS_BROWSER_KEY)
#   - Durable Firestore atomic budget mode (`BUDGET_STORE_MODE=firestore`)
#   - RentCast global monthly limit strictly below the 50-call free tier
# ==============================================================================

SERVICE_NAME="${CLOUD_RUN_SERVICE_NAME:-foreal-estate}"
RENTCAST_SECRET_NAME="${RENTCAST_SECRET_NAME:-rentcast-api-key}"
GEMINI_SECRET_NAME="${GEMINI_SECRET_NAME:-gemini-api-key}"
GOOGLE_PLACES_SECRET_NAME="${GOOGLE_PLACES_SECRET_NAME:-}"

CLOUD_RUN_MAX_INSTANCES="${CLOUD_RUN_MAX_INSTANCES:-2}"
CLOUD_RUN_CONCURRENCY="${CLOUD_RUN_CONCURRENCY:-20}"
CLOUD_RUN_TIMEOUT="${CLOUD_RUN_TIMEOUT:-60s}"

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

echo "[deploy-cloud-run] Running strict preflight checks..."

if ! command -v gcloud >/dev/null 2>&1; then
  fail "'gcloud' CLI was not found in PATH. Install Google Cloud SDK and authenticate before deploying."
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

if ! [[ "${CLOUD_RUN_MAX_INSTANCES}" =~ ^[0-9]+$ ]] || (( CLOUD_RUN_MAX_INSTANCES < 1 )); then
  fail "CLOUD_RUN_MAX_INSTANCES must be a positive integer. Got: '${CLOUD_RUN_MAX_INSTANCES}'."
fi

if ! [[ "${CLOUD_RUN_CONCURRENCY}" =~ ^[0-9]+$ ]] || (( CLOUD_RUN_CONCURRENCY < 1 )); then
  fail "CLOUD_RUN_CONCURRENCY must be a positive integer. Got: '${CLOUD_RUN_CONCURRENCY}'."
fi

# Reject unsafe placeholder secrets or commas in non-secret env vars that use comma-delimited gcloud flags
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

# Verify active gcloud authentication
if ! gcloud auth list --filter="status:ACTIVE" --format="value(account)" --quiet 2>/dev/null | grep -q .; then
  fail "No active gcloud account found. Run 'gcloud auth login' before deploying."
fi

# Verify required Secret Manager secrets exist (never reading secret values)
echo "[deploy-cloud-run] Verifying Secret Manager entries in project '${GOOGLE_CLOUD_PROJECT}'..."
gcloud secrets describe "${RENTCAST_SECRET_NAME}" --project="${GOOGLE_CLOUD_PROJECT}" >/dev/null
gcloud secrets describe "${GEMINI_SECRET_NAME}" --project="${GOOGLE_CLOUD_PROJECT}" >/dev/null

SECRETS_ARG="RENTCAST_API_KEY=${RENTCAST_SECRET_NAME}:latest,GEMINI_API_KEY=${GEMINI_SECRET_NAME}:latest"
if [[ -n "${GOOGLE_PLACES_SECRET_NAME}" ]]; then
  gcloud secrets describe "${GOOGLE_PLACES_SECRET_NAME}" --project="${GOOGLE_CLOUD_PROJECT}" >/dev/null
  SECRETS_ARG="${SECRETS_ARG},GOOGLE_PLACES_SERVER_KEY=${GOOGLE_PLACES_SECRET_NAME}:latest"
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
gcloud run deploy "${SERVICE_NAME}" \
  --source=. \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --region="${CLOUD_RUN_REGION}" \
  --port=8080 \
  --service-account="${CLOUD_RUN_SERVICE_ACCOUNT}" \
  --max-instances="${CLOUD_RUN_MAX_INSTANCES}" \
  --concurrency="${CLOUD_RUN_CONCURRENCY}" \
  --timeout="${CLOUD_RUN_TIMEOUT}" \
  --allow-unauthenticated \
  --set-secrets="${SECRETS_ARG}" \
  --set-env-vars="${ENV_VARS_ARG}"

SERVICE_URL="$(gcloud run services describe "${SERVICE_NAME}" \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --region="${CLOUD_RUN_REGION}" \
  --format='value(status.url)')"

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
