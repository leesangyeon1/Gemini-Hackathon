# Build Provenance & Fresh-Code Ledger (`BUILD_PROVENANCE.md`)

**Owner:** `release` (Workstream 6 / Phase 4–5 Release, GCP & Live Probe Owner)  
**Project:** **Foreal-Estate** — Explainable US Real-Estate Location & Asking-vs-AVM Comparison Web Application  
**Event:** Berkeley x DeepMind Hackathon

---

## 1. Fresh-Code Generation Metadata

| Field | Recorded Value |
|---|---|
| **Orchestration Tool** | Antigravity CLI (`/Users/isang-yeon/.local/bin/agy`) |
| **Coordinator Conversation ID** | `11d0d4d9-cb75-4ee7-bd5e-49b4d1351dd7` |
| **Fresh-Code Generation Window** | `2026-11-13 23:28 PT` – `2026-11-14 PT` *(within the 24-hour fresh-code window prior to Nov 14, 2026 deadlines)* |
| **Runtime Toolchain** | Node.js `v24.7.0`, npm `11.7.0`, TypeScript `5.7.3`, Vite `6.4.6`, Vitest `3.2.7`, Google Cloud SDK `593.0.0`, Google Chrome `156.0.8078.82` |
| **Parent Git Commit at Swarm Start** | `8ecf1f3` (`Initial commit` on `main`) |
| **Stage 3 Integration Commit** | `1a4230db02e884c2fa2ff94a7b517784557e4e6e` (`feat: implement Foreal-Estate MVP, verification suite, and release docs`) |
| **Google AI Studio Build Status** | **`EXECUTED, EXPORTED & INTEGRATED`** — `gemini-4-hydrogen` (Thinking enabled, `15,012` session tokens, `qcd2529@gmail.com` ULTRA tier) via `https://aistudio.google.com/prompts/new_chat` (`2026-11-14T14:02:18Z`); exported to `<scratch>/ai-studio-AccessibleLegends.tsx`, integrated by `frontend` into `src/client/components/AccessibleLegends.tsx`, `src/client/styles/app.css`, and `src/client/App.tsx`, and verified in `jsdom` + real Chrome `156.0.8078.82` (see [`docs/AI_STUDIO_HANDOFF.md`](AI_STUDIO_HANDOFF.md)) |
| **Cloud Run Deployment Status** | **`BLOCKED / NOT DEPLOYED`** — active account `qcd2529@gmail.com` has `0` billing accounts, `billingEnabled: false` on both discovered projects (`gen-lang-client-0222559199`, `gen-lang-client-0582732543`), and `run.googleapis.com` / `secretmanager.googleapis.com` disabled (see [`docs/DEPLOYMENT.md`](DEPLOYMENT.md#7-current-deployment-blockers)) |

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
| `release` | Worker (Workstream 6 / Phase 4–5 Release, GCP & Live Probe) | `b7b25227-0407-4354-a32c-c7785ce2f957` | `gemini-4-hydrogen-high` | Gemini 4 Hydrogen (High) | `docs/DEPLOYMENT.md`, `docs/BUILD_PROVENANCE.md`, `docs/SUBMISSION-PACKAGE.md`, `Dockerfile`, `.dockerignore`, `.gcloudignore`, `scripts/deploy-cloud-run.sh`, `scripts/provision-gcp-resources.sh`, `scripts/verify-live-providers.mjs` |

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
| **Initial Repo Parent Commit** | `8ecf1f3` (`Initial commit`) |
| **Stage 3 Integration Commit** | `1a4230db02e884c2fa2ff94a7b517784557e4e6e` (`feat: implement Foreal-Estate MVP, verification suite, and release docs`) |
| **Phase 4 Hardening Commit** | `83fd38280e1942811fd11641cbcc7d664a32c0ed` (`chore(release): harden Cloud Run config, add GCP provisioning helper, and consolidate provenance`) |
| **Commit Branch** | `main` |
| **Phase 5 Commit Timestamp (PT)** | `2026-11-14 06:19 PT` *(clean local commit after Phase 5 durable sessions, `409 SESSION_EXPIRED`, `us-west1` + verified secret versions, AI Studio `AccessibleLegends` integration, and separate real Chrome 156 E2E verification; not pushed to remote)* |
| **Tracked Secret / Build Artifact Hygiene** | `.env`, `.env.*` (except `.env.example` in git), `node_modules/`, `dist/`, `.data/`, and `*.sqlite*` excluded via `.gitignore`, `.dockerignore`, and `.gcloudignore` |

---

## 5. Stage 3, Phase 4 & Phase 5 Verification Command Results Ledger

Recorded directly from executed outputs in [`docs/VERIFICATION-REPORT.md`](VERIFICATION-REPORT.md) (`AUDIT-01`..`AUDIT-08` and `AUDIT-CR-01`..`AUDIT-CR-03` all resolved, `0` open defects remaining; `jsdom`, real Chrome 156 local, and public Cloud Run results strictly separated):

| Check | Command / Environment | Status | Observed Result / Notes |
|---|---|---|---|
| TypeScript Check | `npm run typecheck` | **PASS (`exit 0`)** | `0` TS errors across client (including AI-Studio `AccessibleLegends.tsx`), shared contracts, server, and tests |
| Full Test Suite (`node` + `jsdom`) | `npm test` | **PASS (`exit 0`)** | **`13/13` test files passed, `112/112` tests passed** (`96` `node`, `16` `jsdom`), `0` failed, `0` skipped/`todo` |
| Production Build | `npm run build` | **PASS (`exit 0`)** | Built `dist/client/` and `dist/server/index.js`; `0` secret names/values in `dist/client/**` |
| Compiled `0.0.0.0:$PORT` Startup | `startServer({ host: "0.0.0.0", port: 0 })` on `dist/server/index.js` | **PASS (`exit 0`)** | Bound `0.0.0.0` ephemeral port without API keys; served `dist/client/index.html` (`200 text/html`) |
| Separate Real Chrome `156.0.8078.82` Local E2E (`E2E-CHROME-01`) | `dist/server/index.js` (`127.0.0.1:61661`, `ENABLE_SYNTHETIC_DEMO_MODE=true`) via `DevToolsActivePort` CDP WebSocket | **PASS (`exit 0`)** | Verified `setup_needed`, AI-Studio `AccessibleLegends` (`aria-expanded` toggle + `4` `source-badge-*` pills), opt-in `synthetic_demo`, `Springfield` disambiguation, `709 px × 479 px` interactive `<svg>` (`34` `<circle>`s), `$900k/$1M` `in_range` AVM + contrary evidence, and `/api/explain` deterministic fallback |
| Markdown Link & Artifact Parity | Automated link parser across `14` Markdown files | **PASS (`exit 0`)** | `100%` of local Markdown links (`docs/BUILD_PROVENANCE.md`, `.gcloudignore`, etc.) resolve on disk |
| Deploy & Provision Preflight Checks | `./scripts/deploy-cloud-run.sh`, `./scripts/provision-gcp-resources.sh` | **PASS (`exit 1` fail-closed)** | `bash -n scripts/*.sh` passes; both fail closed when `GOOGLE_CLOUD_PROJECT`, billing, or `< 50` limit is unmet; `deploy-cloud-run.sh` resolves `ENABLED` numeric secret versions |
| Live Provider & Model Probe | `node scripts/verify-live-providers.mjs` | **PASS (`exit 0`, unconfigured)** | Reports `GOOGLE_MAPS_BROWSER_KEY`, `GOOGLE_PLACES_SERVER_KEY`, `RENTCAST_API_KEY`, `GEMINI_API_KEY` as `MISSING (not probed)`; `0` RentCast calls spent |
| Google AI Studio Build & Integration | `https://aistudio.google.com/prompts/new_chat` (`gemini-4-hydrogen`, `15,012` tokens) | **EXECUTED, EXPORTED & INTEGRATED** | Integrated into `src/client/components/AccessibleLegends.tsx`, `src/client/styles/app.css`, and `src/client/App.tsx`; verified in `jsdom` + real Chrome `156.0.8078.82` |
| Public Cloud Run Service Verification | `./scripts/deploy-cloud-run.sh` & live `*.run.app` smoke | **NOT RUN / BLOCKED (`BLOCKED / NOT DEPLOYED`)** | Rechecked `2026-11-14 05:44 PT`: `qcd2529@gmail.com` still has `0` billing accounts and `billingEnabled: false` on both projects (see [`docs/DEPLOYMENT.md`](DEPLOYMENT.md#7-current-deployment-blockers)) |
