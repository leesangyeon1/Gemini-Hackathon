# Google AI Studio Build Handoff: Foreal-Estate Frontend UI

> **Status: PENDING (Manual Step Required — Not Executed)**
>
> [!WARNING]
> **Provenance & Integrity Notice**: In this autonomous CLI environment, there is no direct browser/MCP integration with Google AI Studio Build. Therefore, this document serves strictly as a **prepared handoff specification** for an operator to execute manually in Google AI Studio if desired. **Never claim AI Studio was used merely because this handoff document exists.** Any actual execution must record authentic provenance in the section below prior to verification.

---

## 1. Overview & Operational Role

`Foreal-Estate` is an explainable US real-estate location and asking-vs-AVM comparison web application.
This handoff specification equips a human engineer or automated AI Studio Build session to refine, style, or enhance the React 18 client (`src/client/**`) within Google AI Studio while strictly adhering to shared API contracts, data boundaries, and security rules.

---

## 2. Exact AI Studio Build Brief & Ready-to-Paste Prompt Package

### 2.1 Canonical One-Sentence Brief
```text
Continue Foreal-Estate; change only assigned map/list/detail components; support user-entered US regions, separate accessibility and price-gap legends, source dates, provider errors, empty/partial results, keyboard/mobile interaction, and cancellation of stale requests. Do not invent financial data or expose server secrets. Return changed files and checks for integration.
```

