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
#   - Safe non-secret config fallback from `.env` if unset in environment
#     (GOOGLE_CLOUD_PROJECT, RENTCAST_GLOBAL_MONTHLY_LIMIT,
#      RENTCAST_INITIAL_SPENT_CALLS, GOOGLE_MAPS_BROWSER_KEY) without echoing keys
#   - Explicit user confirmation of billing & hard spending/quota controls
#     (CONFIRM_BILLING_AND_SPENDING_LIMITS=true) BEFORE any gcloud call
#   - Verified ENABLED numeric Secret Manager versions (never assumes `1` or `latest`)
#   - Optional GOOGLE_PLACES_SERVER_KEY only when ENABLE_PLACES_SERVER_SECRET=true
#   - Best-effort session affinity + max-instances=1 + durable Firestore budget/session store
#   - RentCast global monthly limit strictly below the 50-call free tier
#   - Post-deploy tightening/enforcement of `foreal-estate-maps-browser` API key
#     restrictions to `maps-backend.googleapis.com` and exact dev + deployed origins
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DOTENV_FILE="${DOTENV_FILE:-${REPO_ROOT}/.env}"

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

# Pure-bash .env reader: never sources, evaluates, or prints values to terminal.
read_dotenv_var() {
  local dotenv_path="$1"
  local target_key="$2"
  if [[ ! -f "${dotenv_path}" ]]; then
    return 0
  fi
  local line key val
  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line%$'\r'}"
    if [[ -z "${line//[[:space:]]/}" || "${line}" =~ ^[[:space:]]*# ]]; then
      continue
    fi
    if [[ "${line}" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]]; then
      key="${BASH_REMATCH[2]}"
      val="${BASH_REMATCH[3]}"
      if [[ "${key}" == "${target_key}" ]]; then
        if [[ "${val}" =~ ^\"(.*)\"[[:space:]]*$ ]]; then
          val="${BASH_REMATCH[1]}"
        elif [[ "${val}" =~ ^\'(.*)\'[[:space:]]*$ ]]; then
          val="${BASH_REMATCH[1]}"
        else
          val="${val#"${val%%[![:space:]]*}"}"
          val="${val%"${val##*[![:space:]]}"}"
        fi
        printf '%s' "${val}"
        return 0
      fi
    fi
  done < "${dotenv_path}"
}

# Runs a gcloud command while suppressing LRO status payloads and scrubbing any
# key material from error output if the command fails.
run_gcloud_redacted() {
  local raw_out=""
  local exit_code=0
  raw_out="$("$@" 2>&1)" || exit_code=$?
  if (( exit_code != 0 )); then
    local safe_out=""
    safe_out="$(printf '%s' "${raw_out}" | python3 -c '
import re, sys
s = sys.stdin.read()
s = re.sub(r"(\"keyString\"\s*:\s*\")[^\"]+(\")", r"\1[REDACTED]\2", s)
s = re.sub(r"(keyString\s*[:=]\s*)\S+", r"\1[REDACTED]", s)
s = re.sub(r"AIza[0-9A-Za-z_-]{20,}", "[REDACTED_GCP_KEY]", s)
sys.stdout.write(s)
')"
    unset raw_out
    fail "gcloud command failed (exit ${exit_code}): ${safe_out}"
  fi
  unset raw_out
}

# Safely load non-secret config defaults from .env if unset in environment (never echoed)
if [[ -z "${GOOGLE_CLOUD_PROJECT+x}" ]]; then
  GOOGLE_CLOUD_PROJECT="$(read_dotenv_var "${DOTENV_FILE}" "GOOGLE_CLOUD_PROJECT")"
fi
if [[ -z "${RENTCAST_GLOBAL_MONTHLY_LIMIT+x}" ]]; then
  RENTCAST_GLOBAL_MONTHLY_LIMIT="$(read_dotenv_var "${DOTENV_FILE}" "RENTCAST_GLOBAL_MONTHLY_LIMIT")"
fi
if [[ -z "${RENTCAST_INITIAL_SPENT_CALLS+x}" ]]; then
  RENTCAST_INITIAL_SPENT_CALLS="$(read_dotenv_var "${DOTENV_FILE}" "RENTCAST_INITIAL_SPENT_CALLS")"
fi
if [[ -z "${GOOGLE_MAPS_BROWSER_KEY+x}" ]]; then
  GOOGLE_MAPS_BROWSER_KEY="$(read_dotenv_var "${DOTENV_FILE}" "GOOGLE_MAPS_BROWSER_KEY")"
fi
if [[ -z "${GEMINI_EXPLAIN_MODEL+x}" ]]; then
  GEMINI_EXPLAIN_MODEL="$(read_dotenv_var "${DOTENV_FILE}" "GEMINI_EXPLAIN_MODEL")"
fi
if [[ -z "${GEMINI_EXPLAIN_FALLBACK_MODEL+x}" ]]; then
  GEMINI_EXPLAIN_FALLBACK_MODEL="$(read_dotenv_var "${DOTENV_FILE}" "GEMINI_EXPLAIN_FALLBACK_MODEL")"
fi
if [[ -z "${GOOGLE_GENAI_USE_VERTEXAI+x}" ]]; then
  GOOGLE_GENAI_USE_VERTEXAI="$(read_dotenv_var "${DOTENV_FILE}" "GOOGLE_GENAI_USE_VERTEXAI")"
fi

GCLOUD_BIN="${GCLOUD_BIN:-$(command -v gcloud 2>/dev/null || echo /opt/homebrew/bin/gcloud)}"
SERVICE_NAME="${CLOUD_RUN_SERVICE_NAME:-foreal-estate}"
CLOUD_RUN_REGION="${CLOUD_RUN_REGION:-us-west1}"
GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:-}"

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
GEMINI_EXPLAIN_MODEL="${GEMINI_EXPLAIN_MODEL:-projects/${GOOGLE_CLOUD_PROJECT}/locations/global/publishers/google/models/gemini-3.8-flash}"
GEMINI_EXPLAIN_FALLBACK_MODEL="${GEMINI_EXPLAIN_FALLBACK_MODEL:-projects/${GOOGLE_CLOUD_PROJECT}/locations/global/publishers/google/models/gemini-3.5-flash}"
GOOGLE_GENAI_USE_VERTEXAI="${GOOGLE_GENAI_USE_VERTEXAI:-true}"
OSM_OVERPASS_URL="${OSM_OVERPASS_URL:-https://overpass-api.de/api/interpreter}"
ENABLE_SYNTHETIC_DEMO_MODE="${ENABLE_SYNTHETIC_DEMO_MODE:-false}"
GOOGLE_MAPS_BROWSER_KEY="${GOOGLE_MAPS_BROWSER_KEY:-}"
MAPS_BROWSER_KEY_DISPLAY_NAME="${MAPS_BROWSER_KEY_DISPLAY_NAME:-foreal-estate-maps-browser}"

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

# Strict fail-closed gate BEFORE any gcloud call
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

# Reject commas in env vars passed to comma-delimited gcloud flags (log variable name only, never key value)
for env_name in \
  GOOGLE_CLOUD_PROJECT \
  CLOUD_RUN_REGION \
  CLOUD_RUN_SERVICE_ACCOUNT \
  GOOGLE_MAPS_BROWSER_KEY \
  OSM_OVERPASS_URL; do
  if [[ "${!env_name}" == *","* ]]; then
    fail "Environment variable '${env_name}' contains a comma, which breaks gcloud --set-env-vars parsing."
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
ENV_VARS_ARG="${ENV_VARS_ARG},GOOGLE_GENAI_USE_VERTEXAI=${GOOGLE_GENAI_USE_VERTEXAI}"
ENV_VARS_ARG="${ENV_VARS_ARG},OSM_OVERPASS_URL=${OSM_OVERPASS_URL}"
ENV_VARS_ARG="${ENV_VARS_ARG},ENABLE_SYNTHETIC_DEMO_MODE=${ENABLE_SYNTHETIC_DEMO_MODE}"

if [[ -n "${GOOGLE_MAPS_BROWSER_KEY}" ]]; then
  ENV_VARS_ARG="${ENV_VARS_ARG},GOOGLE_MAPS_BROWSER_KEY=${GOOGLE_MAPS_BROWSER_KEY}"
fi

echo "[deploy-cloud-run] Deploying '${SERVICE_NAME}' to Cloud Run (${CLOUD_RUN_REGION})..."
"${GCLOUD_BIN}" run deploy "${SERVICE_NAME}" \
  --source="${REPO_ROOT}" \
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

MAPS_BROWSER_KEY_NAME="$("${GCLOUD_BIN}" services api-keys list \
  --project="${GOOGLE_CLOUD_PROJECT}" \
  --filter="displayName=\"${MAPS_BROWSER_KEY_DISPLAY_NAME}\"" \
  --format="value(name)" \
  --limit=1 \
  --quiet 2>/dev/null || echo "")"

if [[ -n "${MAPS_BROWSER_KEY_NAME}" ]]; then
  MAPS_BASE_ALLOWED_REFERRERS="http://localhost:5173/*,http://localhost:8080/*,http://127.0.0.1:5173/*,http://127.0.0.1:8080/*,https://foreal-estate-1059527957241.us-west1.run.app/*"
  NORMALIZED_SERVICE_URL="${SERVICE_URL%/}"
  if [[ ",${MAPS_BASE_ALLOWED_REFERRERS}," == *,"${NORMALIZED_SERVICE_URL}/*",* ]]; then
    MAPS_DEPLOY_ALLOWED_REFERRERS="${MAPS_BASE_ALLOWED_REFERRERS}"
  else
    MAPS_DEPLOY_ALLOWED_REFERRERS="${MAPS_BASE_ALLOWED_REFERRERS},${NORMALIZED_SERVICE_URL}/*"
  fi
  echo "[deploy-cloud-run] Enforcing API & HTTP referrer restrictions on '${MAPS_BROWSER_KEY_DISPLAY_NAME}' for '${NORMALIZED_SERVICE_URL}/*'..."
  run_gcloud_redacted "${GCLOUD_BIN}" services api-keys update "${MAPS_BROWSER_KEY_NAME}" \
    --project="${GOOGLE_CLOUD_PROJECT}" \
    --api-target=service=maps-backend.googleapis.com \
    --allowed-referrers="${MAPS_DEPLOY_ALLOWED_REFERRERS}" \
    --quiet
fi

echo ""
echo "[deploy-cloud-run] Deployment succeeded."
echo "Service URL: ${SERVICE_URL}"
echo ""
echo "Post-deploy smoke test commands (verify HTTP 200 and zero secret leakage):"
echo "  curl -fsS \"${SERVICE_URL}/api/health\""
echo "  curl -fsS \"${SERVICE_URL}/api/config\""
echo "  curl -fsSI \"${SERVICE_URL}/\""
