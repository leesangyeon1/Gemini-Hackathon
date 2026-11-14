# Application HTTP API Contracts (`API-CONTRACTS.md`)

**Owner:** `integrator`  
**Shared TypeScript & Zod Implementation:** [`src/shared/constants.ts`](../src/shared/constants.ts), [`src/shared/types.ts`](../src/shared/types.ts), [`src/shared/schemas.ts`](../src/shared/schemas.ts)

All HTTP endpoints exchange UTF-8 JSON (`Content-Type: application/json`). Request payloads are capped at `256 KiB` and validated strictly at the Express boundary via Zod schemas. **No endpoint ever accepts or returns secret values** (`RENTCAST_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_PLACES_SERVER_KEY`)—only environment variable *names* appear in setup/diagnostic metadata.

---

## 1. Cross-Cutting Envelopes, Stale-Request Semantics & Safe Error Schema

### 1.1 Stale-Request Protection (`clientRequestSeq`)
Interactive map exploration and rapid property clicking can create out-of-order HTTP responses. All `POST /api/*` request schemas accept an optional `clientRequestSeq` (`integer >= 0`) and echo it verbatim in the response (`clientRequestSeq?: number`). Clients combine `AbortController` cancellation with monotonic `clientRequestSeq` checks so late responses from superseded area searches or home selections are discarded safely.

