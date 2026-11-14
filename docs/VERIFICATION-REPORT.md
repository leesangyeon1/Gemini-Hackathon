# Final Verification & Adversarial Audit Report (`VERIFICATION-REPORT.md`)

**Owner:** `verifier` (Workstream 5 / Phase 4–5 — Independent Cloud, Security, Numerical & Browser Verifier)  
**Project:** **Foreal-Estate** — Explainable US Real-Estate Location & Asking-vs-AVM Comparison Web Application  
**Verification Window:** `2026-11-14 00:08 PT` – `2026-11-14 06:17 PT`  
**Overall Gate Status:** **PASS (`0` Open Defects — Local Build, Typecheck, `112/112` Vitest Tests, Separate Real Google Chrome 156 Local E2E Journey, AI Studio `AccessibleLegends` Integration, Durable Session/Budget Persistence & Secret Isolation Verified; Public Cloud Run Verification Explicitly `NOT RUN / BLOCKED` Pending GCP Billing Linkage)**

---

## 1. Executed Verification Commands & Observed Results (Strictly Separated by Environment)

Every command below was executed directly against the integrated repository (`Node.js v24.7.0`, `npm 11.7.0`, `TypeScript 5.7.3`, `Vite 6.4.6`, `Vitest 3.2.7`, `Google Chrome 156.0.8078.82`) with zero skipped or `todo` tests remaining.

### 1.1 Automated Build, Static Analysis, Node & `jsdom` Suites (Local Automated Runner)

| Gate | Exact Command Executed | Exit Code | Observed Output / Result |
|---|---|---|---|
| **TypeScript Check (Client + Shared + Server)** | `npm run typecheck` (`tsc --noEmit && tsc -p tsconfig.server.json --noEmit`) | `0` | **PASS** — `0` TypeScript errors across client (including AI-Studio-integrated `AccessibleLegends.tsx`), shared contracts, server modules, and all `13` test suites. |
| **Production Client & Server Build** | `npm run build` (`vite build` + `vite build --ssr src/server/index.ts --outDir dist/server`) | `0` | **PASS** — Built `dist/client/index.html` (`0.61 kB`), `dist/client/assets/*.css` (`15.50 kB`), `dist/client/assets/*.js` (`489.94 kB`), and `dist/server/index.js` (`302.27 kB`). |
| **Adversarial Verification Suites (`node` + `jsdom`)** | `npx vitest run tests/verification` | `0` | **PASS** — `3` test files passed (**`39/39` tests**, `0` failed, `0` todo/skipped): `stage1Audit.test.ts` (`28`), `fullSystemIntegration.test.ts` (`9`, including updated Phase 5 `CR-01`), `clientJourneyVerification.test.tsx` (`2` in `jsdom`). |
| **Full Workspace Test Suite (`node` + `jsdom`)** | `npm test` (`vitest run`) | `0` | **PASS** — **`13/13` test files passed (`112/112` tests passed, `0` failed, `0` todo/skipped)**: `96` tests in `server-and-verification` (`node`) and `16` tests in `client-ui` (`jsdom`: `App.test.tsx` `9`, `utils.test.ts` `5`, `clientJourneyVerification.test.tsx` `2`). |
| **Compiled `0.0.0.0:$PORT` Server Startup** | Dynamic import of `dist/server/index.js` -> `startServer({ host: "0.0.0.0", port: 0 })` + `GET /` SPA serving check | `0` | **PASS** — Compiled production bundle bound `0.0.0.0` on an OS-assigned ephemeral IPv4 port without external API keys, served `dist/client/index.html` (`200 text/html`), and closed cleanly. |
| **Client Source & Bundle Secret Scan** | Automated scan across `src/client/**`, `index.html`, `vite.config.ts`, and `dist/client/**` (including sourcemaps) | `0` | **PASS** — `0` occurrences of `VITE_`, `import.meta.env`, `RENTCAST_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_PLACES_SERVER_KEY`, or canary secret values. |
| **`.gitignore` / `.dockerignore` / `.gcloudignore` & `.env` Hygiene** | Automated rule + `git ls-files` / `git check-ignore` inspection in `CR-01` | `0` | **PASS** — All three ignore files exclude `.env`, `.env.*`, `.data/`, and `*.sqlite*`; untracked local `.env` (`chmod 600`) is confirmed git-ignored (`git ls-files .env .env.*` returns only `['.env.example']`). |
| **Markdown Link & `BUILD_PROVENANCE.md` Parity** | Automated link parser across `README.md`, `docs/*.md`, and `docs/decisions/ADR-001-rentcast.md` (`14` Markdown files) | `0` | **PASS** — `100%` of local Markdown file links resolve on disk; `docs/BUILD_PROVENANCE.md` consolidated with zero duplicate `docs/PROVENANCE.md`; `docs/AI_STUDIO_HANDOFF.md` records verified `EXECUTED & EXPORTED` (`gemini-4-hydrogen`) provenance. |
| **Cloud Run Deploy & Provision Scripts Fail-Closed Preflight** | `bash -n` + execution of `scripts/deploy-cloud-run.sh` and `scripts/provision-gcp-resources.sh` + `node --check scripts/verify-live-providers.mjs` | `1` *(expected fail-closed on unset project / `limit=50`)*; `0` *(syntax)* | **PASS** — Both shell scripts pass `bash -n` and exit `1` fail-closed when `GOOGLE_CLOUD_PROJECT` or billing confirmation is unset or `RENTCAST_GLOBAL_MONTHLY_LIMIT >= 50`; `verify-live-providers.mjs` passes `node --check`. |

