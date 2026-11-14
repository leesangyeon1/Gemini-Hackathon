# External Data Sources, Licensing, Schema Hygiene & Quota Governance (`DATA-SOURCES.md`)

**Owner:** `property` (Workstream 1)  
**Verification Date:** 2026-11-13 / 2026-11-14  
**Applies To:** `src/server/property/**`, `src/server/geospatial/**`, `src/server/explain/**`, `src/client/**`

This document is the authoritative specification for all external APIs and public datasets consumed by **Foreal-Estate**, recording verified official endpoints, authentication mechanisms, quota/cost constraints, license and attribution obligations, server-enforced source-policy eligibility, and field-level data hygiene rules.

---

## 1. Source-Policy Eligibility Matrix (Server-Enforced)

Every geospatial or property record entering the backend carries a canonical `SourceId`. The server-side source-policy registry (`src/server/geospatial/sourcePolicy.ts`) enforces whether a source may participate in deterministic spatial scoring, grid heatmaps, feature storage, or Gemini `/api/explain` evidence prompts.

| `SourceId` | Provider / Dataset | License / Terms | Mandatory UI Attribution | `analysisEligible` (Scoring / Heatmaps / Explain) | Caching & Storage Policy |
|---|---|---|---|---|---|
| `osm_overpass` | OpenStreetMap via Overpass API (`OSM_OVERPASS_URL`) | Open Data Commons Open Database License (**ODbL 1.0**) | `© OpenStreetMap contributors (ODbL)` linking to `https://www.openstreetmap.org/copyright` | **`true`** | Lawful TTL spatial cache permitted; attribution preserved on all derived views |
| `osm_extract` | Pre-indexed OpenStreetMap regional extract | **ODbL 1.0** | `© OpenStreetMap contributors (ODbL)` linking to `https://www.openstreetmap.org/copyright` | **`true`** | Local read-only extract permitted under ODbL Produced Work / Derivative Database rules |
| `epa_frs` | US EPA Facility Registry Service (FRS) / Envirofacts REST API | **US Federal Public Domain** (17 U.S.C. § 105) | `Source: US EPA Facility Registry Service (FRS) / Envirofacts` | **`true`** *(Strictly in separate `environmentalLayer` due-diligence layer)* | Lawful TTL cache permitted; never silently merged into positive amenity scores |
| `synthetic_demo` | Opt-in deterministic synthetic demo fixtures (`ENABLE_SYNTHETIC_DEMO_MODE=true`) | Internal project fixture (MIT / Hackathon prototype) | Prominent **`SYNTHETIC DEMO DATA — NOT LIVE MARKET LISTINGS`** badge | **`true`** *(Only when user explicitly activates Synthetic Demo mode)* | In-memory / static fixture; never mixed silently with live RentCast records |
| `google_places_context` | Google Maps JS API & Google Places API (`GOOGLE_PLACES_SERVER_KEY`) | **Google Maps Platform Terms of Service** (Section 3.2.3) | Official **Google logo** and third-party provider attributions as returned by API | **`false` (HARD REJECTED)** | **No scraping, no feature DB indexing, no scoring/heatmap input.** Only `place_id` (indefinite) or `lat`/`lng` (<= 30 days) may be cached per ToS |

> [!IMPORTANT]
> **Hard Server Boundary on `google_places_context`:** Even if a caller submits a payload tagging `google_places_context` records with `analysisEligible: true` or matching the internal `FacilityRecord` schema, the server source-policy registry unconditionally overrides and rejects `google_places_context` from deterministic accessibility math, grid overlap heatmaps, persistent feature databases, and `/api/explain` grounding payloads.

---

## 2. RentCast Property & AVM API (`https://developers.rentcast.io`)

- **Official Documentation URLs (Verified 2026-11-13 / 2026-11-14):**
  - Developer Portal & Overview: `https://developers.rentcast.io/reference/introduction`
  - Sale Listings Endpoint: `https://developers.rentcast.io/reference/sale-listings` (`GET https://api.rentcast.io/v1/listings/sale`)
  - Property Value Estimate (AVM) Endpoint: `https://developers.rentcast.io/reference/Value-estimate` (`GET https://api.rentcast.io/v1/avm/value`)
  - Property Records Endpoint (Optional Recent Sales / Tax History): `https://developers.rentcast.io/reference/property-records` (`GET https://api.rentcast.io/v1/properties`)
  - Pricing & Licensing Terms: `https://www.rentcast.io/api` and `https://www.rentcast.io/terms`
