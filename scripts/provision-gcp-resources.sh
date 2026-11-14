#!/usr/bin/env bash
set -euo pipefail

# ==============================================================================
# Foreal-Estate — Idempotent Google Cloud Provisioning Helper
#
# Zero local ADC requirement: uses active `gcloud` CLI auth (`gcloud auth login`),
# NOT `~/.config/gcloud/application_default_credentials.json`.
#
# Strictly gated behind CONFIRM_GCP_PROVISIONING=true BEFORE any GCP call:
#   1. Verifies GOOGLE_CLOUD_PROJECT (falls back to non-secret .env entry if
#      unset in environment), CLOUD_RUN_REGION (defaults to `us-west1`),
#      CONFIRM_GCP_PROVISIONING=true, active gcloud auth, and linked Cloud Billing.
#   2. Enables required APIs:
#      run.googleapis.com, cloudbuild.googleapis.com,
#      artifactregistry.googleapis.com, secretmanager.googleapis.com,
#      firestore.googleapis.com, maps-backend.googleapis.com,
#      generativelanguage.googleapis.com, apikeys.googleapis.com,
#      billingbudgets.googleapis.com, cloudquotas.googleapis.com
#      (Places API / GOOGLE_PLACES_SERVER_KEY remains disabled unless
#      ENABLE_PLACES_SERVER_SECRET=true).
#   3. Creates least-privilege runtime SA:
#      foreal-estate-runtime@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com
#      and grants `roles/datastore.user`.
#   4. Creates (default) Firestore Native database if absent.
#   5. Optional flag-gated helpers (ONLY after CONFIRM_GCP_PROVISIONING=true):
#      - Cloud Billing budget when BOTH BILLING_ACCOUNT_ID and APPROVED_SPEND_USD
#        are explicitly provided (never defaulted!), supporting either
#        BUDGET_CALENDAR_PERIOD or BUDGET_START_DATE / BUDGET_END_DATE.
#      - GCP API key provisioning when AUTO_CREATE_GCP_API_KEYS=true for empty
#        GEMINI_API_KEY (`foreal-estate-gemini-server`) and/or empty
#        GOOGLE_MAPS_BROWSER_KEY (`foreal-estate-maps-browser`) in `.env`
#        strictly in memory (`chmod 600`, zero stdout/stderr key leakage).
#   6. Creates Secret Manager secrets `foreal-rentcast-api-key` and
#      `foreal-gemini-api-key` (plus `foreal-google-places-server-key` ONLY when
#      ENABLE_PLACES_SERVER_SECRET=true), grants per-secret
#      `roles/secretmanager.secretAccessor`, safely syncs non-empty `.env`
#      secrets via `--data-file=-` (when SYNC_SECRETS_FROM_DOTENV=true or no
#      ENABLED numeric version exists yet), and verifies ENABLED numeric versions.
# ==============================================================================

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DOTENV_FILE="${DOTENV_FILE:-${REPO_ROOT}/.env}"

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

# Atomically updates a single key in .env from stdin, preserving existing lines and chmod 600.
upsert_dotenv_var_stdin() {
  local dotenv_path="$1"
  local target_key="$2"
  DOTENV_TARGET_PATH="${dotenv_path}" DOTENV_TARGET_KEY="${target_key}" python3 -c '
import os, sys, tempfile

path = os.environ["DOTENV_TARGET_PATH"]
key = os.environ["DOTENV_TARGET_KEY"]
value = sys.stdin.read()
if "\n" in value or "\r" in value:
    raise SystemExit("Refusing to write multiline value to .env")

lines = []
if os.path.exists(path):
    with open(path, "r", encoding="utf-8") as f:
        lines = f.read().splitlines(keepends=True)

updated = False
out_lines = []
for line in lines:
    stripped = line.lstrip()
    if not stripped.startswith("#") and "=" in stripped:
        lhs = stripped.split("=", 1)[0].strip()
        if lhs.startswith("export "):
            lhs = lhs[len("export "):].strip()
        if lhs == key:
            ending = "\r\n" if line.endswith("\r\n") else "\n"
            out_lines.append(f"{key}={value}{ending}")
            updated = True
            continue
    out_lines.append(line)

if not updated:
    if out_lines and not out_lines[-1].endswith(("\n", "\r\n")):
        out_lines[-1] += "\n"
    out_lines.append(f"{key}={value}\n")

parent = os.path.dirname(os.path.abspath(path)) or "."
fd, tmp_path = tempfile.mkstemp(prefix=".env.tmp.", dir=parent)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as wf:
        wf.writelines(out_lines)
    os.replace(tmp_path, path)
    os.chmod(path, 0o600)
except Exception:
    if os.path.exists(tmp_path):
        os.unlink(tmp_path)
    raise
'
}