---

### 1.2 Separate Real Google Chrome 156 Local E2E Browser Verification (`E2E-CHROME-01` — Distinct from `jsdom`)

Executed against the compiled production bundle (`dist/server/index.js`) listening on `http://127.0.0.1:61661` (`NODE_ENV=production`, `BUDGET_STORE_MODE=memory`, `ENABLE_SYNTHETIC_DEMO_MODE=true`, zero secret keys) and driven over live `DevToolsActivePort` Chrome DevTools Protocol WebSocket (`connectionMode: "gui_devtools_active_port"`) inside **real Google Chrome `156.0.8078.82`** (`macOS`, Blink layout + V8 runtime) using a brand-new isolated background tab (`Target.createTarget` -> `Target.closeTarget` on exit; zero existing user tabs touched):

| Step | Real Chrome `156.0.8078.82` Check | Observed Real-Browser Layout & DOM Evidence | Result |
|---|---|---|---|
| **1** | Initial `setup_needed` state & US neutrality | `[data-testid="setup-needed-banner"]` rendered at `1408 px` width displaying `Setup Needed` and `RENTCAST_API_KEY`; `[data-testid="synthetic-demo-banner"]` absent; `#region-query-input` empty (`""`, no hardcoded Berkeley). | **PASS** |
| **2** | AI-Studio-integrated `AccessibleLegends` (`gemini-4-hydrogen`) ARIA disclosure & source badges | Both `[data-testid="legend-accessibility"]` (`365 px` width) and `[data-testid="legend-price-gap"]` (`365 px` width) rendered simultaneously; clicking `.legend-disclosure-btn` toggled `aria-expanded` `"true" -> "false" -> "true"` across React 18 async frame commits and hid/unhid `#legend-accessibility-panel`; all `4` source-attribution badges (`osm-overpass`, `epa-frs`, `google-places`, `rentcast-avm`) rendered. | **PASS** |
| **3** | Explicit opt-in labeled `synthetic_demo` | Clicking `Preview Labeled Synthetic Demo Mode` rendered `[data-testid="synthetic-demo-banner"]` (`SYNTHETIC DEMO FIXTURE — NOT LIVE COVERAGE`). | **PASS** |
| **4** | US region input + `Springfield` multi-state disambiguation | Submitting `Springfield` rendered `[data-testid="ambiguous-candidates"]` with `Springfield, Sangamon County, IL` and `Springfield, Greene County, MO`; selecting `Springfield, Sangamon County, IL` rendered `[data-testid="confirmed-area-box"]`. | **PASS** |
| **5** | `Analyze Area` + interactive SVG geodesic map & live source date | Clicking `[data-testid="analyze-area-button"]` rendered interactive `<svg>` at **`709 px × 479 px`** with **`34` `<circle>` elements**, populated `[data-testid="property-card-syn-us-il-springfield-02"]`, and updated `[data-testid="source-badge-osm-overpass"]` to `Date: Nov 14, 2026`. | **PASS** |
| **6** | On-demand AVM range bar, `$900k/$1M` `in_range` & contrary evidence | Selecting Home #2 and clicking `[data-testid="fetch-avm-button"]` rendered `[data-testid="detail-asking-price"]` (`$900,000`), `[data-testid="detail-avm-price"]` (`$1,000,000`), `[data-testid="detail-avm-range"]` (`$850,000 – $1,150,000`), `[data-testid="contrary-evidence-section"]` (`+10.0%` inside AVM range), and updated `[data-testid="source-badge-rentcast-avm"]` to `Date: Nov 14, 2026`. | **PASS** |
| **7** | Grounded `/api/explain` deterministic fallback | Clicking `[data-testid="generate-explain-button"]` rendered `[data-testid="explain-result"]` with `Deterministic Fallback`, `$900,000`, and `ev_prop_pricing`. Isolated tab and `127.0.0.1:61661` server closed cleanly (`exit 0`). | **PASS** |

