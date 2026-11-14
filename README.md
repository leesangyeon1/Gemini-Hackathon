# Foreal-Estate

**Explainable US Real-Estate Location & Asking-vs-AVM Comparison Web Application**  
*Built for the Berkeley x DeepMind Hackathon (Fresh-Code Prototype — Generated November 13–14, 2026)*

Foreal-Estate helps home shoppers explore **any user-selected US location** (city/state, neighborhood, ZIP code, or bounded map area), evaluate **deterministic multi-category facility accessibility** from independently licensed public/open datasets, and compare **active residential asking prices against RentCast AVM point and range estimates** alongside explicit uncertainty and contrary evidence.

> **Important Disclaimers & Guardrails**
> - **Not an appraisal or investment advice:** RentCast AVM values are comparable-listing statistical estimates, not closed-sale truth or physical appraisals. Being below an AVM midpoint or range is a candidate signal for human due diligence, not proven undervaluation.
> - **Uncalibrated user preferences:** Accessibility weights and radii represent user-editable convenience preferences, never learned price premiums, and never multiply AVM estimates. Straight-line geodesic circles are not walking-time isochrones.
> - **Commercial & environmental neutrality:** Optional fast-food/brand context carries **zero default weight** and makes no causal appreciation claims. Environmental facility records (e.g., US EPA FRS) are surfaced strictly as a separate user-controlled due-diligence layer, never an automatic health determination. No demographic, resident, tenant, borrower, or protected-group scoring is performed.
> - **Strict data licensing:** Google Maps provides the basemap and optional attributed display-only Places context (`google_places_context`), which is rejected by the server source-policy registry from all spatial scoring, heatmaps, feature storage, and explanation evidence.

---

## Documentation Index

| Document | Scope & Single Source of Truth | Owner |
|---|---|---|
| [`docs/PRD.md`](docs/PRD.md) | User problem, MVP scope, user flows, UI states, non-claims, and acceptance criteria | `integrator` |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Full-stack TypeScript/Node system architecture, trust boundaries, caching, and secret isolation | `integrator` |
| [`docs/API-CONTRACTS.md`](docs/API-CONTRACTS.md) | Application HTTP request/response/error schemas, validation bounds, and stale-request semantics | `integrator` |
| [`docs/DATA-SOURCES.md`](docs/DATA-SOURCES.md) | External provider endpoints, licensing, attribution, coverage limits, and quota governance | `property` |
| [`docs/decisions/ADR-001-rentcast.md`](docs/decisions/ADR-001-rentcast.md) | Architecture Decision Record: RentCast as sole MVP property/AVM provider & budget controls | `property` |
| [`docs/SCORING.md`](docs/SCORING.md) | Geodesic distance math, linear kernels, saturation, unknown/partial rules, and `gapPct`/range formulas | `geospatial` |
| [`docs/SWARM-PLAN.md`](docs/SWARM-PLAN.md) | Swarm agents, pinned Gemini models, non-overlapping file ownership, staging, and integration order | `coordinator` |
| [`docs/AI_STUDIO_HANDOFF.md`](docs/AI_STUDIO_HANDOFF.md) | Google AI Studio Build handoff brief, contract snapshot, and status (`pending` unless executed) | `explain` |
| [`docs/TEST-PLAN.md`](docs/TEST-PLAN.md) | Functional, numerical, license-policy, security, budget, and browser verification plan | `verifier` |
| [`docs/VERIFICATION-REPORT.md`](docs/VERIFICATION-REPORT.md) | Executed test commands, exit codes, verified cases, and explicitly unverified/blocked items | `verifier` |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | Cloud Run (`0.0.0.0:$PORT`), Secret Manager bindings, scaling caps, verification, and rollback | `release` |
| [`docs/BUILD_PROVENANCE.md`](docs/BUILD_PROVENANCE.md) | Actual Antigravity CLI session, swarm roster, Gemini model usage, timestamps, and commit ledger | `release` |
| [`docs/SUBMISSION-PACKAGE.md`](docs/SUBMISSION-PACKAGE.md) | Berkeley x DeepMind Hackathon one-pagers, 2-min & 5-min pitch scripts, 1-min demo script, deadlines | `release` |

---

## Quick Start (Local Development)

### Prerequisites
- **Node.js** `>= 22` (verified on `v24.7.0`) and **npm** `>= 10` (verified on `11.7.0`)
- Copy `.env.example` to `.env` and populate only the environment variables you have licensed access to (never commit `.env` or secret values).

### Environment Variable Names (Values Never Stored in Repo)

| Variable Name | Visibility | Purpose |
|---|---|---|
| `PORT` | Server runtime | HTTP bind port (defaults to `8080`; binds `0.0.0.0`) |
| `RENTCAST_API_KEY` | **Server secret** (Secret Manager) | Server-side `X-Api-Key` for RentCast `/v1/listings/sale` and `/v1/avm/value` |
| `RENTCAST_GLOBAL_MONTHLY_LIMIT` | Server config | Hard cap below RentCast's 50-call monthly account allowance (default `35`) |
| `RENTCAST_INITIAL_SPENT_CALLS` | Server config | Already-spent provider calls on the account prior to deployment (default `0`) |
| `BUDGET_STORE_MODE` | Server config | `firestore` (Cloud Run durable atomic counter) or `sqlite` (local dev durable store) |
| `GOOGLE_CLOUD_PROJECT` | Server config | GCP project ID for Firestore durable budget counter / Cloud Run deployment |
| `GEMINI_API_KEY` | **Server secret** (Secret Manager) | Server-side key for `/api/explain` grounded structured explanations |
| `GEMINI_EXPLAIN_MODEL` | Server config | Runtime Gemini model preference (defaults to `gemini-4-hydrogen` with documented fallback) |
| `GOOGLE_MAPS_BROWSER_KEY` | Restricted browser key | HTTP-referrer-restricted Maps JS basemap key served via `/api/config` |
| `GOOGLE_PLACES_SERVER_KEY` | **Server secret** (optional) | Display-only Places context (`google_places_context`; barred from scoring) |
| `OSM_OVERPASS_URL` | Server config | Configured OSM endpoint or managed instance URL (paired with lawful caching/timeouts) |
| `ENABLE_SYNTHETIC_DEMO_MODE` | Server config | Enables opt-in, explicitly badged synthetic demo fixtures when live keys are absent (`true`/`false`) |

### Commands
```bash
npm install
npm run typecheck
npm test
npm run build
npm start
```

Missing API or Maps keys automatically render explicit **Setup Needed** states in the UI without failing startup, and deterministic accessibility/gap math remains usable even if runtime Gemini explanation is unavailable.