- **Authentication:**
  - Server-side HTTP header: `X-Api-Key: <RENTCAST_API_KEY>` and `Accept: application/json`.
  - `RENTCAST_API_KEY` is injected exclusively on the server (via Google Cloud Secret Manager in production or server `.env` locally) and is **never** exposed in `/api/config`, browser bundles, client network calls, logs, or error payloads.
- **Pricing, Quotas & Rate Limits:**
  - **Monthly Free Tier:** **50 API calls per month** account-wide on the Developer free tier, with per-request overage billing once the 50-call allotment is exceeded.
  - **Throughput Limit:** Up to **20 requests per second** per API key.
  - **Application Hard Cap:** Foreal-Estate enforces `RENTCAST_GLOBAL_MONTHLY_LIMIT < 50` (default **`35`**) minus `RENTCAST_INITIAL_SPENT_CALLS` (default **`0`**) via a durable atomic counter (`firestore` on Cloud Run, `sqlite` via `node:sqlite` locally). See [`docs/decisions/ADR-001-rentcast.md`](decisions/ADR-001-rentcast.md) for session and global budget math.
- **Licensing & Attribution:**
  - Commercial and developer application use is permitted under the RentCast API Terms of Use; attribution is not legally mandated by RentCast, though Foreal-Estate explicitly labels listing and AVM provenance (`Source: RentCast API`) alongside fetch timestamps (`listingLastSeenAt`, `avmFetchedAt`).
  - **Bulk Export Prohibition:** Raw RentCast responses must not be redistributed as a bulk data export or standalone property feed. Search queries are capped at `limit <= 25` active residential listings per session.

### 2.1 Verified RentCast Endpoints & Query Parameters

| Endpoint | Purpose in Foreal-Estate | Verified Query Parameters Used | Budget Cost |
|---|---|---|---|
| `GET https://api.rentcast.io/v1/listings/sale` | Fetch active residential for-sale listings within the user-confirmed US analysis area | `latitude`, `longitude`, `radius` (in miles, converted from `analysisArea.radiusMeters`), `status=Active`, `limit=25` (max 25, API supports 1–500), optional `city`, `state`, `zipCode`, `propertyType` | **1 call** per explicit "Analyze area" action (cached by normalized region key) |
| `GET https://api.rentcast.io/v1/avm/value` | On-demand Automated Valuation Model (AVM) point estimate, low/high range, and comparable listings for a single user-selected property | `address` (full `formattedAddress`, or `latitude`/`longitude`), `propertyType`, `bedrooms`, `bathrooms`, `squareFootage`, `compCount=10` (API supports up to 25, default 15), `lookupSubjectAttributes=true` | **1 call** per unique selected home (max **5** initially; up to **10** if user explicitly expands session; **0** on repeat click via cache) |
| `GET https://api.rentcast.io/v1/properties` | Optional lookup of public-record `lastSalePrice`, `lastSaleDate`, and `taxAssessments` when not already populated on the subject record | `address` or `id` | **0 calls** by default; **<= 1 call** only if user explicitly triggers session expansion with recent-sale lookup |

### 2.2 Verified Field Mappings & Strict Semantic Separation

Foreal-Estate enforces strict separation between four distinct financial quantities that must **never** be conflated or overwritten:

