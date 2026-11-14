# Build Provenance & Fresh-Code Ledger (`PROVENANCE.md`)

**Owner:** `release` (Workstream 6)  
**Project:** **Foreal-Estate** — Explainable US Real-Estate Location & Asking-vs-AVM Comparison Web Application  
**Event:** Berkeley x DeepMind Hackathon

---

## 1. Fresh-Code Generation Metadata

| Field | Recorded Value |
|---|---|
| **Orchestration Tool** | Antigravity CLI (`/Users/isang-yeon/.local/bin/agy`) |
| **Coordinator Conversation ID** | `11d0d4d9-cb75-4ee7-bd5e-49b4d1351dd7` |
| **Fresh-Code Generation Window** | `2026-11-13 23:28 PT` – `2026-11-14 00:57 PT` *(within the 24-hour fresh-code window prior to Nov 14, 2026 deadlines)* |
| **Runtime Toolchain** | Node.js `v24.7.0`, npm `11.7.0`, TypeScript `5.7.3`, Vite `6.4.6`, Vitest `3.2.7` |
| **Parent Git Commit at Swarm Start** | `8ecf1f3` (`Initial commit` on `main`) |
| **Google AI Studio Build Status** | **`PENDING`** — manual step required; handoff prepared in [`docs/AI_STUDIO_HANDOFF.md`](AI_STUDIO_HANDOFF.md), not executed |
| **Cloud Run Deployment Status** | **`BLOCKED / NOT DEPLOYED`** — `gcloud` CLI unconfigured/unauthenticated in workspace sandbox and GCP project/billing/Secret Manager credentials not provided (see [`docs/DEPLOYMENT.md`](DEPLOYMENT.md#7-current-deployment-blockers)) |

---

## 2. Actual Swarm Agents, Conversation IDs & Pinned Gemini Models

Recorded directly from the active swarm roster (`swarm{action:"status"}`) and [`docs/SWARM-PLAN.md`](SWARM-PLAN.md) Section 5. Only account-supported Gemini models were used; non-Gemini partner models were excluded per hackathon fresh-code rules.

| Agent Name | Swarm Role | Conversation ID | Pinned Model ID | Display Name | Primary File Ownership |
|---|---|---|---|---|---|
| `coordinator` | Coordinator | `11d0d4d9-cb75-4ee7-bd5e-49b4d1351dd7` | `gemini-4-carbon-high` | Gemini 4 Carbon (High) | `README.md`, `docs/SWARM-PLAN.md` |
| `monitor` | Stall Monitor | `9cb10404-b60b-4114-a722-19f5d1b09380` | `gemini-4-carbon-medium` | Gemini 4 Carbon (Medium) | Board stall monitoring only (`swarm_monitor`) |
| `integrator` | Worker (Architecture & Wiring) | `9c604ddf-fc95-429b-b1a3-5b5177084f0f` | `gemini-4-carbon-high` | Gemini 4 Carbon (High) | `docs/PRD.md`, `docs/ARCHITECTURE.md`, `docs/API-CONTRACTS.md`, `package*.json`, `tsconfig*.json`, `vite.config.ts`, `vitest.config.ts`, `.gitignore`, `.env.example`, `index.html`, `src/shared/**`, `src/server/{config,app,index}.ts` |
| `property` | Worker (Workstream 1: Property & Budget) | `715c18a1-ce0d-4db8-8de4-6a669db2a539` | `gemini-4-argon-high` | Gemini 4 Argon (High) | `docs/DATA-SOURCES.md`, `docs/decisions/ADR-001-rentcast.md`, `src/server/property/**`, `tests/property/**` |
| `geospatial` | Worker (Workstream 2: Geospatial & Scoring) | `f61a0074-1205-45b4-824e-bb84bfccec5b` | `gemini-4-argon-high` | Gemini 4 Argon (High) | `docs/SCORING.md`, `src/server/geospatial/**`, `tests/geospatial/**` |
| `frontend` | Worker (Workstream 3: Map & UI) | `c95dc6a3-51a5-46d8-ab0c-fb92f74aa425` | `gemini-4-hydrogen-high` | Gemini 4 Hydrogen (High) | `src/client/**`, `tests/client/**` |
| `explain` | Worker (Workstream 4: Grounded Explain & Handoff) | `f6d13f10-7178-4180-8210-1707c0dcb181` | `gemini-3.8-flash-high` | Gemini 3.8 Flash (High) | `docs/AI_STUDIO_HANDOFF.md`, `src/server/explain/**`, `tests/explain/**` |
| `verifier` | Worker (Workstream 5: Adversarial QA) | `16c27eff-a3e2-4ee9-9eda-ac4463cb19b5` | `gemini-4-carbon-high` | Gemini 4 Carbon (High) | `docs/TEST-PLAN.md`, `docs/VERIFICATION-REPORT.md`, `tests/verification/**` *(read-only on `src/**`)* |
| `release` | Worker (Workstream 6: Cloud Run & Submission) | `b7b25227-0407-4354-a32c-c7785ce2f957` | `gemini-4-hydrogen-high` | Gemini 4 Hydrogen (High) | `docs/DEPLOYMENT.md`, `docs/PROVENANCE.md`, `docs/SUBMISSION-PACKAGE.md`, `Dockerfile`, `.dockerignore`, `scripts/deploy-cloud-run.sh` |

---

## 3. Runtime Gemini Model Configuration (Application Code)

In the running Foreal-Estate server (`src/server/config.ts` and `.env.example`), `/api/explain` uses:
- **Primary Model (`GEMINI_EXPLAIN_MODEL`):** `gemini-4-hydrogen`
- **Fallback Model (`GEMINI_EXPLAIN_FALLBACK_MODEL`):** `gemini-2.5-flash`
- **Grounding Rule:** All coordinates, geodesic distances, category saturation scores, grid overlaps, `gapPct`, and `[avmLow, avmHigh]` positions are computed deterministically by TypeScript on the server. Gemini only generates structured JSON narratives validated against server-provided `evidenceIds` and server numbers (`explanationAvailable: false` on failure/unconfigured key).

---

## 4. Local Commit Preparation Ledger

| Item | Status / Value |
|---|---|
| **Parent Commit** | `8ecf1f3` (`Initial commit`) |
| **Commit Branch** | `main` |
| **Release Commit Timestamp (PT)** | `2026-11-14 00:57 PT` *(single local commit created immediately after Stage 3 verification; not pushed to remote)* |
| **Tracked Secret / Build Artifact Hygiene** | `.env`, `.env.*` (except `.env.example`), `node_modules/`, `dist/`, `.data/`, and `*.sqlite*` excluded via `.gitignore` and `.dockerignore` |

---

## 5. Stage 3 Verification Command Results Ledger

Recorded directly from executed Stage 3 outputs in [`docs/VERIFICATION-REPORT.md`](VERIFICATION-REPORT.md) (`AUDIT-01`..`AUDIT-08` all resolved, `0` open defects remaining):

| Check | Command | Status | Observed Result / Notes |
|---|---|---|---|
| TypeScript Check | `npm run typecheck` | **PASS (`exit 0`)** | `0` TS errors across client, shared contracts, server, and tests |
| Full Test Suite | `npm test` | **PASS (`exit 0`)** | **`13/13` test files passed, `105/105` tests passed**, `0` failed, `0` skipped/`todo` |
| Production Build | `npm run build` | **PASS (`exit 0`)** | Built `dist/client/` and `dist/server/index.js`; `0` secret names/values in `dist/client/**` |
| Compiled `0.0.0.0:$PORT` Startup | `startServer({ host: "0.0.0.0", port: 0 })` on `dist/server/index.js` | **PASS (`exit 0`)** | Bound `0.0.0.0` ephemeral port without API keys; served `dist/client/index.html` (`200 text/html`) |
| Markdown Link & Artifact Parity | Automated link parser across `14` Markdown files | **PASS (`exit 0`)** | `100%` of local Markdown links and documented artifacts resolve on disk |
| Deploy Script Preflight Check | `./scripts/deploy-cloud-run.sh` (unset env / limit `50`) | **PASS (`exit 1` fail-closed)** | Refuses deployment when `GOOGLE_CLOUD_PROJECT`, billing confirmation, or `< 50` limit is unmet |
| Google AI Studio Build | Manual handoff in [`docs/AI_STUDIO_HANDOFF.md`](AI_STUDIO_HANDOFF.md) | **PENDING (Manual Step Required)** | Prepared specification only; not executed |
| Cloud Run Live Deployment | `./scripts/deploy-cloud-run.sh` | **BLOCKED / NOT DEPLOYED** | `gcloud` unconfigured/unauthenticated in workspace sandbox; GCP project/billing/Secret Manager credentials not provided |
