# Final Verification & Adversarial Audit Report (`VERIFICATION-REPORT.md`)

**Owner:** `verifier` (Workstream 5 — Independent Adversarial QA, Numerical, Security & Documentation Verifier)  
**Project:** **Foreal-Estate** — Explainable US Real-Estate Location & Asking-vs-AVM Comparison Web Application  
**Verification Window:** `2026-11-14 00:08 PT` – `2026-11-14 00:55 PT`  
**Overall Gate Status:** **PASS (Local Build, Typecheck, Full Adversarial Test Suite, Secret Isolation & Doc Parity Verified; Cloud Run Deployment & Live Paid API Keys Explicitly Blocked/Unconfigured)**

---

## 1. Executed Verification Commands & Observed Results

Every command below was executed directly against the integrated repository (`Node.js v24.7.0`, `npm 11.7.0`, `TypeScript 5.7.3`, `Vite 6.4.6`, `Vitest 3.2.7`) with zero skipped or `todo` tests remaining.

| Gate | Exact Command Executed | Exit Code | Observed Output / Result |
|---|---|---|---|
| **TypeScript Check (Client + Shared + Server)** | `npm run typecheck` (`tsc --noEmit && tsc -p tsconfig.server.json --noEmit`) | `0` | **PASS** — `0` TypeScript errors across client, shared contracts, server modules, and all `13` test suites. |
| **Production Client & Server Build** | `npm run build` (`vite build` + `vite build --ssr src/server/index.ts --outDir dist/server`) | `0` | **PASS** — Built `dist/client/index.html` (`0.61 kB`), `dist/client/assets/*.css` (`15.27 kB`), `dist/client/assets/*.js` (`222.68 kB`), and `dist/server/index.js` (`280.50 kB`). |
| **Adversarial Verification Suites** | `npx vitest run tests/verification` | `0` | **PASS** — `3` test files passed (`38/38` tests, `0` failed, `0` todo/skipped): `stage1Audit.test.ts` (`28`), `fullSystemIntegration.test.ts` (`8`), `clientJourneyVerification.test.tsx` (`2`). |
| **Full Workspace Test Suite** | `npm test` (`vitest run`) | `0` | **PASS** — **`13/13` test files passed (`105/105` tests passed, `0` failed, `0` todo/skipped)** across `server-and-verification` (`node`) and `client-ui` (`jsdom`) projects. |
| **Compiled `0.0.0.0:$PORT` Server Startup** | Dynamic import of `dist/server/index.js` -> `startServer({ host: "0.0.0.0", port: 0 })` + `GET /` SPA serving check | `0` | **PASS** — Compiled production bundle bound `0.0.0.0` on an OS-assigned ephemeral IPv4 port without external API keys, served `dist/client/index.html` (`200 text/html`), and closed cleanly. |
| **Client Bundle Secret Scan** | Automated scan across all files in `dist/client/**` (including sourcemaps) | `0` | **PASS** — `0` occurrences of `RENTCAST_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_PLACES_SERVER_KEY`, or canary secret values. |
| **Markdown Link & File Completeness Check** | Automated link parser across `README.md`, `docs/*.md`, and `docs/decisions/ADR-001-rentcast.md` (`14` Markdown files) | `0` | **PASS** — `100%` of local Markdown file links and required repository artifacts resolve on disk. |
| **Cloud Run Deploy Script Fail-Closed Preflight** | `./scripts/deploy-cloud-run.sh` (with unset env vars and with `RENTCAST_GLOBAL_MONTHLY_LIMIT=50`) | `1` *(expected fail-closed)* | **PASS** — Refused deployment with exit code `1` both when `GOOGLE_CLOUD_PROJECT` was unset and when `RENTCAST_GLOBAL_MONTHLY_LIMIT >= 50`. |

---

## 2. Adversarial Audit Ledger (`AUDIT-01` through `AUDIT-08` — All Resolved)

All defects caught during Stage 2 pre-integration and Stage 3 post-integration adversarial audits were reported with exact file/line references, fixed by the owning workstreams (`integrator`, `geospatial`, `property`, `explain`), and locked down by regression tests in [`tests/verification/stage1Audit.test.ts`](../tests/verification/stage1Audit.test.ts) and [`tests/verification/fullSystemIntegration.test.ts`](../tests/verification/fullSystemIntegration.test.ts):

