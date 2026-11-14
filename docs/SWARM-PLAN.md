# Swarm Plan & Ownership (`SWARM-PLAN.md`)

**Coordinator:** `coordinator` (`gemini-4-carbon-high`)  
**Conversation ID:** `11d0d4d9-cb75-4ee7-bd5e-49b4d1351dd7`  
**Swarm Start Window:** 2026-11-13 23:28 PT (within 24-hour fresh-code window prior to Berkeley x DeepMind Hackathon deadlines on 2026-11-14 10:30 AM PT in-person / 11:59 PM PT online-only)

---

## 1. Account-Supported Gemini Models & Selection Rationale

Inspected via `swarm{action:"models", all:true}` on 2026-11-13T23:28:00-08:00 (all at `100%` quota remaining; partner non-Gemini models excluded per hackathon fresh-code rules):

| Member | Role / Workstream | Pinned Gemini Model | Rationale |
|---|---|---|---|
| `coordinator` | Swarm Coordinator & Repo Index | `gemini-4-carbon-high` | Switched from `gemini-4-carbon-medium` per explicit prompt preference for Carbon High coordination |
| `monitor` | Stall Monitor | `gemini-4-carbon-medium` (inherited default) | Required by `swarm` skill (`swarm_monitor` present); wakes only to break stalls |
| `integrator` | Architecture, Shared Contracts & App Wiring | `gemini-4-carbon-high` | Carbon High for shared TypeScript/Zod contracts, PRD/Architecture/API specs, and final wiring |
| `property` | (1) Property API, Region Resolver & Durable Budget | `gemini-4-argon-high` | Argon High for RentCast schema verification, ADR, and atomic budget/session controls |
| `geospatial` | (2) Licensed Geospatial Sources & Deterministic Scoring | `gemini-4-argon-high` | Argon High for geodesic math, linear kernels, saturation, unknown handling, and source policy |
| `frontend` | (3) Map, List, Detail & Accessibility/Gap UI | `gemini-4-hydrogen-high` | Hydrogen High for interactive React/Maps UI, accessible legends, keyboard/mobile UX, and client tests |
| `explain` | (4) Grounded Gemini Explanations & AI Studio Handoff | `gemini-3.8-flash-high` | Gemini 3.8 Flash High for `/api/explain` validation, independent contract review, and AI Studio handoff |
| `verifier` | (5) Independent Adversarial QA & Security Verifier | `gemini-4-carbon-high` | Separate Carbon High adversarial verifier inspecting pre-integration and post-integration |
| `release` | (6) Cloud Run, Secret Isolation, Provenance & Pitch Package | `gemini-4-hydrogen-high` | Hydrogen High for Dockerfile, Cloud Run deploy script/docs, provenance ledger, and hackathon scripts |

---

## 2. Strict Non-Overlapping File Ownership (Shared Workspace)

Every writable path has **one single owner**. Workers must never edit files outside their assigned paths.

| Owner | Writable Paths Owned |
|---|---|
| `coordinator` | `README.md`, `docs/SWARM-PLAN.md` |
| `integrator` | `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/API-CONTRACTS.md`, `package.json`, `package-lock.json`, `tsconfig.json`, `tsconfig.server.json`, `vite.config.ts`, `vitest.config.ts`, `.gitignore`, `.env.example`, `index.html`, `src/shared/**`, `src/server/config.ts`, `src/server/app.ts`, `src/server/index.ts` |
| `property` | `docs/DATA-SOURCES.md`, `docs/decisions/ADR-001-rentcast.md`, `src/server/property/**`, `tests/property/**` |
| `geospatial` | `docs/SCORING.md`, `src/server/geospatial/**`, `tests/geospatial/**` |
| `frontend` | `src/client/**`, `tests/client/**` |
| `explain` | `docs/AI_STUDIO_HANDOFF.md`, `src/server/explain/**`, `tests/explain/**` |
| `verifier` | `docs/TEST-PLAN.md`, `docs/VERIFICATION-REPORT.md`, `tests/verification/**` *(strictly read-only on `src/**`)* |
| `release` | `docs/DEPLOYMENT.md`, `docs/PROVENANCE.md`, `docs/SUBMISSION-PACKAGE.md`, `Dockerfile`, `.dockerignore`, `scripts/deploy-cloud-run.sh` |