| Internal Contract Field | Upstream RentCast Endpoint & Field | Semantic Meaning & Validation Rule |
|---|---|---|
| `id` | `/v1/listings/sale` -> `id` (string) | Canonical property/listing identifier |
| `formattedAddress` | `/v1/listings/sale` -> `formattedAddress` (fallback: `addressLine1`, `city`, `state`, `zipCode`) | Standardized US street address |
| `latitude`, `longitude` | `/v1/listings/sale` -> `latitude`, `longitude` (number) | Finite WGS84 coordinates (`-90 <= lat <= 90`, `-180 <= lng <= 180`) |
| `propertyType` | `/v1/listings/sale` -> `propertyType` (`"Single Family"`, `"Condo"`, `"Townhouse"`, `"Multi-Family"`, `"Manufactured"`, `"Land"`) | Checked for residential comparability before computing price gap |
| `bedrooms`, `bathrooms`, `squareFootage`, `lotSize`, `yearBuilt` | `/v1/listings/sale` -> `bedrooms`, `bathrooms`, `squareFootage`, `lotSize`, `yearBuilt` | Structural attributes (nullable finite positive numbers) |
| **`askingPrice`** | `/v1/listings/sale` -> `price` (number, USD) | **Current active for-sale asking price** listed on the market. Must be a positive finite USD whole-property sale price |
| **`listingLastSeenAt`** | `/v1/listings/sale` -> `lastSeenDate` (ISO-8601 string, fallback `listedDate`) | Timestamp when RentCast most recently verified the listing active |
| **`avmPrice`** | `/v1/avm/value` -> `price` (number, USD) | **RentCast comparable-listing AVM point midpoint estimate** |
| **`avmLow`**, **`avmHigh`** | `/v1/avm/value` -> `priceRangeLow`, `priceRangeHigh` (number, USD) | **RentCast AVM uncertainty interval bounds** (`0 < avmLow <= avmPrice <= avmHigh`) |
| **`avmFetchedAt`** | Server clock (ISO-8601 UTC string) | Timestamp when `/v1/avm/value` was fetched by the server |
| **`lastSalePrice`**, **`lastSaleDate`** | `/v1/avm/value` -> `subjectProperty.lastSalePrice`, `subjectProperty.lastSaleDate` (or `/v1/properties` -> `lastSalePrice`, `lastSaleDate`) | **Historical closed deed transaction price and date** (never substituted for `avmPrice` or `askingPrice`) |
| **`assessedValue`** | `/v1/avm/value` -> `subjectProperty.taxAssessments[latestYear].value` (or `/v1/properties` -> `taxAssessments[latestYear].value`) | **County tax assessor valuation** for the most recent assessment year (never substituted for market value or AVM) |
| **`comparablesSummary`** | `/v1/avm/value` -> `comparables[]` (`id`, `formattedAddress`, `price`, `distance`, `correlation`, `daysOld`, `status`, `lastSeenDate`) | Summarizes comp count, median comp price, min/max distance, mean correlation, and **`subjectIncludedInComps`** circularity check |

### 2.3 RentCast Field Hygiene, Circularity Detection & PII Stripping Rules

1. **Comparable-Listing AVM Methodology & Subject Duplication Check (`subjectIncludedInComps`):**
   - RentCast's `/v1/avm/value` endpoint estimates market value from nearby comparable listings (`comparables[]`).
   - Because active listings can appear in the comparable pool, our normalizer inspects every element of `comparables[]` against the subject property (`comp.id === subject.id`, normalized `comp.formattedAddress === subject.formattedAddress`, or geodesic distance `< 15m` with matching price).
   - If a match is detected, `comparablesSummary.subjectIncludedInComps` is set to `true` and surfaced as an explicit **contrary-evidence / circularity warning** in the UI and `/api/explain` payload.
2. **Property Identity, Unit & Currency Hygiene:**
   - Reject or flag non-positive prices (`<= 0`), `NaN`/`Infinity`, inverted AVM bounds (`avmLow > avmHigh`), or mismatched property types (e.g., vacant `"Land"` compared against built residential comps).
   - All monetary values are validated as whole-property USD amounts (never monthly rental rates from `/v1/listings/rental` or `/v1/avm/rent`).
3. **Strict Owner & Agent PII Stripping:**
   - Upstream RentCast records can contain `owner` (`owner.names`, `owner.mailingAddress`, `owner.type`, `ownerOccupied`), `agent` (`name`, `phone`, `email`), and `office` contact fields.
   - The server normalizer (`src/server/property/rentcastClient.ts`) **strips all owner names, owner mailing addresses, and personal agent phone/email fields immediately upon ingestion** before caching or returning JSON to the client.

---

## 3. US Region Geocoding Sources