| Audit ID | Owner | Original Defect | Resolution Verified |
|---|---|---|---|
| **AUDIT-01** | `integrator` | `config.ts` auto-switched `uiSetupState` to `'synthetic_demo'` when `ENABLE_SYNTHETIC_DEMO_MODE=true` and `RENTCAST_API_KEY` was missing. | Fixed in `src/server/config.ts:234-236` — `uiSetupState` stays `'setup_needed'` so synthetic demo mode remains strictly user opt-in. |
| **AUDIT-02** | `integrator` | `src/server/index.ts` read raw `Number(process.env.PORT)` directly instead of `overrideConfig.port` / validated `config.port`. | Fixed in `src/server/index.ts:15-22` — honors `overrideConfig.port` (including `0` ephemeral bind on `0.0.0.0`) and `config.port`. |
| **AUDIT-03** | `integrator` | `src/server/app.ts` and `buildValidationErrorResponse` echoed unvalidated `req.body.clientRequestSeq` (e.g., `-5`, floats) in `4xx`/`5xx` error payloads. | Fixed in `src/shared/schemas.ts:62-68,723` and `src/server/app.ts:367,408` via `extractValidClientRequestSeq`. |
| **AUDIT-04** | `integrator` | `BUDGET_STORE_MODES` omitted `'memory'`, and facility/contribution/environmental Zod schemas accepted `sourceId: 'google_places_context'`. | Fixed in `src/shared/constants.ts:173` and `src/shared/schemas.ts:76-82,240-277` — `'google_places_context'` is schema-barred from scoring/environmental records. |
| **AUDIT-05** | `geospatial` | `computeBoundedGridOverlap` did not guard `options.gridResolution: NaN`, and `AreaGeospatialCache.put()` defaulted `allowSyntheticDemo = true`. | Fixed in `src/server/geospatial/scoring.ts` (defaults `NaN` to `11`) and `src/server/geospatial/cache.ts:145` (`allowSyntheticDemo = false`). |
| **AUDIT-06** | `integrator` | `redactSecretsFromText` scrubbed raw secret strings but not URL-encoded (`encodeURIComponent`) secret tokens. | Fixed in `src/server/config.ts:270-289` — scrubs both raw and URL-encoded secret representations. |
| **AUDIT-07** | `explain` | `src/server/explain/router.ts:26-44` echoed raw numeric `clientRequestSeq` (`-5`) on `400 VALIDATION_ERROR` responses, violating `ApiErrorResponseSchema`. | Fixed in `src/server/explain/router.ts` (`#28`) using `extractValidClientRequestSeq(req.body?.clientRequestSeq)` + unit test in `tests/explain/router.test.ts`. |
| **AUDIT-08** | `explain` | `docs/AI_STUDIO_HANDOFF.md` Section 3–4 had drifted endpoint/type names (`/api/properties`, `'resolving_region'`, `lotSizeSqFt`, `source`) vs. `src/shared/types.ts`. | Fixed in `docs/AI_STUDIO_HANDOFF.md` (`#28`) — aligned `1:1` with `UI_STATES`, `PropertyListingSummary`, and `/api/properties/search`. |

---

## 3. Verified Requirements Matrix (`GEO`, `PROP`, `UX`, `SEC`, `DOC`)

