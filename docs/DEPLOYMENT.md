# Deployment & Operations Guide (`DEPLOYMENT.md`)

**Owner:** `release` (Workstream 6)  
**Target Platform:** Google Cloud Run (`0.0.0.0:$PORT`, default `8080`)  
**Deployment Status:** **`BLOCKED / NOT DEPLOYED`** *(See [Current Deployment Blockers](#7-current-deployment-blockers))*

---

## 1. Container Build & Local Production Verification

Foreal-Estate runs as a single Node.js `v24` (`>= 22.5.0`, verified locally on `v24.7.0` / `npm 11.7.0`) HTTP service serving both the `/api/*` Express backend and the Vite-built React SPA (`dist/client`).

### 1.1 Container Architecture (`Dockerfile` & `.dockerignore`)
- [`Dockerfile`](../Dockerfile) uses a two-stage `node:24-slim` build:
  1. **Builder stage:** Installs dependencies with `npm ci`, executes `npm run build` (`vite build` -> `dist/client` and `vite build --ssr src/server/index.ts --outDir dist/server`), and runs `npm prune --omit=dev`.
  2. **Runtime stage:** Sets `NODE_ENV=production` and `PORT=8080`, copies `package.json`, pruned `node_modules/`, and `dist/`, ensures `.data/` is owned by non-root `node`, switches to `USER node`, exposes port `8080`, and launches `node dist/server/index.js` bound to `0.0.0.0:$PORT`.
- [`.dockerignore`](../.dockerignore) and [`.gcloudignore`](../.gcloudignore) exclude `.git/`, `node_modules/`, `dist/`, `build/`, `.env`, `.env.*`, `.data/`, `*.sqlite*`, `*.db`, `tests/`, `coverage/`, `logs/`, and OS/editor artifacts so secrets and test fixtures are never uploaded to Cloud Build or baked into the container image.
- Provenance, swarm execution metadata, and Stage 3 verification results are recorded in [`docs/BUILD_PROVENANCE.md`](BUILD_PROVENANCE.md).

### 1.2 Local Build & Run Verification
Verify the exact production bundle locally before any cloud deployment:

```bash
cp .env.example .env   # Populate only keys you intend to test locally; never commit .env
npm install
npm run typecheck
npm test
npm run build
NODE_ENV=production PORT=8080 BUDGET_STORE_MODE=sqlite npm start
```

Verify local readiness endpoints (both return HTTP `200` even when optional API keys are unconfigured):

```bash
curl -fsS http://127.0.0.1:8080/api/health
curl -fsS http://127.0.0.1:8080/api/config
```

Confirm that `GET /api/config` and `dist/client/` contain **no** server secret values (`RENTCAST_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_PLACES_SERVER_KEY`).

---

## 2. Secret Isolation & Google Cloud Secret Manager Setup

Foreal-Estate strictly separates **confidential server secrets** from **public configuration** and the **restricted browser Maps key** (see [`docs/ARCHITECTURE.md`](ARCHITECTURE.md)):

| Variable | Classification | Cloud Run Injection | Restrictions & Isolation |
|---|---|---|---|
| `RENTCAST_API_KEY` | **Server-only secret** | `--set-secrets` (`foreal-rentcast-api-key:<VER>`) | Used only in server `X-Api-Key` header. Never in `/api/config`, client bundle, logs, or URLs. Verified `ENABLED` numeric version resolved dynamically (never assumed `1` or `latest`). |
| `GEMINI_API_KEY` | **Server-only secret** | `--set-secrets` (`foreal-gemini-api-key:<VER>`) | Used only by `@google/genai` on the server for `/api/explain`. Verified `ENABLED` numeric version resolved dynamically. |
| `GOOGLE_PLACES_SERVER_KEY` *(optional)* | **Server-only secret** | `--set-secrets` (`foreal-google-places-server-key:<VER>`) *(only when `ENABLE_PLACES_SERVER_SECRET=true`)* | Optional display-only Places context (`google_places_context`, barred from scoring). Never exposed to browser. |
| `GOOGLE_MAPS_BROWSER_KEY` | **Restricted browser key** | `--set-env-vars` | Intentionally returned via `GET /api/config` (`mapsBrowserKey`). **Must** be restricted in Google Cloud Console by **HTTP referrer** (`https://<service-url>/*`, `http://localhost:5173/*`, `http://localhost:8080/*`) and **API scope** (**Maps JavaScript API only**). |

> [!NOTE]
> **Zero Local ADC Requirement:** Neither [`scripts/provision-gcp-resources.sh`](../scripts/provision-gcp-resources.sh) nor [`scripts/deploy-cloud-run.sh`](../scripts/deploy-cloud-run.sh) requires `~/.config/gcloud/application_default_credentials.json` (`gcloud auth application-default login`). Both use active `gcloud` CLI authentication (`gcloud auth login`), and Cloud Run authenticates to Firestore at runtime via its attached service account metadata token. If an operator inspects Firestore `rentcast_budget/${YYYY-MM}` from the CLI, pass a transient in-memory token from `/opt/homebrew/bin/gcloud auth print-access-token` (never echoed or written to disk).

### Create Secret Manager Entries & Provision GCP Resources (`scripts/provision-gcp-resources.sh`)
Once a billing-linked GCP project is confirmed, run [`scripts/provision-gcp-resources.sh`](../scripts/provision-gcp-resources.sh) (defaults to `CLOUD_RUN_REGION=us-west1`; idempotent; enables only required APIs, creates the least-privilege runtime SA `foreal-estate-runtime@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com` with `roles/datastore.user` and per-secret `roles/secretmanager.secretAccessor` only on individual Foreal secrets, creates `(default)` Firestore Native DB if absent, prompts securely via `read -r -s` + `--data-file=-` without shell history, and verifies the resulting `ENABLED` numeric secret version):

```bash
export GOOGLE_CLOUD_PROJECT="<your-gcp-project-id>"
export CLOUD_RUN_REGION="us-west1"
export CONFIRM_GCP_PROVISIONING=true
# Optional: export ENABLE_PLACES_SERVER_SECRET=true

./scripts/provision-gcp-resources.sh
```

Or verify existing `ENABLED` numeric secret versions directly (never reading secret payloads):

```bash
gcloud secrets versions list foreal-rentcast-api-key \
  --project="$GOOGLE_CLOUD_PROJECT" \
  --filter='state=ENABLED' --sort-by='~createTime' --limit=1 --format='value(name)'
```

---

## 3. Firestore Durable Atomic Budget Setup

In multi-instance Cloud Run environments, local disk SQLite is ephemeral per container revision. Production deployments **must** set:

- `BUDGET_STORE_MODE=firestore`
- `GOOGLE_CLOUD_PROJECT=<your-gcp-project-id>`
- `FIRESTORE_BUDGET_COLLECTION=rentcast_budget`

### Provisioning Steps
1. Ensure a Cloud Firestore `(default)` database exists in Native mode in `$GOOGLE_CLOUD_PROJECT`.
2. Grant `CLOUD_RUN_SERVICE_ACCOUNT` `roles/datastore.user` so the server can execute optimistic transactional commits against `projects/{GOOGLE_CLOUD_PROJECT}/databases/(default)/documents/rentcast_budget/{YYYY_MM}` using Cloud Run's attached metadata token:

```bash
gcloud projects add-iam-policy-binding "$GOOGLE_CLOUD_PROJECT" \
  --member="serviceAccount:${CLOUD_RUN_SERVICE_ACCOUNT}" \
  --role="roles/datastore.user"
```

3. **Fail-Closed Guarantee & External Key Usage Reconciliation:**
   - When `BUDGET_STORE_MODE=firestore`, if Firestore is unreachable or permissions are missing, the server refuses to dispatch upstream RentCast requests (`BUDGET_STORE_UNAVAILABLE`, HTTP `503`) rather than risking untracked calls.
   - **Important Limitation:** Firestore's `rentcast_budget/${YYYY-MM}` counter only tracks calls dispatched by this application and **cannot automatically observe unrelated external scripts or apps sharing the same RentCast account key**. Reconcile against the RentCast dashboard (`https://app.rentcast.io/app/api`) and set `RENTCAST_INITIAL_SPENT_CALLS` accordingly before deploying.
   - **Transient CLI Inspection (Zero ADC Needed):** To inspect the current Firestore counter without local ADC, pass `/opt/homebrew/bin/gcloud auth print-access-token` transiently in memory (`Authorization: Bearer ...`, never echoed or saved to disk).

---

## 4. Hard Spending, Session & Quota Controls

> [!WARNING]
> **Explicit Platform Limitations (Do Not Misread as Hard Guarantees):**
> - **GCP Billing Budget Alerts Are NOT Hard Spending Caps:** Google Cloud Billing budgets and email/PubSub alerts are **notifications only** — they do **not** automatically disable Cloud Run billing or stop upstream API charges.
> - **`--session-affinity` Is Best-Effort Only:** Cloud Run session affinity is best-effort and does not persist across scale-to-zero cold starts, container restarts, or revision rollouts. Durable `PropertySessionStore` persistence (`firestore` / `sqlite`) and explicit `409 SESSION_EXPIRED` recovery (zero silent re-fetches) handle session continuity.
> - **`--max-instances=1` Is Not a Persistence Guarantee or Monthly Dollar Cap:** Limiting instances to `1` reduces split-brain and horizontal concurrency, but does not preserve in-memory state across restarts or enforce a monthly GCP spend ceiling on its own.

Foreal-Estate combines four technical controls to prevent runaway spend:

1. **Cloud Run Scaling & Best-Effort Affinity Ceilings (`AUDIT-CR-03`):**
   - `--min-instances=0` (scales to zero when idle)
   - `--max-instances=1` (prevents horizontal fan-out; not a persistence guarantee or hard billing cap)
   - `--session-affinity` (best-effort routing affinity; backed by durable Firestore session storage)
   - `--concurrency=20` (bounded per-container request fan-in)
   - `--timeout=30` (30-second execution ceiling prevents hung request billing)
2. **Application-Level Atomic RentCast Ceiling (`< 50` Free Tier):**
   - `RENTCAST_GLOBAL_MONTHLY_LIMIT=35` (clamped by `src/server/config.ts` to `1..49`)
   - `RENTCAST_INITIAL_SPENT_CALLS=<prior_calls>` subtracts any calls already spent on the RentCast account before deployment
   - Per-session caps (`1` listing search + `5` AVMs default; `10` AVMs + `1` optional property record if user explicitly calls `/api/sessions/:sessionId/expand`)
   - Zero RentCast calls on map pan/zoom or keystroke typing
3. **Google Cloud API Quotas:**
   - Configure hard daily/per-minute request quotas for the Gemini API and Maps JavaScript API in Google Cloud Console (`APIs & Services -> Quotas`).
4. **Upstream Timeouts & Degraded Resilience:**
   - Geocoding (`6,000 ms`), Overpass/EPA (`10,000 ms`), RentCast (`8,000 ms`), and Gemini (`10,000 ms`) use `AbortSignal.timeout`. If Gemini quota or timeout triggers, `/api/explain` degrades cleanly (`explanationAvailable: false`) without breaking deterministic scoring or price comparisons.

---

## 5. Cloud Run Deployment (`scripts/deploy-cloud-run.sh`)

[`scripts/deploy-cloud-run.sh`](../scripts/deploy-cloud-run.sh) defaults `CLOUD_RUN_REGION=us-west1` and implements strict preflight checks requiring `GOOGLE_CLOUD_PROJECT`, `CLOUD_RUN_SERVICE_ACCOUNT`, `CONFIRM_BILLING_AND_SPENDING_LIMITS=true`, valid `RENTCAST_GLOBAL_MONTHLY_LIMIT` (`1..49`), active `gcloud auth` (zero local ADC required), and **verified `ENABLED` numeric Secret Manager versions** (resolved via `gcloud secrets versions list --filter="state=ENABLED"` or verified `RENTCAST_SECRET_VERSION` / `GEMINI_SECRET_VERSION`, never assuming `1` or `latest`) before running `gcloud run deploy`.

### Scripted Deployment
```bash
export GOOGLE_CLOUD_PROJECT="<your-gcp-project-id>"
export CLOUD_RUN_REGION="us-west1"
export CLOUD_RUN_SERVICE_ACCOUNT="foreal-estate-runtime@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com"
export CONFIRM_BILLING_AND_SPENDING_LIMITS=true
export GOOGLE_MAPS_BROWSER_KEY="<http-referrer-restricted-maps-browser-key>"   # optional
# Optional: export ENABLE_PLACES_SERVER_SECRET=true

./scripts/deploy-cloud-run.sh
```

### Equivalent Explicit `gcloud run deploy` Command
*(Replace `<RENTCAST_VER>` and `<GEMINI_VER>` with the verified `ENABLED` numeric version IDs returned by `gcloud secrets versions list` — never assume `1` or `latest`.)*

```bash
gcloud run deploy foreal-estate \
  --source=. \
  --project="$GOOGLE_CLOUD_PROJECT" \
  --region="${CLOUD_RUN_REGION:-us-west1}" \
  --port=8080 \
  --service-account="$CLOUD_RUN_SERVICE_ACCOUNT" \
  --min-instances=0 \
  --max-instances=1 \
  --session-affinity \
  --concurrency=20 \
  --timeout=30 \
  --allow-unauthenticated \
  --set-secrets="RENTCAST_API_KEY=foreal-rentcast-api-key:<RENTCAST_VER>,GEMINI_API_KEY=foreal-gemini-api-key:<GEMINI_VER>" \
  --set-env-vars="NODE_ENV=production,BUDGET_STORE_MODE=firestore,GOOGLE_CLOUD_PROJECT=${GOOGLE_CLOUD_PROJECT},FIRESTORE_BUDGET_COLLECTION=rentcast_budget,RENTCAST_GLOBAL_MONTHLY_LIMIT=35,RENTCAST_INITIAL_SPENT_CALLS=0,GEMINI_EXPLAIN_MODEL=gemini-4-hydrogen,GEMINI_EXPLAIN_FALLBACK_MODEL=gemini-2.5-flash,OSM_OVERPASS_URL=https://overpass-api.de/api/interpreter,ENABLE_SYNTHETIC_DEMO_MODE=false,GOOGLE_MAPS_BROWSER_KEY=${GOOGLE_MAPS_BROWSER_KEY:-}"
```

Retrieve the deployed service URL dynamically:

```bash
SERVICE_URL="$(gcloud run services describe foreal-estate \
  --project="$GOOGLE_CLOUD_PROJECT" \
  --region="$CLOUD_RUN_REGION" \
  --format='value(status.url)')"
echo "$SERVICE_URL"
```

---

## 6. Post-Deploy Smoke Tests & Rollback

### 6.1 Local & Pre-Deploy Provider Probe (`scripts/verify-live-providers.mjs`)
Before deploying or testing live keys locally, run [`scripts/verify-live-providers.mjs`](../scripts/verify-live-providers.mjs) to verify `.env` / environment readiness without printing secret values or spending RentCast credits unintentionally:

```bash
# Default (0 RentCast calls; probes Gemini models if GEMINI_API_KEY is set)
node scripts/verify-live-providers.mjs

# Explicit 1-call RentCast probe (spends 1 RentCast credit if RENTCAST_API_KEY is set)
node scripts/verify-live-providers.mjs --probe-rentcast
```

### 6.2 Unauthenticated Smoke Tests
Run immediately after deployment against `$SERVICE_URL`:

```bash
# 1. Liveness & readiness check (must return HTTP 200 and durabilityMode: "firestore")
curl -fsS "${SERVICE_URL}/api/health"

# 2. Public config check (verify capabilities and confirm NO server secrets are present)
curl -fsS "${SERVICE_URL}/api/config"

# 3. Static SPA shell check (must return HTTP 200 text/html)
curl -fsSI "${SERVICE_URL}/"

# 4. US region disambiguation check (does NOT spend RentCast credits)
curl -fsS -X POST "${SERVICE_URL}/api/regions/resolve" \
  -H "Content-Type: application/json" \
  -d '{"query":"Springfield","clientRequestSeq":1}'
```

### 6.3 Traffic Rollback
List revisions and route `100%` of traffic back to a known-good revision:

```bash
gcloud run revisions list \
  --service=foreal-estate \
  --project="$GOOGLE_CLOUD_PROJECT" \
  --region="$CLOUD_RUN_REGION"

gcloud run services update-traffic foreal-estate \
  --project="$GOOGLE_CLOUD_PROJECT" \
  --region="$CLOUD_RUN_REGION" \
  --to-revisions="<PREVIOUS_GOOD_REVISION>=100"
```

---

## 7. Current Deployment Blockers

- **Hosted Prototype URL:** **`BLOCKED / NOT DEPLOYED`**
- **Phase 4 / Phase 5 Read-Only Google Cloud Environment Audit (Rechecked `2026-11-14 05:44 PT`, Google Cloud SDK `593.0.0`):**
  1. **`gcloud` CLI & Active Auth (`verified`):** `/opt/homebrew/bin/gcloud --version` (exit `0`, SDK `593.0.0`); `/opt/homebrew/bin/gcloud auth list` (exit `0`, active live account `qcd2529@gmail.com`); `/opt/homebrew/bin/gcloud config list` (exit `0`, `core.account = qcd2529@gmail.com`, no `core.project` or `run.region` set).
  2. **Application Default Credentials (`missing` — NOT required for deploy):** `test -f /Users/isang-yeon/.config/gcloud/application_default_credentials.json` exited `1` (absent); neither deployment script requires local ADC.
  3. **Projects & Billing (`verified` active projects, `missing` billing as of `2026-11-14 05:44 PT`):** `/opt/homebrew/bin/gcloud projects list` (exit `0`) still shows the same two `ACTIVE` projects (`gen-lang-client-0222559199` / `Petpulse` `#733697811999` and `gen-lang-client-0582732543` / `n8ntest` `#686829907635`). `/opt/homebrew/bin/gcloud billing accounts list` (exit `0`) returned `Listed 0 items.`, and `/opt/homebrew/bin/gcloud billing projects describe` (exit `0`) confirmed `billingAccountName: ''` and `billingEnabled: false` on **both** projects. Billing budgets (`gcloud billing budgets list`) are `not checked` because no billing account ID exists.
  4. **Enabled APIs, Cloud Run, Secrets, Service Accounts & Keys (`missing` / `SERVICE_DISABLED`):**
     - `gen-lang-client-0222559199`: `services list --enabled` (exit `0`) shows only `generativelanguage.googleapis.com`, `playintegrity.googleapis.com`, `telemetry.googleapis.com`. `run services list --quiet` (exit `1`, `SERVICE_DISABLED` for `run.googleapis.com`), `secrets list --quiet` (exit `1`, `SERVICE_DISABLED` for `secretmanager.googleapis.com`), `iam service-accounts list` (exit `0`, `0` items), `services api-keys list` (exit `0`, `0` items).
     - `gen-lang-client-0582732543`: `services list --enabled --quiet` (exit `0`) shows only `generativelanguage.googleapis.com`, `playintegrity.googleapis.com`. `run services list --quiet` (exit `1`, `SERVICE_DISABLED` for `run.googleapis.com`), `secrets list --quiet` (exit `1`, `SERVICE_DISABLED` for `secretmanager.googleapis.com`), `iam service-accounts list --quiet` (exit `0`, `0` items), `services api-keys list --quiet` (exit `0`, `0` items).
  5. **Google One AI Ultra / GCP Promotional Credits (`inaccessible` via `gcloud`):** `gcloud` provides no CLI command to query promotional or Google One AI credit balances; remaining credits must be inspected manually in the Google Cloud Console Billing (**Overview** / **Incentives**) or Google AI Studio billing dashboard.
  6. **Unconfirmed Deployment Target & Secrets (`missing`):** No confirmed `GOOGLE_CLOUD_PROJECT`, `CLOUD_RUN_REGION`, `CLOUD_RUN_SERVICE_ACCOUNT`, `CONFIRM_BILLING_AND_SPENDING_LIMITS=true`, Firestore `(default)` database, or Secret Manager secrets (`RENTCAST_API_KEY`, `GEMINI_API_KEY`) have been provisioned.
- **Unblocking Action:** Select or create a billing-enabled GCP project (confirming any Google One AI Ultra / GCP credits in Console), enable `run.googleapis.com`, `cloudbuild.googleapis.com`, `secretmanager.googleapis.com`, and `firestore.googleapis.com`, provision the runtime service account and Secret Manager secrets, and run `./scripts/deploy-cloud-run.sh` with `CONFIRM_BILLING_AND_SPENDING_LIMITS=true`.