Foreal-Estate supports resolving any user-entered US city/state, neighborhood, ZIP code, or interactive map area (`POST /api/regions/resolve`) without hardcoding Berkeley, CA.

### 3.1 US Census Geocoder REST API (Primary US Address / Coordinate Geographies)
- **Official Documentation URL (Verified 2026-11-13 / 2026-11-14):**
  - `https://www.census.gov/programs-surveys/geography/technical-documentation/complete-technical-documentation/census-geocoder.html`
- **Verified Endpoints:**
  - One-line address lookup: `GET https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?address=<query>&benchmark=Public_AR_Current&format=json`
  - Reverse coordinate lookup (US coverage check): `GET https://geocoding.geo.census.gov/geocoder/geographies/coordinates?x=<lng>&y=<lat>&benchmark=Public_AR_Current&vintage=Current_Current&format=json`
- **License & Cost:** US Federal Public Domain (17 U.S.C. § 105); free, no API key required.
- **Limitations:** Covers only the United States and US territories; optimized for street addresses and coordinate-to-state/county/tract validation rather than informal neighborhood names.

### 3.2 OpenStreetMap Nominatim API (City, Neighborhood & ZIP Resolution)
- **Official Documentation & Policy URLs (Verified 2026-11-13 / 2026-11-14):**
  - API Overview: `https://nominatim.org/release-docs/latest/api/Overview/`
  - Usage Policy: `https://operations.osmfoundation.org/policies/nominatim/`
- **Verified Endpoints:**
  - Forward search: `GET https://nominatim.openstreetmap.org/search?q=<query>&countrycodes=us&format=jsonv2&addressdetails=1&limit=5`
  - Reverse lookup: `GET https://nominatim.openstreetmap.org/reverse?lat=<lat>&lon=<lng>&format=jsonv2&addressdetails=1`
- **Mandatory Operational & License Rules:**
  - **License & Attribution:** ODbL 1.0; requires visible `© OpenStreetMap contributors` attribution (`https://www.openstreetmap.org/copyright`).
  - **Rate Limit:** Maximum **1 request per second** across the entire application instance.
  - **Custom `User-Agent`:** Every request includes an explicit descriptive `User-Agent` header (`ForealEstateHackathonPrototype/1.0 (Berkeley-DeepMind-Hackathon; contact-via-repo)`).
  - **No Keystroke Autocomplete:** Region resolution runs only on explicit user form submission (`POST /api/regions/resolve`), never on keystroke typing, and responses are cached in the server region cache.
  - **Viewport / Circle Approximation Honesty:** Resolved candidate areas explicitly set `isViewportApproximation: true` with a bounded center (`centerLat`, `centerLng`) and `radiusMeters`, clearly stating in the UI that the analysis area is a circular/viewport approximation rather than an official municipal or neighborhood boundary polygon.

---

## 4. OpenStreetMap / Overpass API (`osm_overpass` & `osm_extract`)

- **Official Documentation & Policy URLs (Verified 2026-11-13 / 2026-11-14):**
  - Overpass API Wiki & Commons Policy: `https://wiki.openstreetmap.org/wiki/Overpass_API` and `https://dev.overpass-api.de/overpass-doc/en/preface/commons.html`
  - ODbL 1.0 License: `https://opendatacommons.org/licenses/odbl/1.0/` and `https://www.openstreetmap.org/copyright`
- **Endpoint Configuration:**
  - Controlled via `OSM_OVERPASS_URL` (defaults to `https://overpass-api.de/api/interpreter` when a custom/managed instance is not supplied).
  - **Production Governance:** Public Overpass servers are shared community infrastructure with fair-use limits (`< 10,000 queries/day` application-wide and strict memory/timeout ceilings). Foreal-Estate never assumes public Overpass is an unlimited backend:
    1. Queries are strictly bounded to the influence-buffered circle `analysisArea.radiusMeters + maxCategoryRadiusMeters` (`<= 9,000m` maximum total radius, combining `maxAreaRadiusMeters = 5,000m` and `maxCategoryRadiusMeters = 4,000m`) with `[out:json][timeout:10]`.
    2. All Overpass responses are cached server-side by quantized center/radius/category signature.
    3. If Overpass times out or returns HTTP 429/5xx, the server does **not** fabricate zero-facility scores; affected weighted categories are marked `status: "unknown"` and overall completeness degrades to `"partial"` or `"unknown"` per [`docs/SCORING.md`](SCORING.md).

