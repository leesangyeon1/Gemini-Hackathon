# ADR-001: RentCast API as Sole MVP Property & AVM Provider with Durable Atomic Budget Governance

- **Status:** Accepted
- **Date:** 2026-11-13 / 2026-11-14
- **Owner:** `property` (Workstream 1)
- **Verification Date:** 2026-11-13 / 2026-11-14

---

## 1. Context & Problem Statement

Foreal-Estate requires real-time US residential for-sale property listings (asking prices, coordinates, structural attributes, and listing timestamps) and on-demand Automated Valuation Model (AVM) estimates (point estimate, low/high valuation range, and comparable listings) across **any user-selected US location**.

The engineering and compliance constraints for the Berkeley x DeepMind Hackathon MVP are strict:
1. **Self-Serve Developer Access & Lawful Licensing:** The provider must offer documented REST JSON endpoints with self-serve API keys and terms permitting consumer web application display and price-gap comparison without scraping consumer portals.
2. **Hard Monthly Free-Tier Protection:** Our RentCast developer account includes a **50-call monthly free tier** across the entire account, after which per-request overage billing applies. Some calls on the account may already be spent prior to deployment (`RENTCAST_INITIAL_SPENT_CALLS`).
3. **Stateless Container Restart Resilience:** On Google Cloud Run (and during local server restarts), in-memory counters reset whenever an instance restarts or scales horizontally. Relying on an in-memory counter could allow container restarts or concurrent requests to exceed the 50-call monthly free tier.
4. **Valuation Honesty:** The provider's AVM methodology and field semantics must be documented transparently so asking price (`askingPrice`), AVM midpoint (`avmPrice`), AVM uncertainty bounds (`avmLow`, `avmHigh`), last closed deed sale (`lastSalePrice`, `lastSaleDate`), and tax assessment (`assessedValue`) are never conflated.

---

## 2. Decision

We select **RentCast API (`https://api.rentcast.io/v1`, documented at `https://developers.rentcast.io`)** as the **sole live property and AVM provider** for the Foreal-Estate MVP, governed by a **server-side durable atomic budget store** and **strict per-session call caps**.

Specifically:
1. **Active Listings (`GET /v1/listings/sale`):** Executed only upon explicit user region confirmation (`POST /api/properties/search`), requesting `status=Active` and `limit=25` (`<= 25` homes per search) within the confirmed US analysis radius.
2. **On-Demand Per-Home AVM (`GET /v1/avm/value`):** Executed **only** when a user explicitly selects an individual property (`POST /api/properties/:propertyId/avm`), never pre-fetched in bulk for all 25 listings and never triggered by map pan/zoom events.
3. **Optional Recent Sales / Public Record Lookup (`GET /v1/properties`):** Reserved exclusively as an optional 1-call enrichment when a user explicitly triggers session expansion (`POST /api/sessions/:sessionId/expand`).
4. **Durable Atomic Budget Enforcement:** Every upstream RentCast request must first atomically reserve 1 credit inside a persistent transactional store (**Google Cloud Firestore** in production on Cloud Run; **SQLite via built-in `node:sqlite`** in local development) enforcing `RENTCAST_GLOBAL_MONTHLY_LIMIT < 50` (default **`35`**) after subtracting `RENTCAST_INITIAL_SPENT_CALLS` (default **`0`**).

---

## 3. Alternatives Considered & Excluded