# Runs a gcloud command while suppressing LRO status payloads (e.g. api-keys create keyString)
# and scrubbing any key material from error output if the command fails.
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

if [[ -z "${GOOGLE_CLOUD_PROJECT+x}" ]]; then
  GOOGLE_CLOUD_PROJECT="$(read_dotenv_var "${DOTENV_FILE}" "GOOGLE_CLOUD_PROJECT")"
fi
GOOGLE_CLOUD_PROJECT="${GOOGLE_CLOUD_PROJECT:-}"

GCLOUD_BIN="${GCLOUD_BIN:-$(command -v gcloud 2>/dev/null || echo /opt/homebrew/bin/gcloud)}"
CLOUD_RUN_REGION="${CLOUD_RUN_REGION:-us-west1}"
SA_NAME="${CLOUD_RUN_SA_NAME:-foreal-estate-runtime}"
RENTCAST_SECRET_NAME="${RENTCAST_SECRET_NAME:-foreal-rentcast-api-key}"
GEMINI_SECRET_NAME="${GEMINI_SECRET_NAME:-foreal-gemini-api-key}"
GOOGLE_PLACES_SECRET_NAME="${GOOGLE_PLACES_SECRET_NAME:-foreal-google-places-server-key}"
ENABLE_PLACES_SERVER_SECRET="${ENABLE_PLACES_SERVER_SECRET:-false}"
SYNC_SECRETS_FROM_DOTENV="${SYNC_SECRETS_FROM_DOTENV:-false}"
AUTO_CREATE_GCP_API_KEYS="${AUTO_CREATE_GCP_API_KEYS:-false}"
FIRESTORE_LOCATION="${FIRESTORE_LOCATION:-}"

GEMINI_SERVER_KEY_DISPLAY_NAME="${GEMINI_SERVER_KEY_DISPLAY_NAME:-foreal-estate-gemini-server}"
MAPS_BROWSER_KEY_DISPLAY_NAME="${MAPS_BROWSER_KEY_DISPLAY_NAME:-foreal-estate-maps-browser}"
MAPS_INITIAL_ALLOWED_REFERRERS="http://localhost:5173/*,http://localhost:8080/*,http://127.0.0.1:5173/*,http://127.0.0.1:8080/*,https://foreal-estate-1059527957241.us-west1.run.app/*"

# Budget settings: NEVER invent a default spending amount!
BILLING_ACCOUNT_ID="${BILLING_ACCOUNT_ID:-}"
APPROVED_SPEND_USD="${APPROVED_SPEND_USD:-}"
BUDGET_CALENDAR_PERIOD="${BUDGET_CALENDAR_PERIOD:-}"
BUDGET_START_DATE="${BUDGET_START_DATE:-}"
BUDGET_END_DATE="${BUDGET_END_DATE:-}"

echo "[provision-gcp] Running preflight checks (region=${CLOUD_RUN_REGION})..."

if [[ ! -x "${GCLOUD_BIN}" ]]; then
  fail "'gcloud' CLI was not found or is not executable (${GCLOUD_BIN})."
fi

require_env "GOOGLE_CLOUD_PROJECT"
require_env "CLOUD_RUN_REGION"

