# Berkeley x DeepMind Hackathon Submission Package (`SUBMISSION-PACKAGE.md`)

**Owner:** `release` (Workstream 6)  
**Project:** **Foreal-Estate** — Explainable US Real-Estate Location & Asking-vs-AVM Comparison Web Application  
**Target Deadlines (Pacific Time):**
- **In-person submission deadline:** **November 14, 2026 at 10:30 AM PT**
- **Online-only submission deadline:** **November 14, 2026 at 11:59 PM PT**

> [!CAUTION]
> **Current Submission Status & Pre-Submit Checklist (Do Not Skip)**
> 1. **Nothing Submitted or Posted:** **No videos have been recorded or posted, and no submission forms have been submitted.**
> 2. **Track Confirmation & Social Tracking Duration Conflict:** Confirm your intended submission track (**In-person** vs. **Online-only**) and verify the **social-media tracking duration conflict (`7 days` vs. `2 weeks`) directly on the official hackathon submission form** before checking any consent or posting agreement.
> 3. **VC Prize Clarification:** The VC prize listed by the event is a **VC meeting**, **not** guaranteed funding or an investment commitment.
> 4. **Organizer & Marketing Consent Control:** Organizer/marketing data-sharing and promotional consents remain **strictly under the user's control** — review every checkbox on the official form manually before submitting.
> 5. **Hosted Prototype URL Status:** **`DEPLOYED & LIVE`** at **`https://foreal-estate-uh6bu7tikq-uw.a.run.app`** (regional URL: `https://foreal-estate-1059527957241.us-west1.run.app`, GCP project `foreal-estate-514714`, region `us-west1`; see [`docs/DEPLOYMENT.md`](DEPLOYMENT.md#7-live-cloud-run-deployment-record) and [`docs/BUILD_PROVENANCE.md`](BUILD_PROVENANCE.md)).

---

## (a) Plain-Text One-Pagers

### 1. Team One-Pager (Plain Text — Fill Bracketed Placeholders Only)

```text
TEAM NAME: [PLACEHOLDER: Team Name]
PROJECT NAME: Foreal-Estate
TRACK: [PLACEHOLDER: Confirm "In-person (Nov 14, 10:30 AM PT)" OR "Online-only (Nov 14, 11:59 PM PT)"]
CONTACT EMAIL / HANDLE: [PLACEHOLDER: Primary Contact Email & Social Handle]
REPOSITORY / DEMO LINKS:
- Source Repository: [PLACEHOLDER: GitHub / Git Repo URL]
- Hosted Cloud Run URL: https://foreal-estate-uh6bu7tikq-uw.a.run.app (regional: https://foreal-estate-1059527957241.us-west1.run.app — GCP project foreal-estate-514714, region us-west1)
- 2-Min Team/Pitch Video: NOT YET RECORDED OR POSTED
- 1-Min Prototype Playcast Video: NOT YET RECORDED OR POSTED

TEAM MEMBERS:
- [PLACEHOLDER: Member 1 Full Name] — [PLACEHOLDER: Role, e.g., Full-Stack / Geospatial / ML Engineering] — [PLACEHOLDER: School / Program / Organization & Graduation Year or Background]
- [PLACEHOLDER: Member 2 Full Name (or remove if solo)] — [PLACEHOLDER: Role] — [PLACEHOLDER: Background]

WHY THIS TEAM:
[PLACEHOLDER: 2-3 factual sentences describing why the team members chose real-estate location transparency and deterministic + grounded AI workflows, using only verified personal experience.]

ORGANIZER & MARKETING CONSENT PREFERENCES:
- Social tracking duration notice: Verify whether official form states 7 days or 2 weeks before opting in.
- Organizer/marketing communication consent: [PLACEHOLDER: User decision at form submission time]
```

### 2. Idea One-Pager (Plain Text)

```text
PROJECT TITLE: Foreal-Estate
ONE-LINE SUMMARY: Explainable US real-estate location convenience and asking-vs-AVM comparison powered by deterministic open-data spatial scoring and server-grounded Gemini explanations.

PROBLEM:
Home shoppers comparing listings in unfamiliar US cities face three gaps:
1. Opaque "walkability" scores hide which categories matter (groceries, parks, transit, healthcare, schools) and mix convenience with unverified environmental assumptions.
2. Headline asking prices and Automated Valuation Models (AVMs) often hide wide estimate ranges, comparable-listing circularity (active listings appearing in their own comps), and stale listing dates.
3. Unconstrained AI property summaries hallucinate distances, invent neighborhood claims, or conflate user lifestyle preferences with market appreciation.

SOLUTION (WHAT IS ACTUALLY BUILT):
Foreal-Estate is a full-stack TypeScript/Node + React web application working across any user-selected US location (city/state, neighborhood, ZIP code, or bounded map circle) — never hardcoded to one city:
1. US Coverage Gate & Ambiguity Disambiguation: Resolves US locations via US Census Geocoder / OSM Nominatim, disambiguates multi-state names (e.g., "Springfield"), rejects non-US queries cleanly, and labels every region as a circular viewport approximation rather than an official boundary polygon.
2. License-Compliant Open Spatial Scoring: Fetches OSM amenities (Overpass API, ODbL) with an influence-radius buffer to avoid edge clipping, computes deterministic WGS84 geodesic distances, linear distance-decay kernels, saturation caps, and regular-grid Venn-like multi-category overlap zones. Missing/failed categories remain explicitly "unknown" / "partial" rather than silently renormalizing or faking zero. Optional commercial/fast-food context defaults to 0 weight with zero causal appreciation claims.
3. Separate Environmental Due-Diligence Layer: Queries US EPA Facility Registry Service (FRS) records into an independent toggleable layer — never merged silently into positive amenity scores and never making automated health determinations.
4. Strict Google Maps ToS Isolation: Google Maps JS provides the basemap via an HTTP-referrer-restricted browser key; optional display-only Places context (`google_places_context`) is barred by a frozen server source-policy registry from scoring, heatmaps, storage, and AI prompts.
5. On-Demand Asking-vs-AVM Comparison & Contrary Evidence: Fetches RentCast active listings (`<= 25`) and on-demand single-home AVM point + `[avmLow, avmHigh]` estimates protected by a durable atomic budget store (Firestore on Cloud Run, built-in `node:sqlite` locally) capped below RentCast's 50-call monthly free tier. Displays `gapPct = 100 * (avmPrice - askingPrice) / avmPrice` alongside `[avmLow, avmHigh]` range position, last deed sale, tax assessment, and contrary evidence (such as subject-in-comps circularity).
6. Server-Grounded Gemini Explanation (`/api/explain`): Server computes all math and passes bounded eligible `evidenceIds` to Gemini (deployed on Cloud Run with Vertex AI `gemini-3.8-flash` primary and `gemini-3.5-flash` fallback; code defaults `gemini-4-hydrogen` / `gemini-2.5-flash`). Returned structured JSON is validated against server facts and falls back cleanly if Gemini is unavailable.

NON-CLAIMS & SAFETY:
- Not an appraisal, brokerage feed, or investment advice; AVM is a statistical estimate.
- Accessibility scores reflect uncalibrated user preferences, never market dollars, and never multiply AVM estimates.
- Zero demographic, resident, tenant, borrower, crime-index, or protected-group scoring.

CURRENT PROTOTYPE STATUS:
- Fresh-code prototype built during the Nov 13-14, 2026 hackathon window via Antigravity CLI.
- Supports live API keys as well as explicit opt-in badged synthetic demo mode (`ENABLE_SYNTHETIC_DEMO_MODE=true`).
- Deployed & live on Google Cloud Run (`https://foreal-estate-uh6bu7tikq-uw.a.run.app`, project `foreal-estate-514714`, region `us-west1`); zero external user traction claimed.
```

---

## (b) Factual 2-Minute Team / Pitch Script (~270 Words)

> **Usage Note:** Not yet recorded or posted. Replace `[PLACEHOLDER: ...]` before recording.

```text
[0:00 - 0:25 | Team & Problem]
Hi, I'm [PLACEHOLDER: Your Name] [PLACEHOLDER: and teammates, if applicable]. We built Foreal-Estate for the Berkeley x DeepMind Hackathon.
When shoppers look at homes in an unfamiliar US city, two things break down fast: first, opaque neighborhood scores hide what actually matters to your daily routine and blur convenience with environmental due diligence. Second, portals show an asking price next to a single AVM number without showing the estimate's uncertainty band, whether the listing itself leaked into its own comps, or whether an AI summary just invented the math.

[0:25 - 1:05 | How Foreal-Estate Works]
Foreal-Estate works across any US city, ZIP code, or bounded map circle. First, we resolve and disambiguate the US area explicitly, rejecting non-US locations and labeling every search area honestly as a circular viewport approximation.
Next, a deterministic TypeScript engine computes WGS84 geodesic accessibility across groceries, parks, transit, healthcare, and schools using licensed OpenStreetMap data, while keeping US EPA Facility Registry Service records in a completely separate due-diligence layer. Optional commercial context defaults to zero weight, and a server-enforced source-policy registry unconditionally blocks Google Places display context from entering any score, heatmap, or AI prompt.

[1:05 - 1:40 | On-Demand Valuation & Grounded Gemini]
When a shopper selects a specific home, we fetch RentCast's AVM point estimate and low-high range on demand—protected by a durable atomic budget store in Firestore or local SQLite so free-tier limits are never exceeded on map pans or restarts. We compute the percentage gap alongside the uncertainty band and contrary evidence, like wide spreads or subject-in-comps circularity. Finally, Gemini generates a structured explanation strictly bound to server-verified evidence IDs—never doing math itself.

[1:40 - 2:00 | Honest Status & Close]
Foreal-Estate is a fresh-code hackathon prototype built in TypeScript, Node 24, React, and Express, with explicit setup-needed and opt-in badged synthetic demo states. Thank you.
```

---

## (c) 1-Minute Prototype / Playcast Script (~145 Words)

> **Optional Narration Note:** Not yet recorded or posted. Optional `gemini-3.8-flash-tts` narration is noted as an unrecorded optional capability for generating voiceover audio if desired before submission; no audio/video has been generated or uploaded.

```text
[0:00 - 0:12 | Location Search & Disambiguation]
Screen: Search bar in Foreal-Estate. Type "Springfield" -> shows US candidate disambiguation (Springfield, IL / MO / MA). Select one, or search any US city like "Austin, TX", and click "Analyze area."
Voiceover: "Foreal-Estate supports any US city or ZIP code, disambiguating matches before spending any property API budget."

[0:12 - 0:30 | Map, Licensed Layers & Overlap Grid]
Screen: Map displays active listings, toggleable OSM amenity layers, the bounded grid Venn overlap overlay, and the separate EPA FRS environmental due-diligence toggle. Adjust a preference slider (e.g., Transit weight) while showing Commercial/Fast-Food defaulted to 0.
Voiceover: "Deterministic geodesic kernels score your exact convenience weights from OpenStreetMap, while EPA facility records stay in a separate due-diligence layer."

[0:30 - 0:50 | Home Selection, AVM Range & Contrary Evidence]
Screen: Click one home card -> detail drawer loads `askingPrice`, `avmPrice`, `[avmLow, avmHigh]`, `gapPct`, range badge (`in_range` vs. `below_estimate_range_candidate`), and contrary evidence warnings.
Voiceover: "Clicking a home runs an on-demand RentCast AVM check under an atomic budget cap, surfacing uncertainty bands and contrary evidence."

[0:50 - 1:00 | Grounded Gemini Explanation]
Screen: Click "Explain this comparison" -> structured summary with clickable/referenced `evidenceIds` and explicit non-appraisal disclaimer.
Voiceover: "Gemini explains only server-computed facts and verified evidence IDs—transparent real-estate analysis, zero black boxes."
```

---

## (d) Accessible Live Prototype, Code & Local Review Instructions

Reviewers and judges can evaluate the **live hosted Cloud Run prototype (`DEPLOYED & LIVE`)** directly at **`https://foreal-estate-uh6bu7tikq-uw.a.run.app`** (regional URL: `https://foreal-estate-1059527957241.us-west1.run.app`, GCP project `foreal-estate-514714`, region `us-west1`), or inspect and run the full prototype locally in minutes:

### 1. Prerequisites
- **Node.js `>= 22.5.0`** (verified on `v24.7.0`) and **npm `>= 10`** (verified on `11.7.0`).
- Zero native C++ / `node-gyp` build dependencies required (`node:sqlite` is built into Node 24).

### 2. Local Setup & Verification Commands
```bash
# Install dependencies
npm install

# Verify TypeScript types (client, shared, server)
npm run typecheck

# Run automated unit, security, scoring, and API integration tests
npm test

# Build production client (dist/client) and server (dist/server/index.js)
npm run build
```

### 3. Running Locally (Live Keys OR Opt-In Badged Synthetic Demo Mode)
- **Option A — Setup-Needed / Deterministic Spatial Mode (No Keys Required):**
  ```bash
  PORT=8080 npm start
  ```
  Open `http://127.0.0.1:8080`. Missing keys surface explicit `setup_needed` guidance (variable names only) without crashing startup.
- **Option B — Opt-In Badged Synthetic Demo Mode (No Paid Keys Required):**
  ```bash
  ENABLE_SYNTHETIC_DEMO_MODE=true PORT=8080 npm start
  ```
  Allows explicitly badged synthetic demo exploration (`SYNTHETIC DEMO DATA — NOT LIVE MARKET LISTINGS`) without consuming RentCast or Gemini quota.
- **Option C — Live API Mode:**
  Copy `.env.example` to `.env`, set `RENTCAST_API_KEY`, `GEMINI_API_KEY`, and optionally an HTTP-referrer-restricted `GOOGLE_MAPS_BROWSER_KEY`, then run `npm start`.
- **Health & Config Endpoints:**
  - `GET http://127.0.0.1:8080/api/health`
  - `GET http://127.0.0.1:8080/api/config`

---

## (e) 5-Minute Pitch & Judge Q&A Preparation

### 5-Minute Pitch Outline
1. **0:00–0:45 — Problem & User Pain:** Shoppers face opaque walkability scores, uncontextualized AVM point estimates, and ungrounded AI real-estate summaries.
2. **0:45–1:45 — Live Demo Walkthrough (or Playcast):** Any-US-location resolution & disambiguation -> explicit budget-gated Analyze Area -> deterministic multi-category Venn overlap & separate EPA FRS layer -> on-demand RentCast AVM + `[avmLow, avmHigh]` + contrary evidence -> grounded `/api/explain`.
3. **1:45–3:00 — Technical Architecture & Trust Boundaries:**
   - Single Node 24 + Express + React/Vite service (`0.0.0.0:$PORT`).
   - Frozen server source-policy registry (`google_places_context` hard-rejected from scoring/heatmaps/storage/explain).
   - Durable atomic budget store (`node:sqlite` locally, Firestore REST transactions on Cloud Run) protecting a `< 50`-call RentCast monthly cap across restarts.
   - Server-first Gemini grounding: Gemini never performs math and every returned `evidenceId` is validated server-side.
4. **3:00–4:00 — Ethical & Compliance Guardrails:** No hardcoded city; viewport circle != official boundary; geodesic radius != walking isochrone; fast-food default weight `0` with zero causal appreciation claims; no demographic/protected-class scoring; AVM != appraisal.
5. **4:00–5:00 — Roadmap & Honest Status:** Multi-stage verification suite, live Cloud Run deployment (`https://foreal-estate-uh6bu7tikq-uw.a.run.app`, `us-west1`) with Firestore atomic quota caps and Secret Manager isolation, and clear path from MVP to real-world buyer/agent workflows.

### Judge Q&A Mapping (All 5 Evaluation Dimensions)

| Criterion | Anticipated Judge Question | Grounded, Factual Answer |
|---|---|---|
| **1. Feasibility** | *How do you keep AI from hallucinating prices/distances and prevent runaway API bills on free tiers?* | All distances (WGS84 geodesic), linear kernels, grid overlaps, `gapPct`, and `[avmLow, avmHigh]` checks run in deterministic TypeScript on the server. Gemini (`/api/explain`) only narrates server-verified `evidenceIds` and degrades cleanly if unavailable. RentCast calls require explicit user clicks (never on map pan) and atomic credit reservation in Firestore (`BUDGET_STORE_MODE=firestore`) or built-in `node:sqlite` with `RENTCAST_GLOBAL_MONTHLY_LIMIT < 50`. |
| **2. Novelty** | *How is this different from Zillow/Redfin or generic LLM property wrappers?* | Instead of opaque black-box neighborhood scores or ungrounded chat, Foreal-Estate combines: (a) user-editable multi-category Venn overlap zones computed strictly from ODbL OpenStreetMap data, (b) a separate non-merged US EPA FRS due-diligence layer, (c) explicit AVM uncertainty & **subject-in-comps circularity detection** as contrary evidence, and (d) a strict server source-policy registry enforcing Google Maps Platform Section 3.2.3 compliance. |
| **3. Applicability** | *Does this only work in one demo city, and who uses it today?* | It works across **any US city, neighborhood, ZIP code, or bounded map circle** using US Census Geocoder, OSM Nominatim/Overpass, US EPA FRS, and RentCast—never hardcoded to Berkeley. It serves homebuyers, relocating families, and buyer's agents performing structured location and pricing due diligence, while explicitly disclaiming that it is not an appraisal or financial advice. |
| **4. Fundability** | *What is the business/monetization path beyond a hackathon prototype (noting VC prize is a meeting, not guaranteed funding)?* | Near-term SaaS/usage tiers for relocating homebuyers and buyer-side brokerages needing auditable location + comps due-diligence briefs, moving from developer API tiers to commercial RentCast/managed Overpass/Places Aggregate licensing as usage scales. We view a **VC meeting** as an opportunity to validate unit economics around licensed data costs and B2B2C brokerage distribution. |
| **5. Honest Prototype Traction** | *What traction, users, or live deployment metrics do you have right now?* | **Zero fabricated traction:** This is a fresh-code hackathon prototype created on Nov 13–14, 2026 (`11d0d4d9-cb75-4ee7-bd5e-49b4d1351dd7`). It is **`DEPLOYED & LIVE`** on Google Cloud Run at `https://foreal-estate-uh6bu7tikq-uw.a.run.app` (`foreal-estate-514714`, `us-west1`), with zero active external users, revenue, or published social engagement metrics claimed. |