### 3.1 Numerical & Geospatial (`GEO-01` – `GEO-09`)
- **WGS84 Geodesic Math & Coordinate Bounds (`GEO-01`, `GEO-02`):** Coincident `0 m`, `-0` normalization, symmetry across US metros (Seattle/Austin, Cambridge/Miami, Anchorage/Honolulu), 1° equatorial arc (`111,195.08 m`), antipodal stability, and hard rejection (`InvalidCoordinateError` / `400 VALIDATION_ERROR`) on `NaN`, `±Infinity`, and out-of-range coordinates.
- **Linear Decay Kernel, Saturation, Deduplication & Order-Invariance (`GEO-03`, `GEO-04`, `GEO-05`):** Exact kernel endpoints (`1.0` at `0 m`, `0.5` at `0.5r`, `0.0` at `d >= r`), category saturation `[0, 1]`, conservative same-category merging (`<= 35 m` named, `<= 10 m` unnamed) without cross-category collapse, and bit-identical scores across `30` deterministic Fisher-Yates shuffles.
- **Influence-Buffered Edge Fetch (`GEO-06`):** Verified `POST /api/geospatial/analyze` queries Overpass out to `R_fetch = analysisArea.radiusMeters + max(radius_c)` (`around:4000,...` for `1,600 m` area + `2,400 m` healthcare radius) and accurately scores perimeter listings (`1,500 m` from center) from facilities outside the `1,600 m` area circle (`1,850 m` from center).
- **Unknown/Partial Honesty vs. Healthy Zero (`GEO-07`):** Overpass `AbortError` returns `completeness: "unknown"` (`uiState: "timeout"`); partial category/EPA failure returns `completeness: "partial"` (`uiState: "partial"`) with **zero silent denominator renormalization**; healthy empty Overpass returns `completeness: "complete"` and `score: 0`.
- **Unconditional `google_places_context` Isolation & `fast_food` Zero Default (`GEO-08`, `GEO-09`):** Deeply frozen `SOURCE_POLICY_REGISTRY` rejects `google_places_context` (even with forged `analysisEligible: true`) across scoring, grid overlap, cache storage, environmental records, and `/api/explain` evidence/prompts. `fast_food` defaults to `0` weight; bare industrial tags without EPA FRS programs remain neutral; `epa_frs` stays in the separate user-controlled due-diligence layer (`isAutomaticHealthDetermination: false`).

### 3.2 Property, Price-Gap & Durable Budget Governance (`PROP-01` – `PROP-09`)
- **Formula & Range Guardrails (`PROP-01`, `PROP-02`):** Verified `gapPct = 100 * (avmPrice - askingPrice) / avmPrice` (`500k/450k => +10.0%` `below_estimate_range_candidate`; **`1M/900k/[850k, 1.15M] => +10.0%` AND `in_range`** with `isProvenUndervaluation: false` and `asking_inside_avm_range` contrary evidence; `500k/550k => -10.0%` `above_estimate_range_candidate`; inverted/missing bounds => `range_unknown`; missing/non-positive prices => `no_avm`).
- **Field Hygiene, Circularity & PII Stripping (`PROP-03`, `PROP-04`, `PROP-05`):** Preserves distinct `askingPrice`, `listingLastSeenAt`, `avmPrice`, `avmLow`, `avmHigh`, `avmFetchedAt`, `lastSalePrice`, `lastSaleDate`, and `assessedValue` (never multiplied by accessibility score); flags `subjectIncludedInComps: true` (`subject_included_in_comps` warning); recursively strips owner names, mailing addresses, and agent/office phone/email PII.
- **Provider Resilience & Durable `node:sqlite` Restart Budget (`PROP-06`, `PROP-07`, `PROP-08`, `PROP-09`):** Verified upstream `401` (`502 PROVIDER_ERROR`), `429` (`429 RATE_LIMITED`), and timeout (`504 UPSTREAM_TIMEOUT`) scrub API keys; verified real temp-file `node:sqlite` budget store persists `totalSpentCalls` and `sessionAvmsUsed` across full `createApp()` restarts, enforces `6`-call default / `12`-call user-confirmed expanded session caps and `< 50` global cap (`429 GLOBAL_QUOTA_EXHAUSTED`), serves cached repeat clicks at `0` calls, fails closed (`503 BUDGET_STORE_UNAVAILABLE`) on Firestore errors, and makes **0** AVM calls during search or map pan.

### 3.3 Region Resolution, Full-Stack DOM Journey & UX (`UX-01` – `UX-07`)
- **US Multi-Region Neutrality & Disambiguation (`UX-01`, `UX-02`, `UX-03`):** Verified `"Seattle, WA"`, `"Austin, TX"`, `"02139"`, `"Ballard, Seattle, WA"`, `"60614"` resolve with `isViewportApproximation: true` and zero hardcoded Berkeley defaults; `"Springfield"`, `"Portland"`, `"Columbus"`, and `"Madison"` return `ambiguous` multi-state candidates; `"Toronto, ON"`, `"London, UK"`, and foreign coordinates return `unsupported_area` / `422 UNSUPPORTED_AREA` with `0` RentCast calls.
- **End-to-End Client <-> Express Journey (`UX-04`, `UX-05`, `UX-06`, `UX-07`):** Mounted real `<App />` (`jsdom`) bridged directly to real `createApp()` in `tests/verification/clientJourneyVerification.test.tsx`, verifying initial `setup_needed` banner, explicit opt-in badged `synthetic_demo` mode, separate Accessibility and Price-Gap legends, Springfield disambiguation, zero RentCast calls on map pan or preference re-scoring, `$900k/$1M` `in_range` AVM comparison, deterministic `/api/explain` fallback, `AbortController` + `clientRequestSeq` stale-request cancellation, keyboard SVG marker selection, mobile tab switching, and `504` retry recovery.