if [[ -z "${FIRESTORE_LOCATION}" ]]; then
  FIRESTORE_LOCATION="${CLOUD_RUN_REGION}"
fi

BUDGET_DISPLAY_NAME="${BUDGET_DISPLAY_NAME:-foreal-estate-${GOOGLE_CLOUD_PROJECT}}"

# Validate optional Cloud Billing budget inputs prior to any GCP calls
if [[ -n "${BILLING_ACCOUNT_ID}" || -n "${APPROVED_SPEND_USD}" ]]; then
  if [[ -z "${BILLING_ACCOUNT_ID}" || -z "${APPROVED_SPEND_USD}" ]]; then
    fail "Both BILLING_ACCOUNT_ID and APPROVED_SPEND_USD must be explicitly provided together to configure a Cloud Billing budget (never defaulted)."
  fi
  APPROVED_SPEND_USD="${APPROVED_SPEND_USD#\$}"
  APPROVED_SPEND_USD="${APPROVED_SPEND_USD%USD}"
  APPROVED_SPEND_USD="${APPROVED_SPEND_USD%usd}"
  if ! [[ "${APPROVED_SPEND_USD}" =~ ^[0-9]+([.][0-9]+)?$ ]] || ! awk "BEGIN { exit !(${APPROVED_SPEND_USD} > 0) }"; then
    fail "APPROVED_SPEND_USD must be an explicit positive USD number (e.g. '10' or '25'). Got: '${APPROVED_SPEND_USD}'."
  fi
  if [[ -n "${BUDGET_CALENDAR_PERIOD}" && ( -n "${BUDGET_START_DATE}" || -n "${BUDGET_END_DATE}" ) ]]; then
    fail "Specify either BUDGET_CALENDAR_PERIOD or BUDGET_START_DATE/BUDGET_END_DATE, not both."
  fi
  if [[ -n "${BUDGET_END_DATE}" && -z "${BUDGET_START_DATE}" ]]; then
    fail "BUDGET_START_DATE is required when BUDGET_END_DATE is specified."
  fi
  if [[ -n "${BUDGET_CALENDAR_PERIOD}" ]] && ! [[ "${BUDGET_CALENDAR_PERIOD}" =~ ^(month|quarter|year)$ ]]; then
    fail "BUDGET_CALENDAR_PERIOD must be one of: month, quarter, year. Got: '${BUDGET_CALENDAR_PERIOD}'."
  fi
  if [[ -n "${BUDGET_START_DATE}" ]] && ! [[ "${BUDGET_START_DATE}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    fail "BUDGET_START_DATE must use YYYY-MM-DD format. Got: '${BUDGET_START_DATE}'."
  fi
  if [[ -n "${BUDGET_END_DATE}" ]] && ! [[ "${BUDGET_END_DATE}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
    fail "BUDGET_END_DATE must use YYYY-MM-DD format. Got: '${BUDGET_END_DATE}'."
  fi
fi

# Strict fail-closed gate BEFORE any gcloud call
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

REQUIRED_APIS=(
  run.googleapis.com
  cloudbuild.googleapis.com
  artifactregistry.googleapis.com
  secretmanager.googleapis.com
  firestore.googleapis.com
  maps-backend.googleapis.com
  generativelanguage.googleapis.com
  aiplatform.googleapis.com
  apikeys.googleapis.com
  billingbudgets.googleapis.com
  cloudquotas.googleapis.com
)

if [[ "${ENABLE_PLACES_SERVER_SECRET}" == "true" ]]; then
  REQUIRED_APIS+=(places.googleapis.com)
fi

echo "[provision-gcp] Enabling required APIs on '${GOOGLE_CLOUD_PROJECT}'..."
"${GCLOUD_BIN}" services enable \
  "${REQUIRED_APIS[@]}" \
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

echo "[provision-gcp] Granting roles/datastore.user and roles/aiplatform.user to '${RUNTIME_SA_EMAIL}'..."
"${GCLOUD_BIN}" projects add-iam-policy-binding "${GOOGLE_CLOUD_PROJECT}" \
  --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
  --role="roles/datastore.user" \
  --quiet >/dev/null
"${GCLOUD_BIN}" projects add-iam-policy-binding "${GOOGLE_CLOUD_PROJECT}" \
  --member="serviceAccount:${RUNTIME_SA_EMAIL}" \
  --role="roles/aiplatform.user" \
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

ensure_project_billing_budget() {
  local -a period_flags=()
  if [[ -n "${BUDGET_CALENDAR_PERIOD}" ]]; then
    period_flags+=("--calendar-period=${BUDGET_CALENDAR_PERIOD}")
  elif [[ -n "${BUDGET_START_DATE}" ]]; then
    period_flags+=("--start-date=${BUDGET_START_DATE}")
    if [[ -n "${BUDGET_END_DATE}" ]]; then
      period_flags+=("--end-date=${BUDGET_END_DATE}")
    fi
  fi

  local budget_filter="displayName=\"${BUDGET_DISPLAY_NAME}\""

  local existing_budget_name=""
  existing_budget_name="$("${GCLOUD_BIN}" billing budgets list \
    --billing-account="${BILLING_ACCOUNT_ID}" \
    --billing-project="${GOOGLE_CLOUD_PROJECT}" \
    --filter="${budget_filter}" \
    --format="value(name)" \
    --limit=1 \
    --quiet 2>/dev/null || echo "")"

  if [[ -z "${existing_budget_name}" ]]; then
    echo "[provision-gcp] Creating project-filtered Cloud Billing budget '${BUDGET_DISPLAY_NAME}' (${APPROVED_SPEND_USD}USD)..."
    "${GCLOUD_BIN}" billing budgets create \
      --billing-account="${BILLING_ACCOUNT_ID}" \
      --billing-project="${GOOGLE_CLOUD_PROJECT}" \
      --display-name="${BUDGET_DISPLAY_NAME}" \
      --filter-projects="projects/${GOOGLE_CLOUD_PROJECT}" \
      --budget-amount="${APPROVED_SPEND_USD}USD" \
      --threshold-rule=percent=0.5 \
      --threshold-rule=percent=0.8 \
      --threshold-rule=percent=1.0 \
      ${period_flags[@]+"${period_flags[@]}"} \
      --quiet >/dev/null
    echo "[provision-gcp] Created Cloud Billing budget '${BUDGET_DISPLAY_NAME}' (${APPROVED_SPEND_USD}USD; thresholds 50%, 80%, 100%)."
  else
    echo "[provision-gcp] Updating existing project-filtered Cloud Billing budget '${existing_budget_name}' (${APPROVED_SPEND_USD}USD)..."
    "${GCLOUD_BIN}" billing budgets update "${existing_budget_name}" \
      --billing-account="${BILLING_ACCOUNT_ID}" \
      --billing-project="${GOOGLE_CLOUD_PROJECT}" \
      --display-name="${BUDGET_DISPLAY_NAME}" \
      --filter-projects="projects/${GOOGLE_CLOUD_PROJECT}" \
      --budget-amount="${APPROVED_SPEND_USD}USD" \
      --clear-threshold-rules \
      --add-threshold-rule=percent=0.5 \
      --add-threshold-rule=percent=0.8 \
      --add-threshold-rule=percent=1.0 \
      ${period_flags[@]+"${period_flags[@]}"} \
      --quiet >/dev/null
    echo "[provision-gcp] Updated Cloud Billing budget '${existing_budget_name}' (${APPROVED_SPEND_USD}USD; thresholds 50%, 80%, 100%)."
  fi
}

if [[ -n "${BILLING_ACCOUNT_ID}" && -n "${APPROVED_SPEND_USD}" ]]; then
  ensure_project_billing_budget
else
  echo "[provision-gcp] Skipping Cloud Billing budget setup (provide both BILLING_ACCOUNT_ID and APPROVED_SPEND_USD to configure)."
fi

ensure_secret_resource_and_iam() {
  local secret_name="$1"
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
}

get_latest_enabled_numeric_secret_version() {
  local secret_name="$1"
  local raw_ver verified_ver
  raw_ver="$("${GCLOUD_BIN}" secrets versions list "${secret_name}" \
    --project="${GOOGLE_CLOUD_PROJECT}" \
    --filter='state=ENABLED' \
    --sort-by='~createTime' \
    --limit=1 \
    --format='value(name)' \
    --quiet 2>/dev/null || echo "")"
  verified_ver="${raw_ver##*/}"
  if [[ "${verified_ver}" =~ ^[0-9]+$ ]]; then
    printf '%s' "${verified_ver}"
  fi
}

GEMINI_SECRET_POPULATED_BY_KEYGEN="false"

auto_provision_gcp_api_keys() {
  echo "[provision-gcp] Checking optional GCP API key provisioning (AUTO_CREATE_GCP_API_KEYS=true)..."

  local existing_dotenv_gemini=""
  existing_dotenv_gemini="$(read_dotenv_var "${DOTENV_FILE}" "GEMINI_API_KEY")"
  if [[ -z "${existing_dotenv_gemini}" ]]; then
    local gemini_key_name=""
    gemini_key_name="$("${GCLOUD_BIN}" services api-keys list \
      --project="${GOOGLE_CLOUD_PROJECT}" \
      --filter="displayName=\"${GEMINI_SERVER_KEY_DISPLAY_NAME}\"" \
      --format="value(name)" \
      --limit=1 \
      --quiet 2>/dev/null || echo "")"

    if [[ -z "${gemini_key_name}" ]]; then
      echo "[provision-gcp] Creating restricted Gemini server API key '${GEMINI_SERVER_KEY_DISPLAY_NAME}'..."
      run_gcloud_redacted "${GCLOUD_BIN}" services api-keys create \
        --project="${GOOGLE_CLOUD_PROJECT}" \
        --display-name="${GEMINI_SERVER_KEY_DISPLAY_NAME}" \
        --api-target=service=generativelanguage.googleapis.com \
        --quiet
      gemini_key_name="$("${GCLOUD_BIN}" services api-keys list \
        --project="${GOOGLE_CLOUD_PROJECT}" \
        --filter="displayName=\"${GEMINI_SERVER_KEY_DISPLAY_NAME}\"" \
        --format="value(name)" \
        --limit=1 \
        --quiet)"
    else
      echo "[provision-gcp] Reusing existing Gemini server API key '${GEMINI_SERVER_KEY_DISPLAY_NAME}' and enforcing API target restriction..."
      run_gcloud_redacted "${GCLOUD_BIN}" services api-keys update "${gemini_key_name}" \
        --project="${GOOGLE_CLOUD_PROJECT}" \
        --api-target=service=generativelanguage.googleapis.com \
        --quiet
    fi

    if [[ -z "${gemini_key_name}" ]]; then
      fail "Failed to resolve API key resource name for '${GEMINI_SERVER_KEY_DISPLAY_NAME}'."
    fi

    local gemini_key_val=""
    gemini_key_val="$("${GCLOUD_BIN}" services api-keys get-key-string "${gemini_key_name}" \
      --project="${GOOGLE_CLOUD_PROJECT}" \
      --format="value(keyString)" \
      --quiet 2>/dev/null || echo "")"
    if [[ -z "${gemini_key_val}" ]]; then
      fail "Failed to retrieve key string in memory for '${GEMINI_SERVER_KEY_DISPLAY_NAME}'."
    fi

    printf '%s' "${gemini_key_val}" | upsert_dotenv_var_stdin "${DOTENV_FILE}" "GEMINI_API_KEY"
    ensure_secret_resource_and_iam "${GEMINI_SECRET_NAME}"
    printf '%s' "${gemini_key_val}" | "${GCLOUD_BIN}" secrets versions add "${GEMINI_SECRET_NAME}" \
      --project="${GOOGLE_CLOUD_PROJECT}" \
      --data-file=- \
      --quiet >/dev/null
    unset gemini_key_val
    GEMINI_SECRET_POPULATED_BY_KEYGEN="true"
    echo "[provision-gcp] Stored '${GEMINI_SERVER_KEY_DISPLAY_NAME}' key in .env (chmod 600) and Secret Manager '${GEMINI_SECRET_NAME}'."
  else
    unset existing_dotenv_gemini
    echo "[provision-gcp] GEMINI_API_KEY is already non-empty in .env; skipping '${GEMINI_SERVER_KEY_DISPLAY_NAME}' key provisioning."
  fi

  local existing_dotenv_maps=""
  existing_dotenv_maps="$(read_dotenv_var "${DOTENV_FILE}" "GOOGLE_MAPS_BROWSER_KEY")"
  if [[ -z "${existing_dotenv_maps}" ]]; then
    local maps_key_name=""
    maps_key_name="$("${GCLOUD_BIN}" services api-keys list \
      --project="${GOOGLE_CLOUD_PROJECT}" \
      --filter="displayName=\"${MAPS_BROWSER_KEY_DISPLAY_NAME}\"" \
      --format="value(name)" \
      --limit=1 \
      --quiet 2>/dev/null || echo "")"

    if [[ -z "${maps_key_name}" ]]; then
      echo "[provision-gcp] Creating referrer-restricted Maps browser API key '${MAPS_BROWSER_KEY_DISPLAY_NAME}'..."
      run_gcloud_redacted "${GCLOUD_BIN}" services api-keys create \
        --project="${GOOGLE_CLOUD_PROJECT}" \
        --display-name="${MAPS_BROWSER_KEY_DISPLAY_NAME}" \
        --api-target=service=maps-backend.googleapis.com \
        --allowed-referrers="${MAPS_INITIAL_ALLOWED_REFERRERS}" \
        --quiet
      maps_key_name="$("${GCLOUD_BIN}" services api-keys list \
        --project="${GOOGLE_CLOUD_PROJECT}" \
        --filter="displayName=\"${MAPS_BROWSER_KEY_DISPLAY_NAME}\"" \
        --format="value(name)" \
        --limit=1 \
        --quiet)"
    else
      echo "[provision-gcp] Reusing existing Maps browser API key '${MAPS_BROWSER_KEY_DISPLAY_NAME}' and enforcing API/referrer restrictions..."
      run_gcloud_redacted "${GCLOUD_BIN}" services api-keys update "${maps_key_name}" \
        --project="${GOOGLE_CLOUD_PROJECT}" \
        --api-target=service=maps-backend.googleapis.com \
        --allowed-referrers="${MAPS_INITIAL_ALLOWED_REFERRERS}" \
        --quiet
    fi

    if [[ -z "${maps_key_name}" ]]; then
      fail "Failed to resolve API key resource name for '${MAPS_BROWSER_KEY_DISPLAY_NAME}'."
    fi

    local maps_key_val=""
    maps_key_val="$("${GCLOUD_BIN}" services api-keys get-key-string "${maps_key_name}" \
      --project="${GOOGLE_CLOUD_PROJECT}" \
      --format="value(keyString)" \
      --quiet 2>/dev/null || echo "")"
    if [[ -z "${maps_key_val}" ]]; then
      fail "Failed to retrieve key string in memory for '${MAPS_BROWSER_KEY_DISPLAY_NAME}'."
    fi

    printf '%s' "${maps_key_val}" | upsert_dotenv_var_stdin "${DOTENV_FILE}" "GOOGLE_MAPS_BROWSER_KEY"
    unset maps_key_val
    echo "[provision-gcp] Stored '${MAPS_BROWSER_KEY_DISPLAY_NAME}' key in .env (chmod 600)."
  else
    unset existing_dotenv_maps
    echo "[provision-gcp] GOOGLE_MAPS_BROWSER_KEY is already non-empty in .env; skipping '${MAPS_BROWSER_KEY_DISPLAY_NAME}' key provisioning."
  fi
}

