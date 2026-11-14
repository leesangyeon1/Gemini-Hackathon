# Deterministic Geospatial Scoring & Price-Gap Specification (`SCORING.md`)

**Owner:** `geospatial`  
**Implementation Modules:** `src/server/geospatial/sourcePolicy.ts`, `src/server/geospatial/scoring.ts`

---

## 1. Design Principles & Non-Claims

Foreal-Estate separates spatial convenience preferences, environmental due-diligence records, and statistical property price comparisons into distinct, transparent, deterministic server-side calculations:

1. **Zero LLM Math**: All coordinate validations, WGS84 geodesic distances, deduplication, linear distance-decay kernels, saturation caps, accessibility scores, grid overlap matrices, and asking-vs-AVM price-gap calculations are executed by pure deterministic TypeScript functions on the server. Runtime Gemini (`/api/explain`) only narrates pre-computed server numbers and bounded evidence IDs.
2. **Uncalibrated User Preferences (Never Market Dollars)**: Accessibility scores ($A \in [0, 100]$) measure alignment with user-configurable proximity preferences. Default weights and radii are **authored starting points for user exploration, never learned hedonic price premiums**.
3. **Strict Independence of AVM and Accessibility**: The server **never** multiplies, scales, shifts, or adjusts RentCast AVM point or range estimates (`avmPrice`, `avmLow`, `avmHigh`) by facility accessibility scores or environmental indicators.
4. **Commercial & Brand Neutrality**: Optional commercial/fast-food context (`fast_food` / `commercial`) carries a **default weight of `0`** and makes **no causal appreciation claims** (e.g., never claiming that proximity to McDonald's or any retail chain causes home price appreciation).
5. **No Demographic or Protected-Class Scoring**: Scoring uses only physical facility coordinates from licensed open/public datasets. No demographic, resident, tenant, borrower, crime-index, or protected-group attributes are ingested or scored.

---

## 2. Coordinate Validation & WGS84 Geodesic Distance

### 2.1 Strict Finite Coordinate Validation

Every coordinate pair $(\text{lat}, \text{lng})$ ingested from user requests, property records, or external facility providers must pass `validateCoordinates(lat, lng)` before distance or grid math:

- `typeof lat === "number"` and `typeof lng === "number"`
- `Number.isFinite(lat)` and `Number.isFinite(lng)` (`NaN`, `+Infinity`, and `-Infinity` are rejected)
- $-90 \le \text{lat} \le 90$
- $-180 \le \text{lng} \le 180$

Invalid coordinates throw a typed `InvalidCoordinateError` (or are rejected at validation boundaries with structured diagnostics).

### 2.2 WGS84 Geodesic Distance Formula ($d$)

Given two validated coordinates $\mathbf{p}_1 = (\phi_1, \lambda_1)$ and $\mathbf{p}_2 = (\phi_2, \lambda_2)$ in decimal degrees, `computeGeodesicDistanceMeters(p1, p2)` computes the great-circle surface distance $d$ in meters using the WGS84 IUGG mean Earth radius $R_{\text{WGS84}} = 6,371,008.8\text{ m}$:

$$\Delta\phi = \frac{\pi}{180}(\phi_2 - \phi_1), \qquad \Delta\lambda = \frac{\pi}{180}(\lambda_2 - \lambda_1)$$

$$\phi_{1,\text{rad}} = \frac{\pi}{180}\phi_1, \qquad \phi_{2,\text{rad}} = \frac{\pi}{180}\phi_2$$

$$h = \sin^2\left(\frac{\Delta\phi}{2}\right) + \cos(\phi_{1,\text{rad}})\cos(\phi_{2,\text{rad}})\sin^2\left(\frac{\Delta\lambda}{2}\right)$$

$$d = 2 R_{\text{WGS84}} \arcsin\left(\min\left(1, \sqrt{\max(0, h)}\right)\right)$$

- **Identical coordinates**: When $\phi_1 = \phi_2$ and $\lambda_1 = \lambda_2$, $d = 0\text{ m}$ exactly.
- **Symmetry**: $d(\mathbf{p}_1, \mathbf{p}_2) = d(\mathbf{p}_2, \mathbf{p}_1)$ to IEEE-754 floating-point precision.
- **Clamping**: $\max(0, h)$ and $\min(1, \sqrt{h})$ prevent floating-point domain errors (`NaN`) near coincident or antipodal points.

### 2.3 Explicit Limitation: Geodesic Circles Are Not Isochrones

> [!IMPORTANT]
> Straight-line geodesic distances ($d$ in meters) and circular buffers ($d \le \text{radius}_c$) measure **surface distance on the WGS84 reference sphere**, **not** walking-time, cycling-time, driving-time, or transit-network isochrones. They do not model road networks, pedestrian bridges, elevation gain, highway barriers, or transit schedules.

---

## 3. Influence-Radius Buffer (Boundary Completeness)

When evaluating properties or grid cells inside a user-selected `analysisArea` (centered at $(\phi_0, \lambda_0)$ with radius `analysisArea.radiusMeters`), a property located near the perimeter of `analysisArea` is still influenced by facilities situated just outside the `analysisArea` boundary up to $\max_c(\text{radius}_c)$.

To prevent artificial boundary drop-off ("edge clipping") near the perimeter of the selected area, the server expands the upstream geospatial fetch radius to:

$$R_{\text{fetch}} = \text{analysisArea.radiusMeters} + \max_{c \in \mathcal{C}} (\text{radius}_c)$$

where $\max_{c \in \mathcal{C}}(\text{radius}_c)$ is the maximum positive kernel radius across all active/configured categories (with a minimum safety floor when only default radii apply).

- **Property & Grid Evaluation Scope**: Properties and heatmap grid cells are restricted to `analysisArea.radiusMeters`.
- **Facility Support Scope**: Eligible facilities within $R_{\text{fetch}}$ of $(\phi_0, \lambda_0)$ are retained so any point inside `analysisArea` has complete neighborhood coverage across its full kernel radius $\text{radius}_c$.

---

## 4. Server-Side Source-Policy Enforcement (`sourcePolicy.ts`)

All geospatial records carry a canonical `SourceId`. Eligibility for spatial scoring, grid overlap heatmaps, derived feature storage, and grounded Gemini `/api/explain` evidence is governed **exclusively** by the immutable server-side `SOURCE_POLICY_REGISTRY` in `src/server/geospatial/sourcePolicy.ts`—never by client-supplied flags.

| `SourceId` | Provider / Dataset | License & Attribution | `analysisEligible` | Allowed Usage |
|---|---|---|---|---|
| `osm_overpass` | OpenStreetMap via Overpass API | Open Database License (ODbL) — `© OpenStreetMap contributors` | `true` | Amenity scoring, grid overlap heatmaps, cached open extracts, `/api/explain` evidence |
| `osm_extract` | Local / Pre-indexed OpenStreetMap Extract | Open Database License (ODbL) — `© OpenStreetMap contributors` | `true` | Amenity scoring, grid overlap heatmaps, cached open extracts, `/api/explain` evidence |
| `epa_frs` | US EPA Facility Registry Service (FRS) | US Federal Public Domain — `US EPA FRS` | `true` *(Environmental Due-Diligence Layer)* | Separate user-controlled environmental due-diligence layer & `/api/explain` context |
| `synthetic_demo` | Opt-in Synthetic Demo Fixtures (`ENABLE_SYNTHETIC_DEMO_MODE=true`) | Internal Synthetic Test Data (Explicitly Badged) | `true` *(Only when synthetic demo mode enabled)* | Badged offline/demo scoring & deterministic verification |
| `google_places_context` | Google Maps Places API | Google Maps Platform Terms of Service | **`false` (ALWAYS)** | **Display-only attributed UI context; strictly barred from scoring, heatmaps, feature storage, and `/api/explain` evidence** |

### Enforcement Invariants

1. **Unconditional Rejection of `google_places_context`**:
   - `isSourceAnalysisEligible("google_places_context")` returns `false` unconditionally.
   - Even if an incoming record or caller payload sets `sourceId: "google_places_context"` alongside `analysisEligible: true` and conforms to the exact `FacilityRecord` schema, `assertSourceAnalysisEligible` and `partitionFacilitiesBySourcePolicy` strip the caller flag, reject the record from all mathematical scoring/grid/evidence pipelines, and record the rejection count in diagnostics.
2. **Unregistered / Unknown Sources**:
   - Any unrecognized `sourceId` not present in `SOURCE_POLICY_REGISTRY` defaults to `analysisEligible: false` and is rejected.

---

## 5. Conservative Order-Invariant Deduplication

OpenStreetMap queries frequently return multiple geometric primitives for a single real-world establishment (e.g., both a `node` tag and a `way` building footprint for the same grocery store or school), and upstream HTTP responses do not guarantee stable ordering.

To ensure **bit-identical accessibility scores across any permutation of the input facility array**, `deduplicateFacilities` performs a two-stage deterministic procedure:

### Stage 1: Canonical Total-Order Sort
All eligible input facilities are sorted via `compareFacilitiesCanonical(a, b)` using the strict lexical tuple:
1. Normalized category key (`category.trim().toLowerCase()`) ascending
2. Normalized facility name (`normalizeFacilityName(name)`: NFKD-normalized, lowercase, non-alphanumeric characters collapsed to single spaces, trimmed; empty names sort after named entries) ascending
3. Canonical coordinate latitude rounded to $10^{-7}$ degrees (~1.1 cm) ascending, then exact IEEE-754 `lat` ascending
4. Canonical coordinate longitude rounded to $10^{-7}$ degrees ascending, then exact IEEE-754 `lng` ascending
5. Canonical `sourceId` ascending
6. Canonical `externalId` / `id` ascending

### Stage 2: Conservative Duplicate Merging
Iterating through the canonically sorted list, a candidate facility $f_{\text{cand}}$ is merged into an already-accepted canonical facility $f_{\text{kept}}$ of the **same category** if and only if:

1. **Exact Source Record Match**: Both share the same `sourceId` and the same non-empty normalized `externalId` (or `id`); **OR**
2. **Named Proximity Match**: Both have non-empty normalized names that are identical ($\text{normName}(f_{\text{cand}}) = \text{normName}(f_{\text{kept}})$) **AND** their WGS84 geodesic distance satisfies $d(f_{\text{cand}}, f_{\text{kept}}) \le d_{\text{dedup,named}}$ (default **`35` meters**); **OR**
3. **Unnamed Micro-Coincident Match**: Both have empty normalized names (e.g., unnamed transit stops or park nodes in the same category) **AND** $d(f_{\text{cand}}, f_{\text{kept}}) \le d_{\text{dedup,unnamed}}$ (default **`10` meters**).

Because canonical sorting establishes a strict total order prior to greedy representative selection, **permuting the input facility array in any order yields the exact same retained facilities in the exact same order, producing bit-identical floating-point sums and scores**.

---

## 6. Facility Kernel & Category Saturation Math

### 6.1 Linear Distance-Decay Kernel ($k_{i,c}$)

For an evaluation point $\mathbf{x} = (\phi, \lambda)$ and each eligible, deduplicated facility $i \in \mathcal{F}_c$ in category $c$ located at geodesic distance $d_i = d(\mathbf{x}, \mathbf{f}_i)$, the facility kernel contribution $k_{i,c} \in [0, 1]$ is:

$$k_{i,c} = \begin{cases} \max\left(0, 1 - \dfrac{d_i}{\text{radius}_c}\right) & \text{if } \text{radius}_c > 0 \text{ and } 0 \le d_i \le \text{radius}_c \\[8pt] 0 & \text{otherwise} \end{cases}$$

- At $d_i = 0\text{ m}$: $k_{i,c} = 1.0$.
- At $d_i = 0.5 \times \text{radius}_c$: $k_{i,c} = 0.5$.
- At $d_i \ge \text{radius}_c$: $k_{i,c} = 0.0$ (facilities beyond $\text{radius}_c$ contribute zero).

### 6.2 Category Intensity & Diminishing-Returns Saturation ($a_c$)

Raw kernel contributions in category $c$ are summed in canonical facility order and saturated against the category saturation cap $\text{cap}_c > 0$:

$$K_c = \sum_{i \in \mathcal{F}_c} k_{i,c}$$

$$a_c = \min\left(1, \frac{K_c}{\text{cap}_c}\right) \in [0, 1]$$

- **Why saturation is required**: A neighborhood with 2 nearby grocery stores at close range ($K_{\text{grocery}} \ge 2.0$) reaches full convenience saturation ($a_{\text{grocery}} = 1.0$). Without $\text{cap}_c$, a dense downtown strip with 25 convenience stores would overwhelm parks, schools, and healthcare.
- **Invalid cap protection**: $\text{cap}_c$ must be finite and strictly positive ($\text{cap}_c > 0$).

---

## 7. Accessibility Score ($A \in [0, 100]$) & Default Preference Profile

### 7.1 Weighted Accessibility Formula

Given user preference weights $w_c \ge 0$ across categories $c \in \mathcal{C}$ (negative weights $w_c < 0$ are rejected by validation):

$$W_{\text{total}} = \sum_{c \in \mathcal{C}} w_c$$

If $W_{\text{total}} = 0$, the composite accessibility score is defined as $A = 0$. Otherwise:

$$A = 100 \times \frac{\sum_{c \in \mathcal{C}_{\text{known}}} w_c a_c}{\sum_{c \in \mathcal{C}} w_c} \in [0, 100]$$

where $\mathcal{C}_{\text{known}}$ is the subset of categories whose data source status is healthy (`"ok"`). Categories whose upstream source failed or timed out (`status: "unknown"`) contribute $0$ to the numerator while their weight $w_c$ **remains in the denominator $W_{\text{total}}$** (see Section 8).

### 7.2 Default Categories & Parameters

| Category Key | Display Label | Default Weight ($w_c$) | Default Radius ($\text{radius}_c$) | Default Saturation Cap ($\text{cap}_c$) | Primary OSM / Open Tags |
|---|---|---:|---:|---:|---|
| `grocery` | Grocery & Supermarkets | `25` | `1600 m` (~1.0 mi) | `2.0` | `shop=supermarket`, `shop=grocery`, `shop=greengrocer` |
| `parks` | Parks & Green Space | `20` | `1200 m` (~0.75 mi) | `2.5` | `leisure=park`, `leisure=nature_reserve`, `leisure=garden` |
| `transit` | Public Transit Stops & Stations | `20` | `1000 m` (~0.62 mi) | `3.0` | `railway=station`, `railway=tram_stop`, `highway=bus_stop`, `public_transport=platform` |
| `healthcare` | Healthcare, Clinics & Pharmacies | `15` | `2400 m` (~1.5 mi) | `2.0` | `amenity=hospital`, `amenity=clinic`, `amenity=pharmacy`, `amenity=doctors` |
| `schools` | Schools & Public Libraries | `20` | `1600 m` (~1.0 mi) | `2.0` | `amenity=school`, `amenity=library`, `amenity=kindergarten` |
| `fast_food` *(optional context)* | Commercial / Fast-Food Context | **`0`** | `1200 m` (~0.75 mi) | `3.0` | `amenity=fast_food`, `amenity=restaurant`, `amenity=cafe` |

> [!NOTE]
> **Authored Preferences & Fast-Food Non-Causal Rule:**  
> 1. The default weights (`25, 20, 20, 15, 20, 0`) sum to `100` for intuitive interpretation and represent **authored convenience starting points**, never empirical real-estate valuation weights.  
> 2. `fast_food` defaults to weight **`0`**. Users may optionally adjust it to explore commercial density, but Foreal-Estate **never** asserts that fast-food chains (e.g., McDonald's) or retail brands cause property appreciation or higher home values.

---

## 8. Missing vs. Zero vs. Failed Source Handling

A critical reliability failure in naive geospatial apps is conflating "0 facilities exist nearby" with "the Overpass API timed out," or silently renormalizing weights when a category fails. Foreal-Estate enforces three distinct states per category:

1. **Healthy Source with Zero Facilities (`status: "ok"`, `facilityCount: 0`)**:
   - The upstream source responded normally and returned zero matching facilities within $\text{radius}_c$.
   - $K_c = 0 \implies a_c = 0.0$.
   - Category status is `"ok"`. Overall completeness remains `"complete"` (assuming all other weighted categories also succeeded).
2. **Failed or Timed-Out Source for a Weighted Category ($w_c > 0$, `status: "unknown"`)**:
   - The upstream source timed out, returned an HTTP error, or was unavailable.
   - Category status is recorded as `"unknown"`, its intensity is marked `unknown` (`a_c = null` in breakdown, effective contribution `0` in numerator), and the category key is appended to `missingOrFailedCategories`.
   - **No Silent Renormalization**: The failed category's weight $w_c$ is **held inside the denominator $\sum_{c \in \mathcal{C}} w_c$**.
     - *Worked Example*: Suppose a user sets $w_{\text{grocery}} = 50$ and $w_{\text{transit}} = 50$ (all other weights `0`). Suppose `grocery` succeeds with $a_{\text{grocery}} = 0.80$, while `transit` times out (`status: "unknown"`).
     - Naive renormalization would divide by $50$ and report $A = 80.0$, hiding the missing half of the user's criteria.
     - Foreal-Estate divides by $W_{\text{total}} = 50 + 50 = 100$, yielding $A = 100 \times \frac{50 \times 0.80 + 0}{100} = 40.0$, alongside `completeness: "partial"`, `missingOrFailedCategories: ["transit"]`, `failedWeightedCategories: ["transit"]`, `knownWeight: 50`, and `knownWeightFraction: 0.5` (noting that even if the unknown category achieved maximum saturation $a_{\text{transit}} = 1.0$, the score could not exceed $90.0$).
3. **Overall Completeness Classification (`completeness`)**:
   - `"complete"`: Every weighted category ($w_c > 0$) has source status `"ok"`. (If an unweighted category with $w_c = 0$ failed, completeness is still `"complete"` because it has zero influence on $A$.)
   - `"partial"`: At least one weighted category ($w_c > 0$) has status `"ok"` **and** at least one weighted category ($w_c > 0$) has status `"unknown"`.
   - `"unknown"`: Every weighted category ($w_c > 0$) has status `"unknown"` (or no weighted categories succeeded).

---

## 9. Bounded Grid / Kernel Venn-Like Multi-Category Overlap

Rather than computing $2^N$ polygon intersections of circular buffers (which creates brittle sliver polygons and loses distance-decay intensity), `computeBoundedGridOverlap` evaluates a **bounded regular latitude/longitude grid** across `analysisArea`:

1. **Bounded Grid Generation**:
   - Given `analysisArea` center $(\phi_0, \lambda_0)$ and `radiusMeters`, the bounding box $[\phi_{\min}, \phi_{\max}] \times [\lambda_{\min}, \lambda_{\max}]$ is partitioned into an $M \times M$ regular grid where $M$ is clamped to $[4, 20]$ (default $M = 11$, at most $400$ candidate cells).
   - Only cell centers $\mathbf{g} = (\phi_g, \lambda_g)$ within `analysisArea.radiusMeters` ($d((\phi_0, \lambda_0), \mathbf{g}) \le \text{analysisArea.radiusMeters}$) are retained.
2. **Per-Cell Multi-Category Evaluation**:
   - For each retained cell $\mathbf{g}$, `computeAccessibilityScore` evaluates per-category intensity $a_c(\mathbf{g}) \in [0, 1]$ and composite score $A(\mathbf{g}) \in [0, 100]$.
   - Given an active overlap threshold $\tau_{\text{overlap}} \in (0, 1]$ (default $\tau_{\text{overlap}} = 0.25$, equivalent to at least one facility within $75\%$ of $\text{radius}_c$ for $\text{cap}_c = 1$, or proportional multi-facility presence):
     $$\text{presentCategories}(\mathbf{g}) = \{ c \in \mathcal{C}_{\text{active}} \mid a_c(\mathbf{g}) \ge \tau_{\text{overlap}} \}$$
     $$\text{overlapCount}(\mathbf{g}) = |\text{presentCategories}(\mathbf{g})|$$
     $$\text{minActiveIntensity}(\mathbf{g}) = \min_{c \in \mathcal{C}_{\text{active}}} a_c(\mathbf{g})$$
3. **Venn-Like Sweet-Spot Identification**:
   - Cells where $\text{overlapCount}(\mathbf{g}) = |\mathcal{C}_{\text{active}}|$ (or highest observed $\text{overlapCount}$) represent the multi-category intersection zone ("Venn overlap sweet spot") without combinatorial geometry explosion.

---

## 10. Separate Environmental Due-Diligence Layer (`epa_frs`)

### 10.1 Neutrality of Bare Industrial / Infrastructure Tags
- Bare OpenStreetMap land-use or building tags such as `industrial=factory`, `man_made=works`, or `telecom=data_center` without documented regulatory program records are treated as **neutral physical context** and are **never** scored as automatic negative externalities.

### 10.2 US EPA FRS Records as Separate Due-Diligence Context
- Facilities from the US EPA Facility Registry Service (`sourceId: "epa_frs"`) with documented regulatory program links (e.g., RCRA hazardous waste, CAA air emissions, CWA/NPDES water discharge, TRI toxic release inventory, or SEMS/Superfund status) are surfaced in a **separate `environmentalLayer` collection**.
- Each environmental record includes:
  - Geodesic distance $d_i$ in meters from the subject point or area center
  - Documented EPA program acronyms/descriptions and registry ID
  - Explicit disclaimer: *"Regulatory registration/permit record for user-controlled human due diligence; not an automatic environmental hazard or health determination."*

### 10.3 Optional User Externality Preference Index
- If a user explicitly enables an optional externality penalty weight in their preference exploration, the resulting number is explicitly labeled an **Uncalibrated User Preference Score ($0\text{–}100$)**, **never market dollars**, and **never** modifies RentCast AVM estimates.

---

## 11. Asking-vs-AVM Price-Gap & Range Classification (`computePriceGap`)

### 11.1 Point-Estimate Gap Formula (`gapPct`)

For a residential property with active listing price `askingPrice` (USD) and RentCast AVM point estimate `avmPrice` (USD):

- If `askingPrice` and `avmPrice` are both finite positive numbers ($\text{askingPrice} > 0$ and $\text{avmPrice} > 0$):

$$\text{gapPct} = 100 \times \frac{\text{avmPrice} - \text{askingPrice}}{\text{avmPrice}}$$

- **Sign Convention**:
  - $\text{gapPct} > 0$: `askingPrice < avmPrice` (the asking price is below the AVM midpoint estimate by $\text{gapPct}\%$).
  - $\text{gapPct} = 0$: `askingPrice === avmPrice`.
  - $\text{gapPct} < 0$: `askingPrice > avmPrice` (the asking price is above the AVM midpoint estimate by $|\text{gapPct}|\%$).
- If either `avmPrice` or `askingPrice` is `null`, `undefined`, `NaN`, $\pm\infty$, or $\le 0$:
  - `gapPct = null`
  - `gapAmountUsd = null`
  - `rangePosition = "no_avm"`

### 11.2 AVM Confidence-Range Classification (`rangePosition`)

RentCast AVM responses provide a confidence interval `[avmLow, avmHigh]` around `avmPrice`. Because statistical AVM ranges often span $\pm 10\%$ to $\pm 20\%$, a positive `gapPct` alone does **not** establish that a listing is outside the model's expected valuation range.

When `askingPrice > 0` and `avmPrice > 0`, `computePriceGap` validates `avmLow` and `avmHigh`:
- **Valid Range Bounds**: `Number.isFinite(avmLow) && Number.isFinite(avmHigh) && avmLow > 0 && avmHigh > 0 && avmLow <= avmHigh`.

| `rangePosition` | Condition | Interpretation & UI Guardrail |
|---|---|---|
| `"no_avm"` | `avmPrice` or `askingPrice` is missing, non-finite, or $\le 0$ | No AVM comparison can be computed. |
| `"range_unknown"` | `avmPrice > 0` and `askingPrice > 0` (so `gapPct` is valid), **but** `avmLow` or `avmHigh` is missing, non-finite, $\le 0$, or inverted (`avmLow > avmHigh`) | Point `gapPct` is reported, while range position is explicitly marked unknown. |
| `"in_range"` | Valid bounds and $\text{avmLow} \le \text{askingPrice} \le \text{avmHigh}$ | Asking price sits **within** the AVM statistical range (normal dispersion, even if `gapPct > 0` or `gapPct < 0`). |
| `"below_estimate_range_candidate"` | Valid bounds and $\text{askingPrice} < \text{avmLow}$ | Asking price is below the lower bound of the AVM range — a **candidate signal for human due diligence**, never proven undervaluation. |
| `"above_estimate_range_candidate"` | Valid bounds and $\text{askingPrice} > \text{avmHigh}$ | Asking price is above the upper bound of the AVM range — may reflect uncaptured renovations, lot premium, or seller optimism. |

### 11.3 Canonical Numerical Verification Cases

1. **Below-Midpoint & Below-Range Candidate**:
   - Inputs: `avmPrice = 500,000`, `askingPrice = 450,000`, `avmLow = 460,000`, `avmHigh = 540,000`
   - Calculation: $\text{gapPct} = 100 \times (500,000 - 450,000) / 500,000 = +10.0\%$
   - Range Classification: `450,000 < 460,000` $\implies$ `"below_estimate_range_candidate"`
2. **Positive Point Gap Inside AVM Range (Mandatory Guardrail Case)**:
   - Inputs: `avmPrice = 1,000,000`, `askingPrice = 900,000`, `avmLow = 850,000`, `avmHigh = 1,150,000`
   - Calculation: $\text{gapPct} = 100 \times (1,000,000 - 900,000) / 1,000,000 = +10.0\%$
   - Range Classification: `850,000 <= 900,000 <= 1,150,000` $\implies$ `"in_range"`
   - **Mandatory Non-Claim**: Although `askingPrice` is `+10.0%` below the `$1,000,000` AVM midpoint, `$900,000` lies inside `[850,000, 1,150,000]`. The application must classify this as **`+10.0%` AND `in_range` (not proven undervaluation)**.
3. **Valid Point Gap with Missing or Inverted Range Bounds**:
   - Inputs: `avmPrice = 500,000`, `askingPrice = 450,000`, `avmLow = 550,000`, `avmHigh = 480,000` (inverted) or `avmLow = null`
   - Calculation: $\text{gapPct} = +10.0\%$
   - Range Classification: `"range_unknown"`
4. **Missing or Non-Positive AVM**:
   - Inputs: `avmPrice = null` (or `0` or `-500,000`), `askingPrice = 450,000`
   - Calculation: `gapPct = null`
   - Range Classification: `"no_avm"`