### 3.4 Grounded `/api/explain`, Security & Documentation Parity (`SEC-01` – `SEC-07`, `DOC-01`)
- **Server-Resolved Authority & Post-Validation (`SEC-01` – `SEC-04`):** Unknown `propertyId` returns `404 NOT_FOUND` even when caller sends a schema-valid forged `propertyContext`; known `propertyId` ignores client valuation tampering (`$100k / $5M`) and grounds strictly on server state (`$900k / $1M`); post-validator blocks hallucinated `evidenceId`s, contradicted dollar/percent figures, and prohibited McDonald's/fast-food appreciation or demographic claims, degrading to HTTP `200` deterministic fallback (`explanationAvailable: false, fallbackUsed: true`); XML/code-fence prompt injection in untrusted provider addresses is neutralized.
- **Secret Redaction, SSRF Prevention & Repo Honesty (`SEC-05`, `SEC-06`, `SEC-07`, `DOC-01`):** Canary server secrets never appear in `GET /api/config`, `GET /api/health`, `JSON.stringify(config)`, `4xx`/`5xx` payloads, `.env.example`, or `dist/client/**`; caller-supplied SSRF URL fields (`169.254.169.254`) are never contacted; Google AI Studio Build is marked `PENDING` (not claimed used); Cloud Run status is marked `BLOCKED / NOT DEPLOYED` (no URL invented).

---

## 4. Explicitly Unverified, Environment-Constrained & Blocked Items

Per strict engineering honesty rules, the following items were **not** executed live in this workspace and are explicitly recorded as blocked or environment-constrained:

1. **Live Cloud Run Deployment & Unauthenticated Cloud URL Smoke Test (`BLOCKED / NOT DEPLOYED`):**
   - No confirmed `GOOGLE_CLOUD_PROJECT`, `CLOUD_RUN_REGION`, `CLOUD_RUN_SERVICE_ACCOUNT`, `CONFIRM_BILLING_AND_SPENDING_LIMITS=true`, Secret Manager secrets, or Firestore `(default)` database permissions are provisioned in this workspace, and `gcloud` credentials are inaccessible inside the sandbox. Container configuration (`Dockerfile`, `.dockerignore`) and fail-closed deployment preflight (`scripts/deploy-cloud-run.sh`) were verified locally, but **no live `*.run.app` service was deployed or tested**.
2. **Live Upstream Paid/Keyed API Calls (`RENTCAST_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_MAPS_BROWSER_KEY`, `GOOGLE_PLACES_SERVER_KEY`):**
   - No live API keys were present in the workspace environment (`.env` is absent). All upstream HTTP contracts, headers, timeouts, PII scrubbers, budget transactions, and post-validators were verified against realistic provider wire fixtures and adversarial failure mocks rather than live external quota spend.
3. **Real Headless Chromium / Playwright Visual Browser Rendering (`NOT INSTALLED LOCALLY`):**
   - `playwright` is not installed in `package.json` / `node_modules`, and macOS standard sandbox blocks outbound loopback TCP `connect` (`EPERM` on `127.0.0.1:<port>`). Full-stack UI-to-Express verification was executed via React 18 + Testing Library (`jsdom`) wired directly to `createApp()` (`tests/verification/clientJourneyVerification.test.tsx` and `tests/client/App.test.tsx`), alongside real `0.0.0.0:0` TCP socket bind verification on `dist/server/index.js`. No real Chromium pixel/screenshot rendering or Google Maps WebGL tile visual inspection is claimed.
4. **Google AI Studio Build Session (`PENDING`):**
   - [`docs/AI_STUDIO_HANDOFF.md`](AI_STUDIO_HANDOFF.md) is a prepared operator handoff specification only; Google AI Studio Build was **not** executed.