| Candidate Provider | Evaluation Outcome | Evidence & Reason for Exclusion |
|---|---|---|
| **RentCast API** (`developers.rentcast.io`) | **Selected (Sole MVP Provider)** | Self-serve REST API covering 140M–150M+ US properties; clean separation of `/v1/listings/sale` (`price`, `lastSeenDate`), `/v1/avm/value` (`price`, `priceRangeLow`, `priceRangeHigh`, `comparables`), and `/v1/properties` (`lastSalePrice`, `lastSaleDate`, `taxAssessments`); permissive application licensing without mandatory branding; 50-call/month free tier manageable via durable atomic caps. |
| **ATTOM Data Solutions** | **Excluded** | Enterprise-oriented onboarding, annual licensing commitments, strict downstream attribution/redistribution clauses, and heavyweight multi-table schemas unnecessary for a rapid explainable MVP. |
| **Legacy Realty Mole Property API (RapidAPI)** | **Excluded (Shut Down)** | Verified on 2026-11-13/2026-11-14: Realty Mole rebranded into RentCast, and the legacy Realty Mole Property API on RapidAPI was permanently deprecated and shut down on **March 1, 2025**. |
| **Consumer Portal Scraping (Zillow / Redfin / Realtor.com)** | **Strictly Prohibited** | Violates website Terms of Service, anti-bot gates, and project legal/compliance guardrails. |

---

## 4. Verified Schema & Valuation Hygiene Rules

Verified against official RentCast API v1 documentation (`https://developers.rentcast.io`) on 2026-11-13 / 2026-11-14:

1. **Authentication:** Server-only `X-Api-Key` header (`RENTCAST_API_KEY`). Never transmitted to or callable from the browser.
2. **Comparable-Listing AVM Methodology:**
   - RentCast `/v1/avm/value` computes `price` (midpoint), `priceRangeLow`, and `priceRangeHigh` from nearby comparable listings returned in `comparables[]` (each with `id`, `formattedAddress`, `price`, `status`, `lastSeenDate`, `distance`, `correlation`, `daysOld`).
   - Because active listings can appear inside `comparables[]`, our ingestion pipeline checks whether any comparable matches the subject property (`id`, normalized `formattedAddress`, or distance `< 15m` with matching price) and sets `comparablesSummary.subjectIncludedInComps = true` so the UI and `/api/explain` surface circularity as contrary evidence.
3. **Distinct Price & Timestamp Fields:**
   - `askingPrice` (`GET /v1/listings/sale` -> `price`) and `listingLastSeenAt` (`lastSeenDate` / `listedDate`)
   - `avmPrice` (`GET /v1/avm/value` -> `price`), `avmLow` (`priceRangeLow`), `avmHigh` (`priceRangeHigh`), and `avmFetchedAt` (server UTC fetch timestamp)
   - `lastSalePrice` and `lastSaleDate` (`subjectProperty.lastSalePrice` / `lastSaleDate` or `/v1/properties`)
   - `assessedValue` (most recent year entry in `taxAssessments[YYYY].value`)
4. **PII Stripping:**
   - Owner PII (`owner.names`, `owner.mailingAddress`, `ownerOccupied`) and listing agent personal contact details (`agent.phone`, `agent.email`) are stripped on the server before caching or returning responses.

---

## 5. Durable Atomic Budget & Session Controls

### 5.1 Global Monthly Budget Formula

Let:
- $L_{\text{config}} = \text{ clamp}(\text{RENTCAST\_GLOBAL\_MONTHLY\_LIMIT}, 1, 49)$ (default **$35$**, strictly $< 50$)
- $S_{\text{initial}} = \max(0, \text{RENTCAST\_INITIAL\_SPENT\_CALLS})$ (default **$0$**, accounting for calls spent on the RentCast dashboard prior to deployment)
- $S_{\text{runtime}}$ = durable atomic counter of upstream RentCast HTTP requests made during the current UTC billing month (`YYYY-MM`)

Then total spent calls are:
$$S_{\text{total}} = S_{\text{initial}} + S_{\text{runtime}}$$

And remaining global budget is:
$$R_{\text{global}} = \max(0, L_{\text{config}} - S_{\text{total}})$$

An upstream call is permitted **if and only if** the durable store atomically verifies $S_{\text{total}} + 1 \le L_{\text{config}}$ and increments $S_{\text{runtime}} \leftarrow S_{\text{runtime}} + 1$ before the upstream request is dispatched.

