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
- [`.dockerignore`](../.dockerignore) excludes `.git/`, `node_modules/`, `dist/`, `build/`, `.env`, `.env.*`, `.data/`, `*.sqlite*`, `*.db`, `tests/`, `coverage/`, `logs/`, and OS/editor artifacts so secrets and test fixtures are never baked into the container image.

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
| `RENTCAST_API_KEY` | **Server-only secret** | `--set-secrets` (`rentcast-api-key:latest`) | Used only in server `X-Api-Key` header. Never in `/api/config`, client bundle, logs, or URLs. |
| `GEMINI_API_KEY` | **Server-only secret** | `--set-secrets` (`gemini-api-key:latest`) | Used only by `@google/genai` on the server for `/api/explain`. |
| `GOOGLE_PLACES_SERVER_KEY` *(optional)* | **Server-only secret** | `--set-secrets` (`google-places-server-key:latest`) | Optional display-only Places context (`google_places_context`, barred from scoring). Never exposed to browser. |
| `GOOGLE_MAPS_BROWSER_KEY` | **Restricted browser key** | `--set-env-vars` | Intentionally returned via `GET /api/config` (`mapsBrowserKey`). **Must** be restricted in Google Cloud Console by **HTTP referrer** (`https://<service-url>/*`, `http://localhost:5173/*`, `http://localhost:8080/*`) and **API scope** (**Maps JavaScript API only**). |

### Create Secret Manager Entries (Operator Steps)
Run once per GCP project (never store secret values in git or shell history if avoidable):

```bash
export GOOGLE_CLOUD_PROJECT="<your-gcp-project-id>"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com secretmanager.googleapis.com firestore.googleapis.com --project="$GOOGLE_CLOUD_PROJECT"

# Create secrets (supply values via stdin / interactive prompt)
printf '%s' "$RENTCAST_API_KEY_VALUE" | gcloud secrets create rentcast-api-key --data-file=- --project="$GOOGLE_CLOUD_PROJECT"
printf '%s' "$GEMINI_API_KEY_VALUE" | gcloud secrets create gemini-api-key --data-file=- --project="$GOOGLE_CLOUD_PROJECT"
# Optional:
# printf '%s' "$GOOGLE_PLACES_SERVER_KEY_VALUE" | gcloud secrets create google-places-server-key --data-file=- --project="$GOOGLE_CLOUD_PROJECT"
```

Grant the dedicated runtime service account (`CLOUD_RUN_SERVICE_ACCOUNT`) `roles/secretmanager.secretAccessor` only on the required secrets:

```bash
export CLOUD_RUN_SERVICE_ACCOUNT="foreal-estate-runner@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com"

for secret in rentcast-api-key gemini-api-key; do
  gcloud secrets add-iam-policy-binding "$secret" \
    --project="$GOOGLE_CLOUD_PROJECT" \
    --member="serviceAccount:${CLOUD_RUN_SERVICE_ACCOUNT}" \
    --role="roles/secretmanager.secretAccessor"
done
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

3. **Fail-Closed Guarantee:** When `BUDGET_STORE_MODE=firestore`, if Firestore is unreachable or permissions are missing, the server refuses to dispatch upstream RentCast requests (`BUDGET_STORE_UNAVAILABLE`, HTTP `503`) rather than risking untracked calls.

---

## 4. Hard Spending & Quota Controls

> [!WARNING]
> **GCP Billing Budget Alerts Are NOT Hard Spending Caps:** Google Cloud Billing budgets and email/PubSub alerts are **notifications only** — they do **not** automatically disable Cloud Run billing or stop upstream API charges. Always enforce hard technical ceilings at the service, API quota, and application budget layers.

Foreal-Estate combines four technical controls to prevent runaway spend:

1. **Cloud Run Scaling Ceilings:**
   - `--max-instances=2` (caps total concurrent containers)
   - `--concurrency=20` (bounded per-container request fan-in)
   - `--timeout=60s` (prevents hung request billing)
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

[`scripts/deploy-cloud-run.sh`](../scripts/deploy-cloud-run.sh) implements strict preflight checks requiring `GOOGLE_CLOUD_PROJECT`, `CLOUD_RUN_REGION`, `CLOUD_RUN_SERVICE_ACCOUNT`, `CONFIRM_BILLING_AND_SPENDING_LIMITS=true`, valid `RENTCAST_GLOBAL_MONTHLY_LIMIT` (`1..49`), active `gcloud auth`, and existing Secret Manager entries before running `gcloud run deploy`.

### Scripted Deployment
```bash
export GOOGLE_CLOUD_PROJECT="<your-gcp-project-id>"
export CLOUD_RUN_REGION="us-west1"
export CLOUD_RUN_SERVICE_ACCOUNT="foreal-estate-runner@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com"
export CONFIRM_BILLING_AND_SPENDING_LIMITS=true
export GOOGLE_MAPS_BROWSER_KEY="<http-referrer-restricted-maps-browser-key>"   # optional

./scripts/deploy-cloud-run.sh
```

### Equivalent Explicit `gcloud run deploy` Command
```bash
gcloud run deploy foreal-estate \
  --source=. \
  --project="$GOOGLE_CLOUD_PROJECT" \
  --region="$CLOUD_RUN_REGION" \
  --port=8080 \
  --service-account="$CLOUD_RUN_SERVICE_ACCOUNT" \
  --max-instances=2 \
  --concurrency=20 \
  --timeout=60s \
  --allow-unauthenticated \
  --set-secrets="RENTCAST_API_KEY=rentcast-api-key:latest,GEMINI_API_KEY=gemini-api-key:latest" \
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

### 6.1 Unauthenticated Smoke Tests
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

### 6.2 Traffic Rollback
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
- **Observed Workspace Blockers:**
  1. **Unconfigured & Unauthenticated `gcloud` Workspace:** Although `Google Cloud SDK 593.0.0` (`/opt/homebrew/bin/gcloud`) is present on the host binary path, `gcloud config list` has no active `project` or `run/region`, `gcloud auth list` cannot access credentials in the workspace sandbox (`PermissionError` on `~/.config/gcloud/credentials.db`), and no live GCP deployment was executed.
  2. **Missing Confirmed GCP Target & Billing Confirmation:** No confirmed `GOOGLE_CLOUD_PROJECT`, `CLOUD_RUN_REGION`, `CLOUD_RUN_SERVICE_ACCOUNT`, or explicit `CONFIRM_BILLING_AND_SPENDING_LIMITS=true` sign-off has been provided.
  3. **Unprovisioned Secret Manager & Firestore State:** Secret Manager secrets (`RENTCAST_API_KEY`, `GEMINI_API_KEY`, optional `GOOGLE_PLACES_SERVER_KEY`), HTTP-referrer-restricted `GOOGLE_MAPS_BROWSER_KEY`, and the Firestore `(default)` database permissions have not been provisioned in a target project.
- **Unblocking Action:** Once a user supplies an authenticated `gcloud` session, target GCP project/region, service account, Secret Manager entries, and `CONFIRM_BILLING_AND_SPENDING_LIMITS=true`, run `./scripts/deploy-cloud-run.sh` from a full terminal environment and record the resulting `status.url`.