---

## 5. US EPA Facility Registry Service (FRS) / Envirofacts REST API (`epa_frs`)

- **Official Documentation URLs (Verified 2026-11-13 / 2026-11-14):**
  - Envirofacts RESTful Data Service API: `https://www.epa.gov/envirofacts/envirofacts-data-service-api`
  - Facility Registry Service (FRS) API: `https://www.epa.gov/frs/facility-registry-service-frs-api`
  - Intergovernmental FRS API: `https://www.epa.gov/frs/intergovernmental-frs-api`
- **Verified Endpoints:**
  - Envirofacts table service: `GET https://data.epa.gov/efservice/FRS_PROGRAM_FACILITY/.../JSON` or `GET https://data.epa.gov/efservice/V_ENV_GEO_FAC/.../JSON`
  - FRS facility query service: `GET https://ofmpub.epa.gov/frs_public2/frs_rest_services.get_facilities` (parameters: `latitude83`, `longitude83`, `search_radius`, `pgm_sys_acrnm`, `output=JSON`)
- **License & Attribution:**
  - US Federal Public Domain (17 U.S.C. § 105). Attributed in the UI as `US EPA Facility Registry Service (FRS) / Envirofacts`.
- **Coverage, Limitations & Due-Diligence Guardrails:**
  - Surfaces documented federal/state environmental program registrations (e.g., `RCRAInfo` hazardous waste handlers, `TRI` Toxic Release Inventory reporters, `ICIS-AIR` air emissions permits, `NPDES` water discharge permits).
  - **Not an Automatic Health Determination:** The presence of an FRS registry record indicates a regulated permit or reporting history, not verified current contamination or residential health harm.
  - **Separate Layer Rule:** EPA FRS records populate a dedicated, user-toggleable `environmentalLayer` (`EnvironmentalRecord[]`) for human due diligence. Bare OSM `landuse=industrial`, `man_made=works`, or `telecom=data_center` tags are treated neutrally and never trigger automatic environmental penalties.

---

## 6. Google Maps JavaScript API & Google Places API (`google_places_context`)

- **Official Documentation & Terms URLs (Verified 2026-11-13 / 2026-11-14):**
  - Google Maps Platform Terms of Service: `https://cloud.google.com/maps-platform/terms`
  - Maps JavaScript API: `https://developers.google.com/maps/documentation/javascript`
  - Places API Policies & Attribution: `https://developers.google.com/maps/documentation/places/web-service/policies`
  - Places Aggregate API (Area Insights): `https://developers.google.com/maps/documentation/places/aggregate`
- **Key Separation & Security:**
  - `GOOGLE_MAPS_BROWSER_KEY` is an HTTP-referrer-restricted browser key served intentionally via `GET /api/config` solely to initialize the client-side Google Maps JS basemap.
  - `GOOGLE_PLACES_SERVER_KEY` is an optional server-only secret never exposed to the browser.
- **Strict License Compliance (`google_places_context`):**
  - Section 3.2.3 of the Google Maps Platform ToS prohibits scraping, bulk downloading, building independent location databases, or using Places content to compute derived spatial indices/scores outside permitted services.
  - Consequently, `google_places_context` is restricted to **attributed live display-only context** alongside the Google Map. It is hard-blocked (`analysisEligible: false`) from `src/server/geospatial/scoring.ts`, grid overlap cells, feature storage, and `/api/explain` evidence.
- **Note on Google Places Aggregate / Area Insights API:**
  - Google offers the **Places Aggregate API** (`https://developers.google.com/maps/documentation/places/aggregate`) specifically for macro area counts (`INSIGHTS_COUNT`) within a polygon or radius. Because Places Aggregate requires separate product enablement and commercial agreement verification, it is documented as an optional future analytics integration and kept **out of the MVP critical path**; all MVP accessibility scores rely exclusively on ODbL-licensed OpenStreetMap (`osm_overpass` / `osm_extract`) and public-domain US EPA (`epa_frs`) data.