### 5.2 Per-Session Call Caps (6 Calls Default / 12 Calls Expanded)

To prevent a single user session from exhausting the global monthly allowance:

| Session Tier | Max Listings Calls (`<= 25` homes/call) | Max Selected-Home AVM Calls | Max Optional Recent-Sales / Property Calls | Total Max Calls per Session |
|---|---|---|---|---|
| **Default Session** (`sessionExpanded: false`) | **1 call** | **5 calls** | **0 calls** | **6 calls** |
| **Explicitly Expanded Session** (`POST /api/sessions/:sessionId/expand`, `sessionExpanded: true`) | **1 call** | **10 calls** | **1 call** | **12 calls** |

Additional protections:
- **Zero Calls on Map Pan / Zoom / Marker Hover:** Map viewport movement never triggers `/v1/listings/sale` or `/v1/avm/value`.
- **Cache Deduplication before Budget Deduction:** Normalized region searches and `propertyId` AVM lookups check the server cache first. Cache hits return immediately with **0 provider calls** spent.
- **In-Flight Request Coalescing & Concurrency Cap:** Concurrent identical requests for the same `propertyId` or region share a single in-flight promise, and upstream RentCast concurrency is capped at **2 concurrent requests** with per-client rate limiting.

### 5.3 Multi-Instance & Container-Restart Durability

| Environment (`BUDGET_STORE_MODE`) | Backing Store | Atomic Reservation Mechanism | Restart & Multi-Instance Behavior |
|---|---|---|---|
| **Production (`firestore`)** | Google Cloud Firestore (`projects/$GOOGLE_CLOUD_PROJECT/databases/(default)/documents/rentcast_budget/$YYYY_MM`) | Firestore atomic `commit` / `runTransaction` with precondition on current `runtimeSpentCalls` | Survives Cloud Run scale-to-zero, container restarts, and multi-instance concurrency (`--max-instances=2`) |
| **Local Dev (`sqlite`)** | Built-in Node.js v24 `node:sqlite` (`DatabaseSync` persisted to `.data/rentcast-budget.sqlite`) | `BEGIN IMMEDIATE` transaction checking and incrementing `runtime_spent_calls` + `sessions` table | Survives local dev server restarts (`tsx` / `npm start`) without native `node-gyp` dependencies |

**Fail-Closed Guarantee:** If `BUDGET_STORE_MODE=firestore` is configured in production and Firestore fails or rejects the transaction, the budget manager **fails closed** (refuses to call RentCast and returns a structured `quota_exhausted` / `budget_store_error` status while allowing cached results and opt-in badged `synthetic_demo` mode).

---

## 6. Tradeoffs & Consequences

- **Positive:**
  - Zero risk of accidental overage charges beyond the 50-call monthly free tier, even across container restarts or concurrent requests.
  - A single full exploration session uses at most 6 calls (1 listing search + up to 5 home AVMs), allowing at least 5–6 complete live user journeys within the default 35-call budget (plus unlimited repeat inspections via server cache and opt-in badged synthetic demo mode).
  - Clear provenance separation prevents misleading valuation claims.
- **Negative / Limitations:**
  - Only the Homes explicitly clicked by the user receive an AVM badge (`avmPrice`, `avmLow`, `avmHigh`, `gapPct`), while unselected markers display `askingPrice` and deterministic accessibility $A$ with status `"no_avm"` until selected.
  - RentCast's AVM is a statistical comparable-listing model rather than a physical appraisal; wide `[avmLow, avmHigh]` ranges or `subjectIncludedInComps: true` require explicit user caution.

---

## 7. Review Triggers

This ADR should be revisited if:
1. The project upgrades to a paid RentCast commercial tier (`>= 1,000` calls/month), allowing higher session AVM caps or background pre-enrichment.
2. Licensed closed-sale MLS feeds or institutional appraisal APIs are integrated alongside RentCast.
3. Multi-region active-active Cloud Run deployments require regional quota reservations.