---

## 3. Minimal Shared Interfaces (`src/shared/`)

`integrator` establishes these canonical TypeScript/Zod contracts in Stage 1 before Stage 2 workers build against them:

1. **Geography & Region Confirmation (`/api/regions/resolve`)**:
   - Input: `{ query: string }` or `{ bounds: { centerLat: number; centerLng: number; radiusMeters: number } }`
   - Output: `{ status: "resolved" | "ambiguous" | "unsupported_area", candidates: RegionCandidate[], selectedArea?: AnalysisArea }` (explicit center + radiusMeters + boundingBox + `isViewportApproximation: true`, never claiming an official neighborhood polygon; rejects non-US locations; never hardcodes Berkeley).
2. **Source-Policy & Facilities (`/api/geospatial/analyze`)**:
   - Server-controlled `SourceId = "osm_overpass" | "osm_extract" | "epa_frs" | "synthetic_demo" | "google_places_context"`.
   - Registry enforces `analysisEligible: false` for `"google_places_context"` regardless of caller payload.
   - Fetches licensed facilities within `analysisArea.radiusMeters + maxCategoryRadiusMeters` (influence-radius buffer).
   - Evaluates bounded grid/kernel overlap cells and per-point accessibility $A \in [0, 100]$ with `categoryBreakdown`, `missingOrFailedCategories`, and `completeness: "complete" | "partial" | "unknown"`.
   - Separate `environmentalLayer` records (`epa_frs`) for user-controlled due diligence.
3. **Property Listings & On-Demand AVM (`/api/properties/search`, `/api/properties/:propertyId/avm`, `/api/sessions/:sessionId/expand`)**:
   - Distinct fields: `askingPrice`, `listingLastSeenAt`, `avmPrice`, `avmLow`, `avmHigh`, `avmFetchedAt`, `lastSalePrice`, `lastSaleDate`, `assessedValue`, `comparablesSummary` (with subject-duplication flag), `priceGap` (`gapPct`, `rangePosition`).
   - Session & global budget snapshot returned with every response (`globalRemaining`, `sessionListingsUsed`, `sessionAvmsUsed`, `sessionExpanded`, `durabilityMode`).
4. **Grounded Gemini Explanation (`POST /api/explain`)**:
   - Input: `{ sessionId: string, propertyId: string, preferences: PreferenceProfile }`.
   - Server computes all numbers and passes bounded eligible evidence (`evidenceId` map) to Gemini; validates returned JSON `{ summary, evidenceIds, positiveFactors, limitations, dataAsOf }` against server evidence and numbers. Falls back cleanly (`explanationAvailable: false`) without breaking deterministic analysis.
5. **Runtime Public Config (`GET /api/config`)**:
   - Exposes feature readiness flags, restricted `mapsBrowserKey` (if configured), default preference profile, and budget limits — **never** server API keys.

---

## 4. Staged Execution & Verification Order

1. **Stage 1 — Contracts, Provider Verification, Scoring Spec & Scaffold (`integrator`, `property`, `geospatial`)**:
   - `integrator` writes `PRD.md`, `ARCHITECTURE.md`, `API-CONTRACTS.md`, `package.json` + dependencies (`npm install`), and `src/shared/**` + server skeleton.
   - `property` verifies RentCast `/v1/listings/sale` & `/v1/avm/value` schemas and licensing, writes `DATA-SOURCES.md` and `ADR-001-rentcast.md`.
   - `geospatial` writes `SCORING.md` and pure deterministic scoring/geodesic/gap math in `src/server/geospatial/scoring.ts`.