### 2.2 Ready-to-Paste Multi-Turn AI Studio Session Prompt
When opening a new session in [Google AI Studio](https://aistudio.google.com) (recommended model: `gemini-2.5-pro` or `gemini-2.5-flash`), paste the prompt block below:

```text
You are continuing the frontend UI implementation for "Foreal-Estate" (an explainable US real-estate location and asking-vs-AVM comparison web application).

PROJECT CONTEXT & CONSTRAINTS:
1. FILE SCOPE: You own and may edit ONLY files under `src/client/**` (e.g. `src/client/components/**`, `src/client/styles/**`, `src/client/App.tsx`). Do NOT touch `package.json`, server files (`src/server/**`), or shared contracts (`src/shared/**`).
2. SERVER AUTHORITY: All valuation figures (askingPrice, avmPrice, avmLow, avmHigh, priceGap) and geospatial scores come directly from the server API (`/api/properties/search`, `/api/properties/:id/avm`, `/api/geospatial/analyze`, `/api/explain`). Never invent, calculate, or override valuation data on the client.
3. SECRET ISOLATION: Server secrets (RENTCAST_API_KEY, GEMINI_API_KEY, GOOGLE_PLACES_SERVER_KEY) never enter client code. The only client key is the restricted GOOGLE_MAPS_BROWSER_KEY obtained via `GET /api/config`.
4. NON-CLAIMS & LEGENDS:
   - Provide two separate, colorblind-safe visual legends: (1) Deterministic Accessibility Score (0–100, linear kernel on OSM amenities), (2) Asking-vs-AVM Price Gap (+% gap, range classification).
   - EPA FRS records are a separate due-diligence layer, never merged into amenity scores.
   - Fast-food / brand density defaults to 0 weight and carries no causal property appreciation claims.
   - Places context (`google_places_context`) is display-only context; never pass it to scoring or explain.
5. REQUIRED UI STATES:
   - Handle: `ready`, `loading`, `empty`, `partial`, `unsupported_area`, `setup_needed`, `quota_exhausted`, `timeout`, `recovery`, `synthetic_demo`.
   - Stale-request cancellation using AbortController and monotonic `clientRequestSeq`.
   - Full keyboard accessibility and mobile responsive layout.

DELIVERABLE:
Return the full updated code for any modified `src/client/**` components, accompanied by a concise checklist of changes for single-sync integration via the `frontend` worker.
```

---

## 3. Chrome 156 Remote Debugging & CDP Environment Status

In modern Google Chrome (v144+ / v156+ on macOS), Chrome uses a WebSocket-only debugging architecture:
- **Chrome Binary**: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` (Version: `156.0.8078.82`).
- **DevTools Port File**: `~/Library/Application Support/Google/Chrome/DevToolsActivePort` (Active Port: `9222`, PID `25691`).
- **Modern Chrome Security Restriction**: In Chrome 156, legacy HTTP discovery endpoints (`/json/version`, `/json/list`) intentionally return `404 Not Found`. WebSocket CDP connections (`ws://127.0.0.1:9222/devtools/browser/<uuid>`) require explicit user authorization.
- **Exact 1-Click User Action Needed**:
  1. Switch to Google Chrome (a tab to `chrome://inspect/#remote-debugging` has been launched).
  2. Under **Remote Target Discovery**, check the box: **"Allow remote debugging for this browser instance"** (or click "Allow" on the permission banner).
  3. Once enabled, browser automation agents / CDP clients can connect directly to `ws://127.0.0.1:9222<path>`.

---

## 4. Strict Boundary & File Ownership Invariants

1. **Client-Only Scope**:
   - AI Studio modifications MUST touch ONLY `src/client/**` (e.g. `src/client/components/**`, `src/client/styles/**`, `src/client/hooks/**`, `src/client/App.tsx`).
   - AI Studio MUST NEVER modify `package.json`, `package-lock.json`, `tsconfig*.json`, `src/server/**`, `src/shared/**`, or `docs/**`.
2. **Server-Resolved Authority**:
   - The client MUST NOT calculate, override, or fake property valuations (`askingPrice`, `avmPrice`, `avmLow`, `avmHigh`, `gapPct`, `rangePosition`).
   - All valuation and geospatial figures are authoritative outputs from `/api/properties/search`, `/api/properties/:id/avm`, `/api/geospatial/analyze`, and `/api/explain`.
3. **Secret Isolation**:
   - The client MUST NEVER request, store, or reference server secrets (`RENTCAST_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_PLACES_SERVER_KEY`).
   - The only external credential permitted on the client is the HTTP-referrer-restricted `GOOGLE_MAPS_BROWSER_KEY` returned safely via `GET /api/config`.
4. **Source Policy & Non-Claims**:
   - `google_places_context` is display-only context; it must never be combined with OpenStreetMap accessibility scores or represented as official district boundaries.
   - Separate visual legends must be maintained for:
     - **Deterministic Accessibility Score** ($0\text{–}100$, linear kernel on OSM amenities).
     - **Asking-vs-AVM Price Gap** ($\text{gapPct} = 100 \times (\text{AVM} - \text{Ask}) / \text{AVM}$, confidence range classification).
     - **EPA Environmental Due-Diligence Layer** (neutral regulatory records; not an automatic health hazard).
   - Fast-food / brand density defaults to $0$ weight and carries no causal property appreciation claims.

---

## 5. Shared Contract Snapshot (`src/shared/types.ts`)

Any code generated by AI Studio MUST conform to the existing TypeScript types and Zod schemas in `src/shared/`:

### 5.1 UI States
```ts
export type UiState =
  | 'ready'
  | 'loading'
  | 'empty'
  | 'partial'
  | 'unsupported_area'
  | 'setup_needed'
  | 'quota_exhausted'
  | 'timeout'
  | 'recovery'
  | 'synthetic_demo';
```

### 5.2 Property & Valuation Model
```ts
export interface PriceGapResult {
  gapPct: number | null;
  gapAmountUsd: number | null;
  rangePosition: 'in_range' | 'below_estimate_range_candidate' | 'above_estimate_range_candidate' | 'range_unknown' | 'no_avm';
  askingPrice: number | null;
  avmPrice: number | null;
  avmLow: number | null;
  avmHigh: number | null;
  isWithinEstimateRange: boolean | null;
  isProvenUndervaluation: false;
  interpretationNote: string;
}

export interface PropertyListingSummary {
  id: string;
  formattedAddress: string;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  latitude: number;
  longitude: number;
  propertyType: string;
  bedrooms: number | null;
  bathrooms: number | null;
  squareFootage: number | null;
  lotSize: number | null;
  yearBuilt: number | null;
  askingPrice: number | null;
  listingLastSeenAt: string | null;
  avmPrice: number | null;
  avmLow: number | null;
  avmHigh: number | null;
  avmFetchedAt: string | null;
  lastSalePrice: number | null;
  lastSaleDate: string | null;
  assessedValue: number | null;
  assessedYear?: number | null;
  comparablesSummary: ComparablesSummary | null;
  priceGap: PriceGapResult;
  accessibility: AccessibilityResult | null;
  nearbyEnvironmentalCount: number;
  dataProvenance: 'rentcast_live' | 'synthetic_demo';
}
```

### 5.3 Grounded Explanation Model (`/api/explain`)
```ts
export interface ExplainResponse {
  explanationAvailable: boolean;
  fallbackUsed: boolean;
  unavailableReason: string | null;
  modelUsed: string | null;
  isSyntheticDemo: boolean;
  summary: string;
  evidenceIds: string[];
  evidenceCatalog: ExplainEvidenceItem[];
  positiveFactors: string[];
  contraryAndUncertaintyFactors: string[];
  limitations: string[];
  dataAsOf: ExplainDataAsOf;
  clientRequestSeq?: number;
}
```

---

## 6. Single-Sync Integration Workflow via `frontend` Worker

To avoid race conditions and conflicting concurrent edits across swarm workers:

1. **Step 1: Export Client Context**:
   - Provide the AI Studio session with `src/client/**`, `src/shared/types.ts`, and `index.html`.
2. **Step 2: Execute AI Studio Build Session**:
   - Run the session with the exact brief from Section 2.
   - Inspect changes to ensure they touch ONLY `src/client/**`.
3. **Step 3: Ingest via `frontend` Worker**:
   - The dedicated `frontend` worker receives the diff or changed files.
   - Overwrite/update matching files in `src/client/**`.
4. **Step 4: Verification Gate**:
   - Run `npm run typecheck` (`tsc --noEmit && tsc -p tsconfig.server.json --noEmit`).
   - Run `npx vitest run tests/client` (or relevant frontend unit/integration tests).
   - Verify zero regression on accessibility (ARIA roles, keyboard nav) and responsiveness.

---

## 7. Execution Provenance Log (To Record Upon Manual Execution)

If and when a manual Google AI Studio Build session is conducted, record the exact execution metadata below:

| Field | Record / Value |
|---|---|
| **Session Status** | `PENDING (Manual Step Required — Not Executed)` |
| **Execution Timestamp** | `[Unexecuted — Not Run]` |
| **AI Studio Interface / Tool** | `Google AI Studio Build (Web Interface)` |
| **Foundation Model** | `gemini-2.5-pro` / `gemini-2.5-flash` |
| **Operator Name / ID** | `[Unexecuted]` |
| **Prompt Provided** | `See Section 2 exact brief` |
| **Files Modified / Returned** | `None (Pending Manual Execution)` |
| **TypeScript Typecheck Pass** | `Pending` |
| **Vitest Test Suite Pass** | `Pending` |
| **Manual Verification Notes** | `N/A` |