---

### 1.3 Public Cloud Run Service Verification (`NOT RUN — BLOCKED ON GCP BILLING LINKAGE`)

| Check | Status | Verified Blocker Reason |
|---|---|---|
| **Public Unauthenticated Cloud Run Smoke & E2E (`https://*.run.app`)** | **`NOT RUN` (`BLOCKED / NOT DEPLOYED`)** | Re-checked via `/opt/homebrew/bin/gcloud billing accounts list` (`Listed 0 items.`) and Chrome 156 `console.cloud.google.com/billing` (`0` billing accounts linked on `qcd2529@gmail.com`; `billingEnabled: false` on `gen-lang-client-0222559199` and `gen-lang-client-0582732543`). No `*.run.app` URL is claimed or invented. |

---

## 2. Adversarial Audit Ledgers (`AUDIT-01`..`AUDIT-08` & `AUDIT-CR-01`..`AUDIT-CR-03` — All Resolved)

### 2.1 Stage 2 & Stage 3 Code/Doc Audit Ledger (`AUDIT-01` through `AUDIT-08`)

| Audit ID | Owner | Original Defect | Resolution Verified |
|---|---|---|---|
| **AUDIT-01** | `integrator` | `config.ts` auto-switched `uiSetupState` to `'synthetic_demo'` when `ENABLE_SYNTHETIC_DEMO_MODE=true` and `RENTCAST_API_KEY` was missing. | Fixed in `src/server/config.ts` — `uiSetupState` stays `'setup_needed'` so synthetic demo mode remains strictly user opt-in. |
| **AUDIT-02** | `integrator` | `src/server/index.ts` read raw `Number(process.env.PORT)` directly instead of `overrideConfig.port` / validated `config.port`. | Fixed in `src/server/index.ts:15-22` — honors `overrideConfig.port` (including `0` ephemeral bind on `0.0.0.0`) and `config.port`. |
| **AUDIT-03** | `integrator` | `src/server/app.ts` and `buildValidationErrorResponse` echoed unvalidated `req.body.clientRequestSeq` (e.g., `-5`, floats) in `4xx`/`5xx` error payloads. | Fixed in `src/shared/schemas.ts` and `src/server/app.ts` via `extractValidClientRequestSeq`. |
| **AUDIT-04** | `integrator` | `BUDGET_STORE_MODES` omitted `'memory'`, and facility/contribution/environmental Zod schemas accepted `sourceId: 'google_places_context'`. | Fixed in `src/shared/constants.ts` and `src/shared/schemas.ts` — `'google_places_context'` is schema-barred from scoring/environmental records. |
| **AUDIT-05** | `geospatial` | `computeBoundedGridOverlap` did not guard `options.gridResolution: NaN`, and `AreaGeospatialCache.put()` defaulted `allowSyntheticDemo = true`. | Fixed in `src/server/geospatial/scoring.ts` (defaults `NaN` to `11`) and `src/server/geospatial/cache.ts` (`allowSyntheticDemo = false`). |
| **AUDIT-06** | `integrator` | `redactSecretsFromText` scrubbed raw secret strings but not URL-encoded (`encodeURIComponent`) secret tokens. | Fixed in `src/server/config.ts` — scrubs both raw and URL-encoded secret representations. |
| **AUDIT-07** | `explain` | `src/server/explain/router.ts` echoed raw numeric `clientRequestSeq` (`-5`) on `400 VALIDATION_ERROR` responses, violating `ApiErrorResponseSchema`. | Fixed in `src/server/explain/router.ts` (`#28`) using `extractValidClientRequestSeq`. |
| **AUDIT-08** | `explain` | `docs/AI_STUDIO_HANDOFF.md` Section 3–4 had drifted endpoint/type names vs. `src/shared/types.ts`. | Fixed in `docs/AI_STUDIO_HANDOFF.md` (`#28`) — aligned `1:1` with `UI_STATES`, `PropertyListingSummary`, and `/api/properties/search`. |