2. **Stage 2 — Parallel Domain Implementation & Independent Contract Review**:
   - `property` implements `src/server/property/**` + `tests/property/**`.
   - `geospatial` implements `src/server/geospatial/**` + `tests/geospatial/**`.
   - `frontend` implements `src/client/**` + `tests/client/**`.
   - `explain` implements `src/server/explain/**` + `tests/explain/**` + `docs/AI_STUDIO_HANDOFF.md` + contract review.
   - `release` implements `Dockerfile`, `scripts/deploy-cloud-run.sh`, `docs/DEPLOYMENT.md`, `docs/PROVENANCE.md`, `docs/SUBMISSION-PACKAGE.md`.
   - `verifier` drafts `docs/TEST-PLAN.md` and performs **pre-integration inspection**.
3. **Stage 3 — Integration, Adversarial Verification, Local Smoke Run & Commit**:
   - Authors resolve any pre-integration findings from `verifier`.
   - `integrator` wires all routers in `src/server/app.ts`, verifies full TypeScript build (`npm run typecheck && npm run build`).
   - `verifier` executes full unit/integration/numerical/security test suite, `0.0.0.0:$PORT` startup check, browser/HTTP user-journey + provider-failure checks, README/doc link & formula parity checks, and records actual outputs in `docs/VERIFICATION-REPORT.md`.
   - `release` updates `docs/PROVENANCE.md` with final commit/test evidence and exact Cloud Run deployment blockers (`gcloud` CLI absent locally; GCP project/billing/Secret Manager credentials unprovided).

---

## 5. Actual Swarm Execution Ledger (Completed 2026-11-13 23:31 PT – 2026-11-14 00:56 PT)

| Member | Conversation ID | Model | Completed Board Posts & Audit Resolution |
|---|---|---|---|
| `coordinator` | `11d0d4d9-cb75-4ee7-bd5e-49b4d1351dd7` | `gemini-4-carbon-high` | Orchestrated Stages 1–3 (`#1`–`#4`, `#8`–`#13`, `#18`, `#22`–`#23`, `#26`); maintained `README.md` & `docs/SWARM-PLAN.md` |
| `monitor` | `9cb10404-b60b-4114-a722-19f5d1b09380` | `gemini-4-carbon-medium` | Active stall monitor (`0` stalls encountered) |
| `integrator` | `9c604ddf-fc95-429b-b1a3-5b5177084f0f` | `gemini-4-carbon-high` | Stage 1 contracts/scaffold (`#7`), `AUDIT-01..04,06` fixes (`#21`), Stage 3 full wiring & live `0.0.0.0` smoke test (`#25`) |
| `property` | `715c18a1-ce0d-4db8-8de4-6a669db2a539` | `gemini-4-argon-high` | Stage 1 RentCast/EPA/OSM docs & ADR-001 (`#5`), Stage 2 property/region/durable budget + `AUDIT-06` (`#19`, `#24`) |
| `geospatial` | `f61a0074-1205-45b4-824e-bb84bfccec5b` | `gemini-4-argon-high` | Stage 1 `SCORING.md` & pure math (`#6`), Stage 2 OSM/EPA providers, cache, grid overlap + `AUDIT-05,06` (`#20`) |
| `frontend` | `c95dc6a3-51a5-46d8-ab0c-fb92f74aa425` | `gemini-4-hydrogen-high` | Stage 2 React/Maps/SVG fallback UI, dual legends, preferences, `AbortController` cancellation & client tests (`#15`) |
| `explain` | `f6d13f10-7178-4180-8210-1707c0dcb181` | `gemini-3.8-flash-high` | Stage 2 `/api/explain` (`@google/genai`), validator, contract review, `AI_STUDIO_HANDOFF.md` (`PENDING`) (`#16`), `AUDIT-07,08` fixes (`#28`) |
| `release` | `b7b25227-0407-4354-a32c-c7785ce2f957` | `gemini-4-hydrogen-high` | Stage 2 `Dockerfile`, `scripts/deploy-cloud-run.sh`, `DEPLOYMENT.md`, `PROVENANCE.md`, `SUBMISSION-PACKAGE.md` (`#14`) |
| `verifier` | `16c27eff-a3e2-4ee9-9eda-ac4463cb19b5` | `gemini-4-carbon-high` | Stage 2 `TEST-PLAN.md` & pre-integration audit (`#17`), Stage 3 full adversarial verification (`13/13` suites, `105/105` tests, `0` open defects) (`#27`, `#29`) |