if [[ "${AUTO_CREATE_GCP_API_KEYS}" == "true" ]]; then
  auto_provision_gcp_api_keys
fi

ensure_secret_and_bind() {
  local secret_name="$1"
  local dotenv_var_name="$2"
  local already_populated="${3:-false}"

  ensure_secret_resource_and_iam "${secret_name}"

  local current_ver=""
  current_ver="$(get_latest_enabled_numeric_secret_version "${secret_name}")"

  if [[ "${already_populated}" == "true" ]]; then
    echo "[provision-gcp] Secret '${secret_name}' already populated during API key provisioning."
  else
    local dotenv_secret_val=""
    dotenv_secret_val="$(read_dotenv_var "${DOTENV_FILE}" "${dotenv_var_name}")"

    if [[ -n "${dotenv_secret_val}" ]]; then
      if [[ "${SYNC_SECRETS_FROM_DOTENV}" == "true" || -z "${current_ver}" ]]; then
        printf '%s' "${dotenv_secret_val}" | "${GCLOUD_BIN}" secrets versions add "${secret_name}" \
          --project="${GOOGLE_CLOUD_PROJECT}" \
          --data-file=- \
          --quiet >/dev/null
        unset dotenv_secret_val
        echo "[provision-gcp] Synced non-empty '${dotenv_var_name}' from .env into '${secret_name}'."
      else
        unset dotenv_secret_val
        echo "[provision-gcp] Keeping existing ENABLED version (${current_ver}) for '${secret_name}' (set SYNC_SECRETS_FROM_DOTENV=true to sync updated .env value)."
      fi
    elif [[ -t 0 ]]; then
      local secret_val=""
      printf "[provision-gcp] Enter %s value (hidden; leave blank to keep existing ENABLED version): " "${dotenv_var_name}"
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
      echo "[provision-gcp] Non-interactive shell and '${dotenv_var_name}' is empty in .env: populate .env and re-run with SYNC_SECRETS_FROM_DOTENV=true, or pipe via 'read -r -s val && printf \"%s\" \"\$val\" | ${GCLOUD_BIN} secrets versions add ${secret_name} --project=${GOOGLE_CLOUD_PROJECT} --data-file=-'."
    fi
  fi

  local verified_ver=""
  verified_ver="$(get_latest_enabled_numeric_secret_version "${secret_name}")"
  if [[ "${verified_ver}" =~ ^[0-9]+$ ]]; then
    echo "[provision-gcp] Verified ENABLED version for '${secret_name}': ${verified_ver}"
  else
    echo "[provision-gcp] WARNING: No ENABLED numeric version found yet for '${secret_name}'."
  fi
}

ensure_secret_and_bind "${RENTCAST_SECRET_NAME}" "RENTCAST_API_KEY" "false"
ensure_secret_and_bind "${GEMINI_SECRET_NAME}" "GEMINI_API_KEY" "${GEMINI_SECRET_POPULATED_BY_KEYGEN}"

if [[ "${ENABLE_PLACES_SERVER_SECRET}" == "true" ]]; then
  ensure_secret_and_bind "${GOOGLE_PLACES_SECRET_NAME}" "GOOGLE_PLACES_SERVER_KEY" "false"
fi

echo ""
echo "[provision-gcp] Provisioning complete."
echo "Runtime Service Account: ${RUNTIME_SA_EMAIL}"
echo "Next step: export CLOUD_RUN_REGION='${CLOUD_RUN_REGION}' CLOUD_RUN_SERVICE_ACCOUNT='${RUNTIME_SA_EMAIL}' CONFIRM_BILLING_AND_SPENDING_LIMITS=true && ./scripts/deploy-cloud-run.sh"