### 1.2 Safe Error Envelope (`ApiErrorResponse`)
All `4xx` and `5xx` API responses conform to `ApiErrorResponseSchema`, stripping upstream headers, URLs containing keys, and internal stack traces:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "radiusMeters must be between 400 and 5000 meters.",
    "uiState": "recovery",
    "retryable": false,
    "missingEnvVarNames": [],
    "details": {
      "fieldErrors": {
        "analysisArea.radiusMeters": ["Number must be less than or equal to 5000"]
      }
    }
  },
  "budget": null,
  "clientRequestSeq": 4
}
```

| Error `code` | HTTP Status | Mapped `uiState` | Retryable | Meaning |
|---|---:|---|---|---|
| `VALIDATION_ERROR` | `400` | `recovery` | `false` | Malformed JSON, `NaN`/`Infinity`, out-of-range coordinates/radii, or negative preference weights |
| `SOURCE_POLICY_VIOLATION` | `400` | `recovery` | `false` | Caller attempted to submit disallowed source (`google_places_context`) into analysis |
| `UNSUPPORTED_AREA` | `422` | `unsupported_area` | `false` | Non-US coordinates or non-US location query |
| `SETUP_NEEDED` | `503` | `setup_needed` | `false` | Required server secret is unconfigured (`missingEnvVarNames` lists variable names only, e.g. `["RENTCAST_API_KEY"]`) |
| `SESSION_EXPIRED` | `409` | `recovery` | `false` | Analysis session expired past TTL or unavailable after restart/revision rollout; zero paid provider calls are repeated automatically |
| `SESSION_CAP_REACHED` | `429` | `quota_exhausted` | `true` *(after `/expand`)* | Session limit (`1` search / `5` AVMs default, or `10` AVMs expanded) reached |
| `GLOBAL_QUOTA_EXHAUSTED` | `429` | `quota_exhausted` | `false` | Global monthly cap (`RENTCAST_GLOBAL_MONTHLY_LIMIT`, default `35`) reached |
| `BUDGET_STORE_UNAVAILABLE` | `503` | `quota_exhausted` | `true` | Durable atomic store (`firestore` / `sqlite`) failed closed to protect monthly allowance |
| `RATE_LIMITED` | `429` | `recovery` | `true` | Per-client request rate limit or upstream HTTP 429 encountered |
| `UPSTREAM_TIMEOUT` | `504` | `timeout` | `true` | Upstream geocoder, Overpass, EPA FRS, RentCast, or Gemini exceeded server timeout |
| `PROVIDER_ERROR` | `502` | `recovery` | `true` | Sanitized upstream HTTP/parse error |
| `NOT_FOUND` | `404` | `empty` | `false` | Unknown API route, session, or property record |
| `INTERNAL_ERROR` | `500` | `recovery` | `true` | Unexpected internal exception (sanitized) |

---

## 2. `GET /api/health`

Liveness and readiness probe for Cloud Run (`0.0.0.0:$PORT`) and local smoke verification. Never fails startup when optional external keys are absent.

- **Request:** No query or body parameters.
- **Response (`200 OK` — `HealthResponseSchema`):**
```json
{
  "status": "ok",
  "service": "foreal-estate",
  "version": "0.1.0",
  "timestamp": "2026-11-14T07:40:00.000Z",
  "uptimeSeconds": 42.5,
  "durabilityMode": "sqlite",
  "capabilities": {
    "rentcastConfigured": false,
    "geminiConfigured": true,
    "mapsBasemapConfigured": false,
    "placesContextConfigured": false,
    "syntheticDemoEnabled": true
  }
}
```

---

## 3. `GET /api/config`

Supplies non-secret runtime capability flags, the intentionally HTTP-referrer-restricted `GOOGLE_MAPS_BROWSER_KEY` (if configured), default preference weights/radii, budget thresholds, and required setup variable **names**.

- **Security Invariant:** `RENTCAST_API_KEY`, `GEMINI_API_KEY`, and `GOOGLE_PLACES_SERVER_KEY` values are **never** present anywhere in this response. When `RENTCAST_API_KEY` is unconfigured, `uiSetupState` remains `"setup_needed"` even when `capabilities.syntheticDemoEnabled` is `true` so badged `synthetic_demo` mode stays strictly user opt-in. `durabilityMode` (`BudgetStoreMode`) is `"firestore"`, `"sqlite"`, or `"memory"` (isolated tests only).
- **Response (`200 OK` — `PublicRuntimeConfigSchema`):**
```json
{
  "appTitle": "Foreal-Estate",
  "uiSetupState": "setup_needed",
  "capabilities": {
    "rentcastConfigured": false,
    "geminiConfigured": true,
    "mapsBasemapConfigured": false,
    "placesContextConfigured": false,
    "syntheticDemoEnabled": true
  },
  "missingSetupEnvVars": [
    {
      "envVarName": "RENTCAST_API_KEY",
      "feature": "Live US Property Listings & On-Demand AVM",
      "requiredForLiveMode": true
    },
    {
      "envVarName": "GOOGLE_MAPS_BROWSER_KEY",
      "feature": "Interactive Google Maps JS Basemap",
      "requiredForLiveMode": false
    }
  ],
  "mapsBrowserKey": null,
  "defaultPreferences": {
    "weights": {
      "grocery": 25,
      "parks": 20,
      "transit": 20,
      "healthcare": 15,
      "schools": 20,
      "fast_food": 0
    },
    "radiiMeters": {
      "grocery": 1600,
      "parks": 1200,
      "transit": 1000,
      "healthcare": 2400,
      "schools": 1600,
      "fast_food": 1200
    },
    "includeEnvironmentalDueDiligenceLayer": true,
    "optionalExternalityPenaltyWeight": 0
  },
  "analysisBounds": {
    "minAreaRadiusMeters": 400,
    "maxAreaRadiusMeters": 5000,
    "defaultAreaRadiusMeters": 1600,
    "minCategoryRadiusMeters": 200,
    "maxCategoryRadiusMeters": 4000,
    "maxListingsPerSearch": 25
  },
  "budgetLimits": {
    "globalMonthlyLimit": 35,
    "defaultSessionListingsLimit": 1,
    "defaultSessionAvmsLimit": 5,
    "expandedSessionAvmsLimit": 10,
    "expandedSessionPropertyRecordsLimit": 1,
    "durabilityMode": "sqlite"
  },
  "attributions": [
    "© OpenStreetMap contributors (ODbL)",
    "US EPA Facility Registry Service (FRS) / Envirofacts (Public Domain)",
    "US Census Geocoder (Public Domain)",
    "Property listings & AVM estimates via RentCast API"
  ]
}
```

---

## 4. `POST /api/regions/resolve`

Resolves any user-supplied US city/state, neighborhood, 5-digit ZIP code, street area, or interactive map circle (`bounds`), checks US coverage, surfaces ambiguity when multiple distinct US places match, and returns an explicit circular viewport approximation (`isViewportApproximation: true`). Never hardcodes Berkeley, CA.

- **Request (`RegionResolveRequestSchema`):** Exactly one of `query` (`1..160` trimmed chars) or `bounds` (`centerLat` in `[-90, 90]`, `centerLng` in `[-180, 180]`, `radiusMeters` in `[400, 5000]`), plus optional `preferredRadiusMeters` (`[400, 5000]`, default `1600`), `useSyntheticDemo?: boolean`, and `clientRequestSeq?: number`.
```json
{
  "query": "Springfield",
  "preferredRadiusMeters": 1600,
  "clientRequestSeq": 1
}
```
- **Response (`200 OK` — `RegionResolveResponseSchema`):**
  - `status`: `"resolved" | "ambiguous" | "unsupported_area"`
  - `candidates`: `RegionCandidate[]` (`0..10` items)
  - `selectedArea`: `AnalysisArea | null` (populated when `status === "resolved"`, `null` when `"ambiguous"` or `"unsupported_area"`)
  - `message`: User-readable explanation (e.g., ambiguity prompt or US-only coverage explanation)
```json
{
  "status": "ambiguous",
  "candidates": [
    {
      "candidateId": "us-il-springfield",
      "displayName": "Springfield, Sangamon County, Illinois, USA",
      "city": "Springfield",
      "state": "IL",
      "zipCode": null,
      "centerLat": 39.781721,
      "centerLng": -89.650148,
      "suggestedRadiusMeters": 1600,
      "boundingBox": {
        "minLat": 39.767332,
        "maxLat": 39.79611,
        "minLng": -89.668861,
        "maxLng": -89.631435
      },
      "placeKind": "city",
      "isUsLocation": true,
      "isViewportApproximation": true,
      "source": "osm_nominatim"
    }
  ],
  "selectedArea": null,
  "message": "Multiple US locations match \"Springfield\". Confirm your intended area before analyzing.",
  "clientRequestSeq": 1
}
```
- When `selectedArea` is returned (`status: "resolved"`), it carries `areaId`, `label`, `centerLat`, `centerLng`, `radiusMeters`, `boundingBox`, `city`, `state`, `zipCode`, `isUsLocation: true`, `isViewportApproximation: true`, and `approximationDisclaimer`: *"Circular geodesic viewport approximation — not an official municipal, school, or neighborhood boundary polygon."*

---

## 5. `POST /api/geospatial/analyze`

Fetches licensed open amenity facilities (`osm_overpass` / `osm_extract`, or badged `synthetic_demo` when opted in) out to the influence-buffered radius `analysisArea.radiusMeters + max(radius_c)`, fetches the separate US EPA FRS environmental due-diligence layer (`epa_frs`), enforces `sourcePolicy.ts` (unconditionally rejecting `google_places_context`), evaluates area-center accessibility, and computes the bounded regular-grid Venn-like multi-category overlap matrix.

- **Request (`GeospatialAnalyzeRequestSchema`):**
  - `analysisArea`: `AnalysisArea` (`radiusMeters` in `[400, 5000]`)
  - `preferences`: `PreferenceProfile` (`weights[c] >= 0` in `[0, 100]`, `fast_food` default `0`; `radiiMeters[c]` in `[200, 4000]`; optional `caps[c]` in `(0, 50]`; `optionalExternalityPenaltyWeight` in `[0, 50]`)
  - `gridResolution`?: `integer` in `[4, 20]` (default `11`)
  - `overlapThreshold`?: `number` in `(0, 1]` (default `0.25`)
  - `evaluatePoints`?: `Array<{ id: string; lat: number; lng: number }>` (`0..30` points, e.g. loaded property coordinates for deterministic re-scoring without re-calling RentCast)
  - `useSyntheticDemo`?: `boolean` (default `false`)
  - `clientRequestSeq`?: `number`
- **Response (`200 OK` — `GeospatialAnalyzeResponseSchema`):**
```json
{
  "uiState": "ready",
  "dataMode": "live_open_data",
  "isSyntheticDemo": false,
  "analysisArea": {
    "areaId": "us-wa-seattle-ballard",
    "label": "Ballard, Seattle, WA",
    "centerLat": 47.6687,
    "centerLng": -122.3845,
    "radiusMeters": 1600,
    "boundingBox": { "minLat": 47.6543, "maxLat": 47.6831, "minLng": -122.4058, "maxLng": -122.3632 },
    "city": "Seattle",
    "state": "WA",
    "zipCode": "98107",
    "isUsLocation": true,
    "isViewportApproximation": true,
    "approximationDisclaimer": "Circular geodesic viewport approximation — not an official municipal, school, or neighborhood boundary polygon."
  },
  "influenceFetchRadiusMeters": 4000,
  "centerAccessibility": {
    "score": 82.4,
    "completeness": "complete",
    "missingOrFailedCategories": [],
    "failedWeightedCategories": [],
    "categoryBreakdown": {},
    "categories": [],
    "totalWeight": 100,
    "knownWeight": 100,
    "knownWeightFraction": 1,
    "deduplicatedFacilityCount": 47,
    "duplicatesMergedCount": 9,
    "rejectedFacilityCount": 0,
    "rejectedCountBySource": {}
  },
  "pointEvaluations": {},
  "gridOverlap": {
    "center": { "lat": 47.6687, "lng": -122.3845 },
    "radiusMeters": 1600,
    "gridResolution": 11,
    "overlapThreshold": 0.25,
    "activeCategories": ["grocery", "parks", "transit", "healthcare", "schools"],
    "maxOverlapCount": 5,
    "cells": [],
    "sweetSpotCells": []
  },
  "amenities": [],
  "environmentalLayer": {
    "status": "ok",
    "records": [],
    "disclaimer": "Documented US EPA Facility Registry Service (FRS) permit/program records are surfaced strictly as a separate user-controlled due-diligence layer, never an automatic environmental hazard or health determination."
  },
  "displayOnlyPlacesContext": [],
  "sourceAttributions": [
    "© OpenStreetMap contributors (ODbL)",
    "US EPA Facility Registry Service (FRS) / Envirofacts (Public Domain)"
  ],
  "nonClaims": [
    "Straight-line WGS84 geodesic radii are not walking-time or transit isochrones.",
    "Accessibility scores (0-100) represent uncalibrated user convenience preferences, never market dollar premiums, and never multiply AVM estimates.",
    "Optional commercial/fast-food context defaults to 0 weight and makes no causal appreciation claims."
  ],
  "fetchedAt": "2026-11-14T07:42:00.000Z",
  "clientRequestSeq": 2
}
```

---

## 6. `POST /api/properties/search`

Executes on explicit **"Analyze area"** confirmation to retrieve up to `25` active residential for-sale listings (`GET /v1/listings/sale`) inside `analysisArea`, strips owner/agent PII, optionally attaches deterministic per-property `AccessibilityScoreResult` if `preferences` are supplied, and returns the updated durable `BudgetSnapshot`. Does **not** bulk-fetch AVMs (`rangePosition: "no_avm"` until a home is selected).

- **Request (`PropertySearchRequestSchema`):**
  - `sessionId`?: `string` (`^[a-zA-Z0-9_-]{8,64}$`; server issues a new `sessionId` if omitted)
  - `analysisArea`: `AnalysisArea`
  - `limit`?: `integer` in `[1, 25]` (default `25`; values `> 25` rejected)
  - `propertyType`?: `"Single Family" | "Condo" | "Townhouse" | "Multi-Family" | "Manufactured" | "Land" | "Other"`
  - `preferences`?: `PreferenceProfile`
  - `useSyntheticDemo`?: `boolean` (default `false`)
  - `clientRequestSeq`?: `number`
- **Response (`200 OK` — `PropertySearchResponseSchema`):**
  - `sessionId`: `string`
  - `uiState`: `"ready" | "empty" | "synthetic_demo" | "setup_needed" | "quota_exhausted"`
  - `isSyntheticDemo`: `boolean`
  - `fromCache`: `boolean`
  - `listings`: `PropertyListingSummary[]` (`0..25` items; each includes distinct `askingPrice`, `listingLastSeenAt`, `avmPrice: null` unless already cached in session, `avmLow`, `avmHigh`, `avmFetchedAt`, `lastSalePrice`, `lastSaleDate`, `assessedValue`, `comparablesSummary`, `priceGap`, `accessibility`, `nearbyEnvironmentalCount`, `dataProvenance`)
  - `budget`: `BudgetSnapshot`
  - `fetchedAt`: ISO-8601 UTC timestamp
  - `clientRequestSeq`?: `number`

---

## 7. `POST /api/properties/:propertyId/avm`

On-demand per-home valuation comparison (`GET /v1/avm/value`) triggered **only** when the user explicitly selects a property card or marker. Checks the server cache first (`0` budget cost on hit); otherwise atomically reserves `1` AVM credit in the durable budget store (`<= 5` per default session, `<= 10` per expanded session, and within `RENTCAST_GLOBAL_MONTHLY_LIMIT`), fetches the AVM midpoint, `[avmLow, avmHigh]` bounds, and `comparables[]`, detects `subjectIncludedInComps`, computes `priceGap` via `computePriceGap`, and enumerates `contraryEvidence`.

- **Path Parameter:** `propertyId` (`1..160` URL-decoded chars)
- **Request (`PropertyAvmRequestSchema`):**
  - `sessionId`: `string` (`8..64` chars)
  - `propertySnapshot`?: Optional cached listing context (`formattedAddress`, `latitude`, `longitude`, `propertyType`, `bedrooms`, `bathrooms`, `squareFootage`, `askingPrice`, `listingLastSeenAt`) if the server needs subject attributes to query `/v1/avm/value`
  - `includeRecentSalesRecord`?: `boolean` (default `false`; allowed only when `sessionExpanded: true`, max `1` call/session)
  - `useSyntheticDemo`?: `boolean` (default `false`)
  - `clientRequestSeq`?: `number`
- **Response (`200 OK` — `PropertyAvmResponseSchema`):**
  - `sessionId`: `string`
  - `uiState`: `"ready" | "synthetic_demo"`
  - `isSyntheticDemo`: `boolean`
  - `fromCache`: `boolean`
  - `property`: `PropertyDetailRecord` (with distinct `askingPrice`, `listingLastSeenAt`, `avmPrice`, `avmLow`, `avmHigh`, `avmFetchedAt`, `lastSalePrice`, `lastSaleDate`, `assessedValue`, `comparablesSummary`, `priceGap`, and `contraryEvidence[]`)
  - `budget`: `BudgetSnapshot`
  - `disclaimers`: `string[]` (comparable-listing AVM notice + non-appraisal notice)
  - `clientRequestSeq`?: `number`

---

## 8. `POST /api/sessions/:sessionId/expand`

Explicit user-confirmed expansion of a single session's AVM cap from `5` to `10` selected homes (plus up to `1` optional `/v1/properties` recent-sales/tax record lookup = `12` max session calls), subject to remaining `RENTCAST_GLOBAL_MONTHLY_LIMIT`.

- **Path Parameter:** `sessionId` (`^[a-zA-Z0-9_-]{8,64}$`)
- **Request (`SessionExpandRequestSchema`):**
```json
{
  "userConfirmed": true,
  "clientRequestSeq": 6
}
```
  (`userConfirmed` must be literal `true` or `400 VALIDATION_ERROR` is returned.)
- **Response (`200 OK` — `SessionExpandResponseSchema`):**
```json
{
  "sessionId": "sess_9f82c1a4e7b0",
  "expanded": true,
  "budget": {
    "billingMonth": "2026-11",
    "globalMonthlyLimit": 35,
    "initialSpentCalls": 0,
    "runtimeSpentCalls": 6,
    "totalSpentCalls": 6,
    "globalRemaining": 29,
    "sessionId": "sess_9f82c1a4e7b0",
    "sessionListingsUsed": 1,
    "sessionListingsLimit": 1,
    "sessionAvmsUsed": 5,
    "sessionAvmsLimit": 10,
    "sessionPropertyRecordsUsed": 0,
    "sessionPropertyRecordsLimit": 1,
    "sessionExpanded": true,
    "durabilityMode": "sqlite",
    "quotaExhausted": false
  },
  "message": "Session expanded to allow up to 10 on-demand home AVM comparisons.",
  "clientRequestSeq": 6
}
```

---

## 9. `POST /api/explain`

Generates an optional, strictly grounded narrative explanation via `@google/genai` (`GEMINI_EXPLAIN_MODEL`, default `gemini-4-hydrogen` with documented fallback) summarizing pre-computed server accessibility scores, asking-vs-AVM price-gap classification, environmental due-diligence records, and contrary evidence.

- **Grounding & Degradation Rules:**
  1. Server builds an allowlisted `evidenceMap` from eligible sources only (`osm_overpass`, `osm_extract`, `epa_frs`, RentCast property/AVM record, or badged `synthetic_demo` — **never** `google_places_context`).
  2. Server validates Gemini's structured JSON output against `GeminiStructuredExplainPayloadSchema`, verifying every cited `evidenceId` exists in `evidenceMap`, no ungrounded numbers contradict server calculations, and no causal fast-food/appraisal claims appear.
  3. If `GEMINI_API_KEY` is missing, Gemini times out, or output validation fails, `POST /api/explain` returns **`200 OK`** with `explanationAvailable: false` and a deterministic server fallback summary so the UI never breaks.

- **Request (`ExplainRequestSchema`):**
  - `sessionId`: `string`
  - `propertyId`: `string`
  - `preferences`: `PreferenceProfile`
  - `propertyContext`?: Optional `PropertyDetailRecord` snapshot if evaluating stateless/cached detail
  - `accessibilityContext`?: Optional `AccessibilityResult` (`AccessibilityScoreResult`) snapshot
  - `environmentalRecords`?: Optional `EnvironmentalRecord[]` (`<= 25`)
  - `useSyntheticDemo`?: `boolean`
  - `clientRequestSeq`?: `number`
- **Response (`200 OK` — `ExplainResponseSchema`):**
```json
{
  "explanationAvailable": true,
  "fallbackUsed": false,
  "unavailableReason": null,
  "modelUsed": "gemini-4-hydrogen",
  "isSyntheticDemo": false,
  "summary": "1234 NW Market St is listed at $900,000, which is 10.0% below the RentCast AVM midpoint ($1,000,000) but remains inside the statistical estimate range ($850,000–$1,150,000), indicating normal valuation dispersion rather than proven undervaluation.",
  "evidenceIds": ["ev_prop_pricing", "ev_prop_range", "ev_cat_grocery", "ev_cat_transit"],
  "evidenceCatalog": [
    {
      "evidenceId": "ev_prop_pricing",
      "sourceId": "rentcast",
      "label": "Active Asking vs. RentCast AVM Midpoint",
      "detail": "Asking $900,000 vs. AVM $1,000,000 (+10.0% midpoint gap)"
    },
    {
      "evidenceId": "ev_prop_range",
      "sourceId": "rentcast",
      "label": "RentCast AVM Confidence Range",
      "detail": "Asking $900,000 sits within [$850,000, $1,150,000] (in_range)"
    }
  ],
  "positiveFactors": [
    "Strong grocery (intensity 0.92) and transit (intensity 0.85) convenience under current user weights."
  ],
  "contraryAndUncertaintyFactors": [
    "Asking price ($900,000) lies inside the AVM confidence interval ($850,000–$1,150,000).",
    "AVM is a comparable-listing statistical estimate, not an interior inspection or physical appraisal."
  ],
  "limitations": [
    "Geodesic radii measure straight-line WGS84 distance, not walking-time isochrones.",
    "Accessibility score (82.4/100) reflects user convenience preferences, not market dollar value."
  ],
  "dataAsOf": {
    "listingLastSeenAt": "2026-11-12T18:00:00.000Z",
    "avmFetchedAt": "2026-11-14T07:43:10.000Z",
    "geospatialFetchedAt": "2026-11-14T07:42:00.000Z"
  },
  "clientRequestSeq": 7
}
```