### 2.2 Phase 4 & Phase 5 Cloud Run Durability, Session-Expiry & Secret-Exclusion Ledger (`CR-01`)

| Audit ID / Check | Target Files | Status | Resolution Verified |
|---|---|---|---|
| **AUDIT-CR-01 (`K_SERVICE` Cloud Run Default)** | `src/server/config.ts:146-156` *(owner: `coordinator`)* | **RESOLVED (`#43`)** | When `process.env.K_SERVICE` is present and `BUDGET_STORE_MODE` is unset, `loadServerConfig()` auto-defaults `budgetStoreMode` to `'firestore'` (failing closed with `503` if `GOOGLE_CLOUD_PROJECT` is missing instead of writing ephemeral container-local SQLite). |
| **AUDIT-CR-02 (`FirestoreBudgetStore` Concurrency)** | `src/server/property/budgetStore.ts` *(owner: `property`)* | **RESOLVED (`#40`)** | Cloud Run metadata OAuth token TTL caching (`expires_in - 60s`), `withFirestoreLock`, and 4-attempt optimistic concurrency retry on HTTP `409 ABORTED` / `400 FAILED_PRECONDITION` verified (`13/13` property tests green). |
| **AUDIT-CR-03 (Durable `PropertySessionStore`, `409 SESSION_EXPIRED` & Verified Secret Versions)** | `src/server/property/{sessionStore,router,index}.ts`, `src/server/app.ts`, `src/server/explain/router.ts`, `src/client/App.tsx`, `scripts/deploy-cloud-run.sh`, `scripts/provision-gcp-resources.sh` | **RESOLVED (`#45`, `#54`–`#57`)** | `PropertySessionStore` now persists sessions durably in SQLite (`foreal_property_sessions`) and Firestore (`foreal_sessions/{sessionId}`, 24h TTL). Verified in `CR-01`: Instance B hydrates sessions across restarts/instances on `/api/explain` and `/avm` with **`0` repeated RentCast calls**; genuinely missing/expired sessions return HTTP **`409 SESSION_EXPIRED`** (`uiState: 'recovery'`, preserving UI state in `<App />` with `0` automatic retries); unknown `propertyId` on an active session still returns `404 NOT_FOUND`. Deploy script defaults to `us-west1`, `--min-instances=0`, `--max-instances=1`, `--session-affinity`, and queries verified `state=ENABLED` numeric secret versions (never assuming `1` or `:latest`). |
| **Google AI Studio Component Review (`AccessibleLegends.tsx`)** | `src/client/components/AccessibleLegends.tsx`, `src/client/App.tsx`, `docs/AI_STUDIO_HANDOFF.md` *(owners: `explain` -> `frontend`)* | **VERIFIED (`#60`, `#62`)** | Real Google AI Studio (`gemini-4-hydrogen`, `15,012` tokens) component integrated cleanly by `frontend`: zero invented financial figures, zero secret references, full ARIA disclosure (`aria-expanded`, `aria-controls`, `role="region"`, arrow/Home/End keys) + 4 live source-attribution date badges verified in both `jsdom` (`App.test.tsx`) and real Google Chrome 156 (`E2E-CHROME-01`). |

---

## 3. Verified Requirements Summary (`GEO`, `PROP`, `UX`, `SEC`, `DOC`, `CR`, `E2E-CHROME`)

- **Numerical & Geospatial (`GEO-01` – `GEO-09`):** WGS84 geodesic distances, invalid/`NaN`/`Infinity` coordinate rejection, linear decay kernel endpoints & category saturation, conservative deduplication & 30-shuffle order-invariance, influence-buffered Overpass edge queries (`R_fetch = R_area + max(radius_c)`), honest `unknown`/`partial` vs healthy `0`, unconditional `google_places_context` exclusion, `fast_food` `0` default weight, and neutral separate `epa_frs` due-diligence layer.
- **Property, Price-Gap & Durable Budget/Session Governance (`PROP-01` – `PROP-09`, `CR-01`):** `gapPct = 100 * (avmPrice - askingPrice) / avmPrice`, `[avmLow, avmHigh]` range guardrails (`$1M/$900k/[$850k, $1.15M] => +10.0%` AND `in_range` with `isProvenUndervaluation: false`), distinct financial/date fields, subject-in-comps circularity flag, recursive PII stripping, upstream `401`/`429`/timeout key scrubbing, durable SQLite & Firestore budget + session persistence across restarts/instances, `409 SESSION_EXPIRED` safe recovery, `6`/`12` session caps and `< 50` global cap, and zero RentCast calls on map pan or preference re-scoring.
- **Grounded `/api/explain`, Security & Repo Parity (`SEC-01` – `SEC-07`, `DOC-01`):** Server-resolved valuation authority, `evidenceId` + numeric + prohibited-claim post-validation, prompt-injection neutralization, graceful deterministic fallback, secret redaction across responses/logs/bundles/`.gcloudignore`, SSRF prevention, `0.0.0.0:$PORT` startup, and `100%` Markdown link resolution across all `14` documentation files.

---

## 4. Explicitly Unverified & Environment-Blocked Items

1. **Public Cloud Run Deployment & Hosted URL Verification (`NOT RUN — BLOCKED / NOT DEPLOYED`):**
   - Active GCP account `qcd2529@gmail.com` currently has `0` linked billing accounts (`billingEnabled: false` on `gen-lang-client-0222559199` and `gen-lang-client-0582732543`), so Cloud Run (`run.googleapis.com`), Cloud Build, Secret Manager, and Firestore cannot yet be provisioned in GCP. Once a billing account is linked, `./scripts/provision-gcp-resources.sh` and `./scripts/deploy-cloud-run.sh` are preflight-tested and ready.
2. **Live External Paid/Keyed Upstream Provider Calls (`NOT RUN — KEYS UNCONFIGURED LOCALLY`):**
   - Local `.env` (`chmod 600`, git-ignored) currently contains placeholder blanks (`scripts/verify-live-providers.mjs` confirmed all four keys `MISSING (not probed)`), so zero live RentCast, Gemini API (`@google/genai`), Google Maps JS WebGL tile, or Places API calls were spent from the server runtime. (Note: Google AI Studio web generation on `gemini-4-hydrogen` *was* executed live via authenticated browser session in `#60`.)
