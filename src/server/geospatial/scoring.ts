/**
 * Pure Deterministic Geospatial Scoring, Deduplication, Grid Overlap & Price-Gap Math (`scoring.ts`)
 *
 * Implements the authoritative formulas defined in `docs/SCORING.md` with zero external
 * runtime dependencies.
 */

import {
  type SourceId,
  type SourcePolicyCheckOptions,
  isSourceEnvironmentalEligible,
  partitionFacilitiesBySourcePolicy,
} from "./sourcePolicy";

/**
 * WGS84 IUGG mean Earth radius in meters.
 */
export const WGS84_MEAN_EARTH_RADIUS_METERS = 6_371_008.8;

/**
 * Default geodesic distance threshold (meters) for merging duplicate named facilities
 * in the same category.
 */
export const DEFAULT_NAMED_DEDUP_THRESHOLD_METERS = 35;

/**
 * Default geodesic distance threshold (meters) for merging duplicate unnamed facilities
 * in the same category.
 */
export const DEFAULT_UNNAMED_DEDUP_THRESHOLD_METERS = 10;

/**
 * Default category intensity threshold (a_c >= tau) for Venn-like multi-category grid overlap.
 */
export const DEFAULT_OVERLAP_INTENSITY_THRESHOLD = 0.25;

export interface CoordinatePoint {
  readonly lat: number;
  readonly lng: number;
}

export class InvalidCoordinateError extends Error {
  public readonly code = "INVALID_COORDINATE" as const;
  public readonly lat: unknown;
  public readonly lng: unknown;

  constructor(lat: unknown, lng: unknown, label = "coordinate") {
    super(
      `Invalid ${label}: expected finite numbers with -90 <= lat <= 90 and -180 <= lng <= 180, received (${String(
        lat
      )}, ${String(lng)}).`
    );
    this.name = "InvalidCoordinateError";
    this.lat = lat;
    this.lng = lng;
  }
}

/**
 * Checks whether `lat` and `lng` are finite numbers within valid WGS84 bounds:
 * `-90 <= lat <= 90` and `-180 <= lng <= 180`.
 */
export function isValidCoordinate(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

/**
 * Validates `lat` and `lng` strictly against WGS84 bounds (`-90 <= lat <= 90`, `-180 <= lng <= 180`,
 * finite IEEE-754 numbers). Throws `InvalidCoordinateError` if invalid.
 */
export function validateCoordinates(
  lat: number,
  lng: number,
  label = "coordinate"
): CoordinatePoint {
  if (!isValidCoordinate(lat, lng)) {
    throw new InvalidCoordinateError(lat, lng, label);
  }
  return {
    lat: lat === 0 ? 0 : lat,
    lng: lng === 0 ? 0 : lng,
  };
}

/**
 * Validates a `CoordinatePoint` object (`{ lat, lng }`).
 */
export function validatePoint(
  point: CoordinatePoint,
  label = "coordinate"
): CoordinatePoint {
  if (!point || typeof point !== "object") {
    throw new InvalidCoordinateError(undefined, undefined, label);
  }
  return validateCoordinates(point.lat, point.lng, label);
}

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function roundClean(value: number, decimals = 6): number {
  const factor = 10 ** decimals;
  const rounded = Math.round((value + Number.EPSILON) * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

/**
 * Computes the WGS84 geodesic surface distance `d` in meters between two coordinates.
 *
 * Supports both:
 * - `computeGeodesicDistanceMeters(pointA, pointB)`
 * - `computeGeodesicDistanceMeters(lat1, lng1, lat2, lng2)`
 *
 * NOTE: Straight-line geodesic distances and radius buffers are NOT walking-time or transit isochrones.
 */
export function computeGeodesicDistanceMeters(
  a: CoordinatePoint,
  b: CoordinatePoint
): number;
export function computeGeodesicDistanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number;
export function computeGeodesicDistanceMeters(
  aOrLat1: CoordinatePoint | number,
  bOrLng1: CoordinatePoint | number,
  maybeLat2?: number,
  maybeLng2?: number
): number {
  let p1: CoordinatePoint;
  let p2: CoordinatePoint;

  if (typeof aOrLat1 === "number" || typeof bOrLng1 === "number") {
    p1 = validateCoordinates(
      aOrLat1 as number,
      bOrLng1 as number,
      "origin coordinate"
    );
    p2 = validateCoordinates(
      maybeLat2 as number,
      maybeLng2 as number,
      "destination coordinate"
    );
  } else {
    p1 = validatePoint(aOrLat1, "origin coordinate");
    p2 = validatePoint(bOrLng1, "destination coordinate");
  }

  if (p1.lat === p2.lat && p1.lng === p2.lng) {
    return 0;
  }

  const dLat = toRadians(p2.lat - p1.lat);
  const dLng = toRadians(p2.lng - p1.lng);
  const lat1Rad = toRadians(p1.lat);
  const lat2Rad = toRadians(p2.lat);

  const sinHalfLat = Math.sin(dLat / 2);
  const sinHalfLng = Math.sin(dLng / 2);

  const h =
    sinHalfLat * sinHalfLat +
    Math.cos(lat1Rad) * Math.cos(lat2Rad) * sinHalfLng * sinHalfLng;

  const clampedSqrtH = Math.min(1, Math.sqrt(Math.max(0, h)));
  const centralAngle = 2 * Math.asin(clampedSqrtH);

  return WGS84_MEAN_EARTH_RADIUS_METERS * centralAngle;
}

export const geodesicDistanceMeters = computeGeodesicDistanceMeters;
export const haversineDistanceMeters = computeGeodesicDistanceMeters;

// ============================================================================
// Default Categories & Preference Profiles
// ============================================================================

export const DEFAULT_AMENITY_CATEGORIES = [
  "grocery",
  "parks",
  "transit",
  "healthcare",
  "schools",
  "fast_food",
] as const;

export type DefaultAmenityCategory = (typeof DEFAULT_AMENITY_CATEGORIES)[number];

export interface CategoryDefaultConfig {
  readonly category: DefaultAmenityCategory;
  readonly label: string;
  readonly defaultWeight: number;
  readonly defaultRadiusMeters: number;
  readonly defaultCap: number;
  readonly isOptionalCommercialContext: boolean;
  readonly nonCausalNotice?: string;
}

export const DEFAULT_CATEGORY_CONFIGS: Readonly<
  Record<DefaultAmenityCategory, Readonly<CategoryDefaultConfig>>
> = Object.freeze({
  grocery: Object.freeze({
    category: "grocery",
    label: "Grocery & Supermarkets",
    defaultWeight: 25,
    defaultRadiusMeters: 1600,
    defaultCap: 2.0,
    isOptionalCommercialContext: false,
  }),
  parks: Object.freeze({
    category: "parks",
    label: "Parks & Green Space",
    defaultWeight: 20,
    defaultRadiusMeters: 1200,
    defaultCap: 2.5,
    isOptionalCommercialContext: false,
  }),
  transit: Object.freeze({
    category: "transit",
    label: "Public Transit Stops & Stations",
    defaultWeight: 20,
    defaultRadiusMeters: 1000,
    defaultCap: 3.0,
    isOptionalCommercialContext: false,
  }),
  healthcare: Object.freeze({
    category: "healthcare",
    label: "Healthcare, Clinics & Pharmacies",
    defaultWeight: 15,
    defaultRadiusMeters: 2400,
    defaultCap: 2.0,
    isOptionalCommercialContext: false,
  }),
  schools: Object.freeze({
    category: "schools",
    label: "Schools & Public Libraries",
    defaultWeight: 20,
    defaultRadiusMeters: 1600,
    defaultCap: 2.0,
    isOptionalCommercialContext: false,
  }),
  fast_food: Object.freeze({
    category: "fast_food",
    label: "Commercial / Fast-Food Context (Optional)",
    defaultWeight: 0,
    defaultRadiusMeters: 1200,
    defaultCap: 3.0,
    isOptionalCommercialContext: true,
    nonCausalNotice:
      "Optional commercial/fast-food context defaults to weight 0 and reflects user convenience preference only; never interpreted as causing property appreciation.",
  }),
});

/**
 * Normalizes a category key (mapping common aliases such as `schools_libraries` -> `schools`
 * or `commercial` -> `fast_food` while preserving custom category identifiers).
 */
export function normalizeCategoryKey(rawCategory: string): string {
  const cleaned = String(rawCategory ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");

  switch (cleaned) {
    case "schools_libraries":
    case "school":
    case "education":
    case "libraries":
      return "schools";
    case "commercial":
    case "fast_food_context":
    case "fastfood":
    case "restaurants_fast_food":
      return "fast_food";
    case "park":
    case "green_space":
      return "parks";
    case "supermarket":
    case "groceries":
      return "grocery";
    case "public_transit":
      return "transit";
    case "medical":
    case "health":
    case "pharmacy":
      return "healthcare";
    default:
      return cleaned;
  }
}

/**
 * Computes `max_c(radius_c)` across active/configured categories (falling back to default category radii).
 */
export function computeMaxCategoryRadiusMeters(
  categoryRadiiOrPreferences?:
    | readonly number[]
    | Readonly<Record<string, number>>
    | PreferenceProfileInput
): number {
  let radiiList: number[] = [];

  if (Array.isArray(categoryRadiiOrPreferences)) {
    radiiList = categoryRadiiOrPreferences.filter(
      (r) => typeof r === "number" && Number.isFinite(r) && r > 0
    );
  } else if (
    categoryRadiiOrPreferences &&
    typeof categoryRadiiOrPreferences === "object"
  ) {
    if ("radiiMeters" in categoryRadiiOrPreferences && categoryRadiiOrPreferences.radiiMeters) {
      const weights: Readonly<Record<string, number>> | undefined =
        "weights" in categoryRadiiOrPreferences &&
        categoryRadiiOrPreferences.weights &&
        typeof categoryRadiiOrPreferences.weights === "object"
          ? (categoryRadiiOrPreferences.weights as Readonly<Record<string, number>>)
          : undefined;
      for (const [cat, r] of Object.entries(categoryRadiiOrPreferences.radiiMeters)) {
        const w = weights ? weights[cat] : undefined;
        // Include categories with positive weight (or all configured radii if weights aren't filtering)
        if (typeof r === "number" && Number.isFinite(r) && r > 0 && (w === undefined || w > 0)) {
          radiiList.push(r);
        }
      }
      if (radiiList.length === 0) {
        radiiList = Object.values(categoryRadiiOrPreferences.radiiMeters).filter(
          (r) => typeof r === "number" && Number.isFinite(r) && r > 0
        );
      }
    } else {
      radiiList = Object.values(
        categoryRadiiOrPreferences as Readonly<Record<string, number>>
      ).filter((r) => typeof r === "number" && Number.isFinite(r) && r > 0);
    }
  }

  if (radiiList.length === 0) {
    radiiList = Object.values(DEFAULT_CATEGORY_CONFIGS).map((c) => c.defaultRadiusMeters);
  }

  return Math.max(0, ...radiiList);
}

/**
 * Computes the upstream geospatial fetch radius (`analysisArea.radiusMeters + max(radius_c)`)
 * when called with `(analysisAreaRadiusMeters, categoryRadiiOrPreferences?)`, or returns the
 * influence-radius buffer `max(radius_c)` when called with `(preferences)`.
 */
export function computeInfluenceBufferRadiusMeters(
  analysisAreaRadiusMeters: number,
  categoryRadiiOrPreferences?:
    | readonly number[]
    | Readonly<Record<string, number>>
    | PreferenceProfileInput
): number;
export function computeInfluenceBufferRadiusMeters(
  preferences?:
    | readonly number[]
    | Readonly<Record<string, number>>
    | PreferenceProfileInput
): number;
export function computeInfluenceBufferRadiusMeters(
  firstArg?:
    | number
    | readonly number[]
    | Readonly<Record<string, number>>
    | PreferenceProfileInput,
  secondArg?:
    | readonly number[]
    | Readonly<Record<string, number>>
    | PreferenceProfileInput
): number {
  if (typeof firstArg === "number") {
    if (!Number.isFinite(firstArg) || firstArg <= 0) {
      throw new RangeError(
        `analysisAreaRadiusMeters must be a finite positive number, received ${String(firstArg)}.`
      );
    }
    return firstArg + computeMaxCategoryRadiusMeters(secondArg);
  }

  if (firstArg !== undefined && (typeof firstArg !== "object" || firstArg === null)) {
    throw new RangeError(
      `Invalid argument to computeInfluenceBufferRadiusMeters: ${String(firstArg)}.`
    );
  }

  return computeMaxCategoryRadiusMeters(firstArg);
}

export interface BoundingBox {
  readonly minLat: number;
  readonly maxLat: number;
  readonly minLng: number;
  readonly maxLng: number;
}

/**
 * Computes a conservative WGS84 latitude/longitude bounding box enclosing a circle
 * of `radiusMeters` around `center`.
 */
export function computeBoundingBoxForRadius(
  center: CoordinatePoint,
  radiusMeters: number
): BoundingBox {
  const validCenter = validatePoint(center, "boundingBox center");
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) {
    throw new RangeError(`radiusMeters must be a finite positive number, received ${String(radiusMeters)}.`);
  }

  const angularRadiusRad = radiusMeters / WGS84_MEAN_EARTH_RADIUS_METERS;
  const latDeltaDeg = (angularRadiusRad * 180) / Math.PI;
  const cosLat = Math.max(1e-6, Math.cos(toRadians(validCenter.lat)));
  const lngDeltaDeg = (angularRadiusRad * 180) / (Math.PI * cosLat);

  return {
    minLat: Math.max(-90, validCenter.lat - latDeltaDeg),
    maxLat: Math.min(90, validCenter.lat + latDeltaDeg),
    minLng: Math.max(-180, validCenter.lng - lngDeltaDeg),
    maxLng: Math.min(180, validCenter.lng + lngDeltaDeg),
  };
}

// ============================================================================
// Conservative Order-Invariant Deduplication
// ============================================================================

export interface ScorableFacilityInput {
  readonly id?: string;
  readonly externalId?: string;
  readonly sourceId: SourceId | string;
  readonly category: string;
  readonly name?: string | null;
  readonly lat: number;
  readonly lng: number;
  readonly analysisEligible?: boolean;
  readonly tags?: Readonly<Record<string, string>>;
}

export interface CanonicalFacilityRecord<
  T extends ScorableFacilityInput = ScorableFacilityInput
> {
  readonly canonicalId: string;
  readonly externalId: string;
  readonly sourceId: SourceId;
  readonly category: string;
  readonly rawCategory: string;
  readonly name: string;
  readonly normalizedName: string;
  readonly lat: number;
  readonly lng: number;
  readonly analysisEligible: true;
  readonly mergedCount: number;
  readonly original: T & { readonly analysisEligible: true };
}

export interface DeduplicateOptions extends SourcePolicyCheckOptions {
  readonly namedDistanceThresholdMeters?: number;
  readonly unnamedDistanceThresholdMeters?: number;
  readonly requireAmenityEligible?: boolean;
}

export interface DeduplicationResult<
  T extends ScorableFacilityInput = ScorableFacilityInput
> {
  readonly facilities: CanonicalFacilityRecord<T>[];
  readonly duplicatesMergedCount: number;
  readonly rejectedByPolicyCount: number;
  readonly rejectedCountBySource: Record<string, number>;
}

/**
 * Normalizes a facility name for deterministic sorting and duplicate matching:
 * - Unicode NFKD normalization + diacritic removal
 * - Lowercase
 * - Apostrophes/quotes removed (`"Trader Joe's"` -> `"trader joes"`)
 * - Non-alphanumeric characters collapsed to single spaces
 */
export function normalizeFacilityName(name: string | null | undefined): string {
  if (typeof name !== "string") {
    return "";
  }
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/['’`"]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function quantizeCoord(coord: number): number {
  return Math.round(coord * 1e7);
}

/**
 * Strict total-order comparator over candidate facilities so any input array permutation
 * sorts into the exact same canonical sequence before duplicate clustering.
 */
export function compareFacilitiesCanonical(
  a: ScorableFacilityInput,
  b: ScorableFacilityInput
): number {
  const catA = normalizeCategoryKey(a.category);
  const catB = normalizeCategoryKey(b.category);
  if (catA !== catB) {
    return catA < catB ? -1 : 1;
  }

  const nameA = normalizeFacilityName(a.name);
  const nameB = normalizeFacilityName(b.name);
  // Named entries sort before unnamed entries so merged clusters prefer named records
  if (Boolean(nameA) !== Boolean(nameB)) {
    return nameA ? -1 : 1;
  }
  if (nameA !== nameB) {
    return nameA < nameB ? -1 : 1;
  }

  const qLatA = quantizeCoord(a.lat);
  const qLatB = quantizeCoord(b.lat);
  if (qLatA !== qLatB) {
    return qLatA - qLatB;
  }
  if (a.lat !== b.lat) {
    return a.lat - b.lat;
  }

  const qLngA = quantizeCoord(a.lng);
  const qLngB = quantizeCoord(b.lng);
  if (qLngA !== qLngB) {
    return qLngA - qLngB;
  }
  if (a.lng !== b.lng) {
    return a.lng - b.lng;
  }

  const srcA = String(a.sourceId ?? "");
  const srcB = String(b.sourceId ?? "");
  if (srcA !== srcB) {
    return srcA < srcB ? -1 : 1;
  }

  const extA = String(a.externalId ?? a.id ?? "");
  const extB = String(b.externalId ?? b.id ?? "");
  if (extA !== extB) {
    return extA < extB ? -1 : 1;
  }

  return 0;
}

/**
 * Performs source-policy filtering, strict coordinate validation, order-invariant canonical
 * sorting, and conservative duplicate merging.
 *
 * Guarantees bit-identical output regardless of input array permutation.
 */
export function deduplicateFacilities<T extends ScorableFacilityInput>(
  facilities: readonly T[],
  options?: DeduplicateOptions
): DeduplicationResult<T> {
  const namedThreshold =
    options?.namedDistanceThresholdMeters ?? DEFAULT_NAMED_DEDUP_THRESHOLD_METERS;
  const unnamedThreshold =
    options?.unnamedDistanceThresholdMeters ?? DEFAULT_UNNAMED_DEDUP_THRESHOLD_METERS;
  const requireAmenityEligible = options?.requireAmenityEligible ?? true;

  const partitioned = partitionFacilitiesBySourcePolicy(facilities, {
    allowSyntheticDemo: options?.allowSyntheticDemo,
    requireAmenityEligible,
  });

  // Validate coordinates on all eligible records
  const validatedEligible = partitioned.eligible.map((item) => {
    const coords = validateCoordinates(item.lat, item.lng, "facility coordinate");
    return {
      ...item,
      lat: coords.lat,
      lng: coords.lng,
    };
  });

  // Sort into canonical total order so input permutations become identical
  const sorted = [...validatedEligible].sort(compareFacilitiesCanonical);

  const retained: Array<{
    canonicalId: string;
    externalId: string;
    sourceId: SourceId;
    category: string;
    rawCategory: string;
    name: string;
    normalizedName: string;
    lat: number;
    lng: number;
    analysisEligible: true;
    mergedCount: number;
    original: T & { readonly analysisEligible: true };
  }> = [];

  let duplicatesMergedCount = 0;

  for (const candidate of sorted) {
    const category = normalizeCategoryKey(candidate.category);
    const normalizedName = normalizeFacilityName(candidate.name);
    const externalId = String(candidate.externalId ?? candidate.id ?? "").trim();
    const sourceId = candidate.sourceId as SourceId;

    let mergedIntoExisting = false;

    for (const existing of retained) {
      if (existing.category !== category) {
        continue;
      }

      // Rule 1: Exact same sourceId and non-empty externalId/id
      const exactIdMatch =
        externalId.length > 0 &&
        existing.externalId.length > 0 &&
        existing.sourceId === sourceId &&
        existing.externalId === externalId;

      if (exactIdMatch) {
        existing.mergedCount += 1;
        duplicatesMergedCount += 1;
        mergedIntoExisting = true;
        break;
      }

      const distMeters = computeGeodesicDistanceMeters(
        existing.lat,
        existing.lng,
        candidate.lat,
        candidate.lng
      );

      // Rule 2: Both have non-empty normalized names that match identically within threshold
      if (
        normalizedName.length > 0 &&
        existing.normalizedName.length > 0 &&
        normalizedName === existing.normalizedName &&
        distMeters <= namedThreshold
      ) {
        existing.mergedCount += 1;
        duplicatesMergedCount += 1;
        mergedIntoExisting = true;
        break;
      }

      // Rule 3: Both are unnamed in the exact same category within micro-coincident threshold
      if (
        normalizedName.length === 0 &&
        existing.normalizedName.length === 0 &&
        distMeters <= unnamedThreshold
      ) {
        existing.mergedCount += 1;
        duplicatesMergedCount += 1;
        mergedIntoExisting = true;
        break;
      }
    }

    if (!mergedIntoExisting) {
      const fallbackId = `${sourceId}:${category}:${normalizedName || "unnamed"}:${candidate.lat.toFixed(
        6
      )},${candidate.lng.toFixed(6)}`;
      retained.push({
        canonicalId: externalId || fallbackId,
        externalId,
        sourceId,
        category,
        rawCategory: candidate.category,
        name:
          typeof candidate.name === "string" && candidate.name.trim().length > 0
            ? candidate.name.trim()
            : category,
        normalizedName,
        lat: candidate.lat,
        lng: candidate.lng,
        analysisEligible: true,
        mergedCount: 1,
        original: candidate,
      });
    }
  }

  return {
    facilities: retained,
    duplicatesMergedCount,
    rejectedByPolicyCount: partitioned.rejected.length,
    rejectedCountBySource: partitioned.rejectedCountBySource,
  };
}

// ============================================================================
// Linear Facility Kernel, Saturation & Accessibility Score
// ============================================================================

/**
 * Computes the linear distance-decay kernel value `k_{i,c} = max(0, 1 - d_i / radius_c)`
 * for a facility at `distanceMeters` with positive category radius `radiusMeters`.
 */
export function computeLinearKernel(
  distanceMeters: number,
  radiusMeters: number
): number {
  if (!Number.isFinite(distanceMeters) || distanceMeters < 0) {
    throw new RangeError(
      `distanceMeters must be a finite non-negative number, received ${String(distanceMeters)}.`
    );
  }
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) {
    throw new RangeError(
      `radiusMeters must be a finite positive number, received ${String(radiusMeters)}.`
    );
  }
  if (distanceMeters >= radiusMeters) {
    return 0;
  }
  if (distanceMeters === 0) {
    return 1;
  }
  return Math.max(0, 1 - distanceMeters / radiusMeters);
}

export const computeFacilityKernel = computeLinearKernel;

/**
 * Computes category intensity saturation `a_c = min(1, kernelSum / cap_c)` with `cap_c > 0`.
 */
export function computeCategorySaturation(kernelSum: number, cap: number): number {
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new RangeError(`Category saturation cap must be a finite positive number, received ${String(cap)}.`);
  }
  if (!Number.isFinite(kernelSum) || kernelSum < 0) {
    throw new RangeError(`kernelSum must be a finite non-negative number, received ${String(kernelSum)}.`);
  }
  if (kernelSum === 0) {
    return 0;
  }
  return Math.min(1, kernelSum / cap);
}

export const saturateCategoryIntensity = computeCategorySaturation;

export type CategorySourceStatus = "ok" | "unknown" | "failed" | "timeout";

export interface CategoryPreferenceConfig {
  readonly weight?: number;
  readonly radiusMeters?: number;
  readonly cap?: number;
  readonly label?: string;
}

export interface PreferenceProfileInput {
  readonly weights?: Readonly<Record<string, number>>;
  readonly radiiMeters?: Readonly<Record<string, number>>;
  readonly caps?: Readonly<Record<string, number>>;
  readonly categories?: Readonly<Record<string, CategoryPreferenceConfig>>;
}

export type FlexiblePreferencesInput =
  | PreferenceProfileInput
  | Readonly<Record<string, number | CategoryPreferenceConfig>>;

export interface EvaluatedFacilityContribution {
  readonly id: string;
  readonly name: string;
  readonly sourceId: SourceId;
  readonly category: string;
  readonly lat: number;
  readonly lng: number;
  readonly distanceMeters: number;
  readonly kernelValue: number;
}

export interface CategoryScoreBreakdown {
  readonly category: string;
  readonly label: string;
  readonly weight: number;
  readonly radiusMeters: number;
  readonly cap: number;
  readonly status: "ok" | "unknown";
  readonly facilityCount: number;
  readonly rawKernelSum: number;
  /** `a_c` in `[0, 1]` when `status === "ok"`, or `null` when `status === "unknown"` */
  readonly intensity: number | null;
  /** `a_c` when `status === "ok"`, or `0` when `status === "unknown"` */
  readonly effectiveIntensity: number;
  /** `w_c * a_c` when `status === "ok"`, or `0` when `status === "unknown"` */
  readonly weightedContribution: number;
  readonly nearestDistanceMeters: number | null;
  readonly topFacilities: EvaluatedFacilityContribution[];
}

export type AccessibilityCompleteness = "complete" | "partial" | "unknown";

export interface AccessibilityScoreResult {
  /** Composite accessibility score `A` in `[0, 100]` */
  readonly score: number;
  readonly completeness: AccessibilityCompleteness;
  /** Categories whose upstream source failed or timed out (`status === "unknown"`) */
  readonly missingOrFailedCategories: string[];
  /** Weighted categories (`w_c > 0`) whose upstream source failed or timed out */
  readonly failedWeightedCategories: string[];
  readonly categoryBreakdown: Record<string, CategoryScoreBreakdown>;
  readonly categories: CategoryScoreBreakdown[];
  /** Sum of `w_c` across all categories (including failed weighted categories!) */
  readonly totalWeight: number;
  /** Sum of `w_c` across healthy (`status === "ok"`) categories */
  readonly knownWeight: number;
  /** Ratio `knownWeight / totalWeight` (or `1` if `totalWeight === 0`) */
  readonly knownWeightFraction: number;
  readonly deduplicatedFacilityCount: number;
  readonly duplicatesMergedCount: number;
  readonly rejectedFacilityCount: number;
  readonly rejectedCountBySource: Record<string, number>;
}

export interface ComputeAccessibilityOptions extends DeduplicateOptions {
  readonly categorySourceStatuses?: Readonly<Record<string, CategorySourceStatus>>;
  readonly maxTopFacilitiesPerCategory?: number;
}

interface NormalizedCategoryRule {
  readonly category: string;
  readonly label: string;
  readonly weight: number;
  readonly radiusMeters: number;
  readonly cap: number;
}

function isPreferenceProfileInput(
  input: FlexiblePreferencesInput
): input is PreferenceProfileInput {
  if (!input || typeof input !== "object") {
    return false;
  }
  return (
    "weights" in input ||
    "radiiMeters" in input ||
    "caps" in input ||
    "categories" in input
  );
}

/**
 * Resolves caller preference overrides on top of `DEFAULT_CATEGORY_CONFIGS`, validating
 * that weights are finite and `>= 0`, radii are `> 0`, and caps are `> 0`.
 */
export function resolveCategoryRules(
  preferences?: FlexiblePreferencesInput
): NormalizedCategoryRule[] {
  const weightsMap: Record<string, number> = {};
  const radiiMap: Record<string, number> = {};
  const capsMap: Record<string, number> = {};
  const labelsMap: Record<string, string> = {};
  const categoryOrder: string[] = [...DEFAULT_AMENITY_CATEGORIES];

  const registerCategoryKey = (rawKey: string): string => {
    const norm = normalizeCategoryKey(rawKey);
    if (norm && !categoryOrder.includes(norm)) {
      categoryOrder.push(norm);
    }
    return norm;
  };

  if (preferences && typeof preferences === "object") {
    if (isPreferenceProfileInput(preferences)) {
      if (preferences.weights) {
        for (const [k, v] of Object.entries(preferences.weights)) {
          const norm = registerCategoryKey(k);
          weightsMap[norm] = v;
        }
      }
      if (preferences.radiiMeters) {
        for (const [k, v] of Object.entries(preferences.radiiMeters)) {
          const norm = registerCategoryKey(k);
          radiiMap[norm] = v;
        }
      }
      if (preferences.caps) {
        for (const [k, v] of Object.entries(preferences.caps)) {
          const norm = registerCategoryKey(k);
          capsMap[norm] = v;
        }
      }
      if (preferences.categories) {
        for (const [k, cfg] of Object.entries(preferences.categories)) {
          const norm = registerCategoryKey(k);
          if (cfg && typeof cfg === "object") {
            if (cfg.weight !== undefined) weightsMap[norm] = cfg.weight;
            if (cfg.radiusMeters !== undefined) radiiMap[norm] = cfg.radiusMeters;
            if (cfg.cap !== undefined) capsMap[norm] = cfg.cap;
            if (cfg.label !== undefined) labelsMap[norm] = cfg.label;
          }
        }
      }
    } else {
      for (const [k, val] of Object.entries(preferences)) {
        const norm = registerCategoryKey(k);
        if (typeof val === "number") {
          weightsMap[norm] = val;
        } else if (val && typeof val === "object") {
          if (val.weight !== undefined) weightsMap[norm] = val.weight;
          if (val.radiusMeters !== undefined) radiiMap[norm] = val.radiusMeters;
          if (val.cap !== undefined) capsMap[norm] = val.cap;
          if (val.label !== undefined) labelsMap[norm] = val.label;
        }
      }
    }
  }

  return categoryOrder.map((category) => {
    const def = (
      DEFAULT_CATEGORY_CONFIGS as Readonly<Record<string, CategoryDefaultConfig | undefined>>
    )[category];

    const weight =
      weightsMap[category] !== undefined
        ? weightsMap[category]
        : def
        ? def.defaultWeight
        : 0;
    const radiusMeters =
      radiiMap[category] !== undefined
        ? radiiMap[category]
        : def
        ? def.defaultRadiusMeters
        : 1500;
    const cap =
      capsMap[category] !== undefined
        ? capsMap[category]
        : def
        ? def.defaultCap
        : 2.0;
    const label =
      labelsMap[category] ?? (def ? def.label : category.replace(/_/g, " "));

    if (!Number.isFinite(weight) || weight < 0) {
      throw new RangeError(
        `Preference weight for category "${category}" must be a finite number >= 0, received ${String(
          weight
        )}.`
      );
    }
    if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) {
      throw new RangeError(
        `Preference radiusMeters for category "${category}" must be a finite number > 0, received ${String(
          radiusMeters
        )}.`
      );
    }
    if (!Number.isFinite(cap) || cap <= 0) {
      throw new RangeError(
        `Preference saturation cap for category "${category}" must be a finite number > 0, received ${String(
          cap
        )}.`
      );
    }

    return {
      category,
      label,
      weight,
      radiusMeters,
      cap,
    };
  });
}

function normalizeSourceStatus(
  status: CategorySourceStatus | undefined
): "ok" | "unknown" {
  if (!status || status === "ok") {
    return "ok";
  }
  return "unknown";
}

/**
 * Computes the deterministic accessibility score `A = 100 * (sum_c w_c a_c) / (sum_c w_c)`
 * at `point`, enforcing source policy, order-invariant deduplication, linear kernel decay,
 * category saturation, and strict non-renormalization of failed/unknown category sources.
 */
export function computeAccessibilityScore(
  point: CoordinatePoint,
  facilities: readonly ScorableFacilityInput[],
  preferences?: FlexiblePreferencesInput,
  options?: ComputeAccessibilityOptions
): AccessibilityScoreResult {
  const validPoint = validatePoint(point, "evaluation point");
  const rules = resolveCategoryRules(preferences);
  const deduped = deduplicateFacilities(facilities, options);
  const maxTop = options?.maxTopFacilitiesPerCategory ?? 5;

  // Map normalized category statuses
  const normalizedStatuses: Record<string, "ok" | "unknown"> = {};
  if (options?.categorySourceStatuses) {
    for (const [rawCat, rawStatus] of Object.entries(options.categorySourceStatuses)) {
      normalizedStatuses[normalizeCategoryKey(rawCat)] =
        normalizeSourceStatus(rawStatus);
    }
  }

  // Group deduplicated facilities by normalized category
  const facilitiesByCategory = new Map<string, CanonicalFacilityRecord[]>();
  for (const fac of deduped.facilities) {
    const list = facilitiesByCategory.get(fac.category);
    if (list) {
      list.push(fac);
    } else {
      facilitiesByCategory.set(fac.category, [fac]);
    }
  }

  const categoryBreakdown: Record<string, CategoryScoreBreakdown> = {};
  const categories: CategoryScoreBreakdown[] = [];
  const missingOrFailedCategories: string[] = [];
  const failedWeightedCategories: string[] = [];

  let totalWeight = 0;
  let knownWeight = 0;
  let weightedIntensitySum = 0;
  let activeWeightedCategoryCount = 0;
  let healthyWeightedCategoryCount = 0;

  for (const rule of rules) {
    const status = normalizedStatuses[rule.category] ?? "ok";
    totalWeight += rule.weight;

    if (rule.weight > 0) {
      activeWeightedCategoryCount += 1;
    }

    if (status === "unknown") {
      missingOrFailedCategories.push(rule.category);
      if (rule.weight > 0) {
        failedWeightedCategories.push(rule.category);
      }

      const unknownEntry: CategoryScoreBreakdown = {
        category: rule.category,
        label: rule.label,
        weight: rule.weight,
        radiusMeters: rule.radiusMeters,
        cap: rule.cap,
        status: "unknown",
        facilityCount: 0,
        rawKernelSum: 0,
        intensity: null,
        effectiveIntensity: 0,
        weightedContribution: 0,
        nearestDistanceMeters: null,
        topFacilities: [],
      };
      categoryBreakdown[rule.category] = unknownEntry;
      categories.push(unknownEntry);
      continue;
    }

    // Healthy category ("ok")
    knownWeight += rule.weight;
    if (rule.weight > 0) {
      healthyWeightedCategoryCount += 1;
    }

    const catFacilities = facilitiesByCategory.get(rule.category) ?? [];
    const contributions: EvaluatedFacilityContribution[] = [];
    let rawKernelSum = 0;
    let nearestDistanceMeters: number | null = null;

    for (const fac of catFacilities) {
      const distMeters = computeGeodesicDistanceMeters(
        validPoint.lat,
        validPoint.lng,
        fac.lat,
        fac.lng
      );

      if (nearestDistanceMeters === null || distMeters < nearestDistanceMeters) {
        nearestDistanceMeters = distMeters;
      }

      const kernelVal = computeLinearKernel(distMeters, rule.radiusMeters);
      if (kernelVal > 0) {
        rawKernelSum += kernelVal;
        contributions.push({
          id: fac.canonicalId,
          name: fac.name,
          sourceId: fac.sourceId,
          category: fac.category,
          lat: fac.lat,
          lng: fac.lng,
          distanceMeters: roundClean(distMeters, 3),
          kernelValue: roundClean(kernelVal, 6),
        });
      }
    }

    // Sort contributing facilities by distance ascending, then canonicalId
    contributions.sort((a, b) => {
      if (a.distanceMeters !== b.distanceMeters) {
        return a.distanceMeters - b.distanceMeters;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

    const intensity = computeCategorySaturation(rawKernelSum, rule.cap);
    const weightedContribution = rule.weight * intensity;
    weightedIntensitySum += weightedContribution;

    const okEntry: CategoryScoreBreakdown = {
      category: rule.category,
      label: rule.label,
      weight: rule.weight,
      radiusMeters: rule.radiusMeters,
      cap: rule.cap,
      status: "ok",
      facilityCount: contributions.length,
      rawKernelSum: roundClean(rawKernelSum, 6),
      intensity: roundClean(intensity, 6),
      effectiveIntensity: roundClean(intensity, 6),
      weightedContribution: roundClean(weightedContribution, 6),
      nearestDistanceMeters:
        nearestDistanceMeters !== null ? roundClean(nearestDistanceMeters, 3) : null,
      topFacilities: contributions.slice(0, maxTop),
    };

    categoryBreakdown[rule.category] = okEntry;
    categories.push(okEntry);
  }

  // Overall completeness determination for weighted categories:
  // - If all weighted categories succeeded -> "complete"
  // - If some weighted categories succeeded and some failed -> "partial"
  // - If all weighted categories failed -> "unknown"
  let completeness: AccessibilityCompleteness = "complete";
  if (activeWeightedCategoryCount > 0) {
    if (healthyWeightedCategoryCount === 0) {
      completeness = "unknown";
    } else if (healthyWeightedCategoryCount < activeWeightedCategoryCount) {
      completeness = "partial";
    } else {
      completeness = "complete";
    }
  } else if (missingOrFailedCategories.length === rules.length && rules.length > 0) {
    completeness = "unknown";
  }

  // Note: failed categories are held in `totalWeight` rather than silently renormalized out!
  const rawScore = totalWeight > 0 ? (100 * weightedIntensitySum) / totalWeight : 0;
  const clampedScore = Math.max(0, Math.min(100, roundClean(rawScore, 6)));
  const knownWeightFraction =
    totalWeight > 0 ? roundClean(knownWeight / totalWeight, 6) : 1;

  return {
    score: clampedScore,
    completeness,
    missingOrFailedCategories,
    failedWeightedCategories,
    categoryBreakdown,
    categories,
    totalWeight: roundClean(totalWeight, 6),
    knownWeight: roundClean(knownWeight, 6),
    knownWeightFraction,
    deduplicatedFacilityCount: deduped.facilities.length,
    duplicatesMergedCount: deduped.duplicatesMergedCount,
    rejectedFacilityCount: deduped.rejectedByPolicyCount,
    rejectedCountBySource: deduped.rejectedCountBySource,
  };
}

// ============================================================================
// Bounded Grid / Kernel Venn-Like Multi-Category Overlap
// ============================================================================

export interface GridOverlapCell {
  readonly cellId: string;
  readonly row: number;
  readonly col: number;
  readonly lat: number;
  readonly lng: number;
  readonly distanceFromCenterMeters: number;
  readonly accessibilityScore: number;
  readonly completeness: AccessibilityCompleteness;
  readonly categoryIntensities: Record<string, number | null>;
  readonly presentCategories: string[];
  readonly overlapCount: number;
  readonly minActiveIntensity: number;
}

export interface BoundedGridOverlapOptions extends ComputeAccessibilityOptions {
  /** Number of grid steps per axis, clamped to `[4, 20]` (default `11`) */
  readonly gridResolution?: number;
  /** Intensity threshold `tau` in `(0, 1]` for a category to count as present at a cell (default `0.25`) */
  readonly overlapThreshold?: number;
}

export interface BoundedGridOverlapResult {
  readonly center: CoordinatePoint;
  readonly radiusMeters: number;
  readonly gridResolution: number;
  readonly overlapThreshold: number;
  readonly activeCategories: string[];
  readonly maxOverlapCount: number;
  readonly cells: GridOverlapCell[];
  readonly sweetSpotCells: GridOverlapCell[];
}

/**
 * Evaluates a bounded regular lat/lng grid over `analysisArea` (`center`, `radiusMeters`)
 * without combinatorial `2^N` polygon intersections.
 *
 * Pre-deduplicates facilities once and computes per-cell category intensities `a_c(x, y)`
 * and Venn-like multi-category overlap counts.
 */
export function computeBoundedGridOverlap(
  center: CoordinatePoint,
  radiusMeters: number,
  facilities: readonly ScorableFacilityInput[],
  preferences?: FlexiblePreferencesInput,
  options?: BoundedGridOverlapOptions
): BoundedGridOverlapResult {
  const validCenter = validatePoint(center, "analysisArea center");
  if (!Number.isFinite(radiusMeters) || radiusMeters <= 0) {
    throw new RangeError(
      `analysisArea radiusMeters must be a finite positive number, received ${String(radiusMeters)}.`
    );
  }

  const rawResolution =
    options?.gridResolution !== undefined && Number.isFinite(options.gridResolution)
      ? options.gridResolution
      : 11;
  const gridResolution = Math.max(4, Math.min(20, Math.floor(rawResolution)));
  const overlapThreshold =
    options?.overlapThreshold !== undefined &&
    Number.isFinite(options.overlapThreshold) &&
    options.overlapThreshold > 0 &&
    options.overlapThreshold <= 1
      ? options.overlapThreshold
      : DEFAULT_OVERLAP_INTENSITY_THRESHOLD;

  const rules = resolveCategoryRules(preferences);
  const activeCategories = rules.filter((r) => r.weight > 0).map((r) => r.category);

  // Deduplicate once up front for deterministic performance across all grid cells
  const deduped = deduplicateFacilities(facilities, options);
  const canonicalInputs: ScorableFacilityInput[] = deduped.facilities.map((f) => ({
    id: f.canonicalId,
    externalId: f.externalId,
    sourceId: f.sourceId,
    category: f.category,
    name: f.name,
    lat: f.lat,
    lng: f.lng,
    analysisEligible: true,
  }));

  const bbox = computeBoundingBoxForRadius(validCenter, radiusMeters);
  const latStep =
    gridResolution > 1 ? (bbox.maxLat - bbox.minLat) / (gridResolution - 1) : 0;
  const lngStep =
    gridResolution > 1 ? (bbox.maxLng - bbox.minLng) / (gridResolution - 1) : 0;

  const cells: GridOverlapCell[] = [];
  let maxOverlapCount = 0;

  for (let row = 0; row < gridResolution; row += 1) {
    const lat =
      gridResolution === 1
        ? validCenter.lat
        : roundClean(bbox.minLat + row * latStep, 6);
    for (let col = 0; col < gridResolution; col += 1) {
      const lng =
        gridResolution === 1
          ? validCenter.lng
          : roundClean(bbox.minLng + col * lngStep, 6);

      const distFromCenter = computeGeodesicDistanceMeters(
        validCenter.lat,
        validCenter.lng,
        lat,
        lng
      );

      // Retain cells within the analysis area circle (with 1% tolerance so center/cardinal points are included)
      if (distFromCenter > radiusMeters * 1.0001) {
        continue;
      }

      const cellScore = computeAccessibilityScore(
        { lat, lng },
        canonicalInputs,
        preferences,
        {
          ...options,
          maxTopFacilitiesPerCategory: 1,
        }
      );

      const categoryIntensities: Record<string, number | null> = {};
      const presentCategories: string[] = [];
      let minActiveIntensity = activeCategories.length > 0 ? 1 : 0;

      for (const cat of rules) {
        const bd = cellScore.categoryBreakdown[cat.category];
        const intensity = bd ? bd.intensity : null;
        categoryIntensities[cat.category] = intensity;
      }

      for (const activeCat of activeCategories) {
        const val = categoryIntensities[activeCat];
        const numericVal = typeof val === "number" ? val : 0;
        if (numericVal < minActiveIntensity) {
          minActiveIntensity = numericVal;
        }
        if (numericVal >= overlapThreshold) {
          presentCategories.push(activeCat);
        }
      }

      const overlapCount = presentCategories.length;
      if (overlapCount > maxOverlapCount) {
        maxOverlapCount = overlapCount;
      }

      cells.push({
        cellId: `cell_${row}_${col}`,
        row,
        col,
        lat,
        lng,
        distanceFromCenterMeters: roundClean(distFromCenter, 2),
        accessibilityScore: cellScore.score,
        completeness: cellScore.completeness,
        categoryIntensities,
        presentCategories,
        overlapCount,
        minActiveIntensity: roundClean(minActiveIntensity, 6),
      });
    }
  }

  const sweetSpotCells =
    maxOverlapCount > 0
      ? cells
          .filter((c) => c.overlapCount === maxOverlapCount)
          .sort((a, b) => b.accessibilityScore - a.accessibilityScore)
      : [];

  return {
    center: validCenter,
    radiusMeters,
    gridResolution,
    overlapThreshold,
    activeCategories,
    maxOverlapCount,
    cells,
    sweetSpotCells,
  };
}

// ============================================================================
// Separate Environmental Due-Diligence Layer (`epa_frs`)
// ============================================================================

export const ENVIRONMENTAL_DUE_DILIGENCE_DISCLAIMER =
  "Documented US EPA Facility Registry Service (FRS) permit/program records are surfaced strictly as a separate user-controlled due-diligence layer, never an automatic environmental hazard or health determination.";

export interface EnvironmentalCandidateInput {
  readonly id?: string;
  readonly registryId?: string;
  readonly sourceId: SourceId | string;
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
  readonly programs?: readonly string[];
  readonly activePermitsOrEmissions?: boolean;
  readonly status?: string;
  readonly profileUrl?: string;
  readonly analysisEligible?: boolean;
}

export interface EvaluatedEnvironmentalRecord {
  readonly id: string;
  readonly registryId: string;
  readonly sourceId: SourceId;
  readonly name: string;
  readonly lat: number;
  readonly lng: number;
  readonly distanceMeters: number;
  readonly programs: string[];
  readonly status: string;
  readonly profileUrl?: string;
  readonly dueDiligenceNotice: string;
  readonly isAutomaticHealthDetermination: false;
}

/**
 * Evaluates documented environmental regulatory records (`epa_frs` or opt-in `synthetic_demo`)
 * for the separate user-controlled due-diligence layer.
 *
 * Bare industrial/data-center tags without documented EPA program records are ignored as neutral.
 * `google_places_context` records are unconditionally rejected.
 */
export function evaluateEnvironmentalLayer(
  point: CoordinatePoint,
  records: readonly EnvironmentalCandidateInput[],
  maxRadiusMeters = 3200,
  options?: SourcePolicyCheckOptions
): EvaluatedEnvironmentalRecord[] {
  const validPoint = validatePoint(point, "environmental reference point");
  if (!Number.isFinite(maxRadiusMeters) || maxRadiusMeters <= 0) {
    throw new RangeError(`maxRadiusMeters must be a finite positive number.`);
  }

  const evaluated: EvaluatedEnvironmentalRecord[] = [];
  const seenRegistryKeys = new Set<string>();

  for (const record of records) {
    if (!record || !isSourceEnvironmentalEligible(record.sourceId, options)) {
      continue;
    }

    // Bare industrial/data-center tags without documented active regulatory programs are neutral
    const programs = Array.isArray(record.programs)
      ? record.programs.map((p) => String(p).trim()).filter(Boolean)
      : [];
    if (programs.length === 0 && record.activePermitsOrEmissions !== true) {
      continue;
    }

    const coords = validateCoordinates(
      record.lat,
      record.lng,
      "environmental record coordinate"
    );
    const distanceMeters = computeGeodesicDistanceMeters(validPoint, coords);
    if (distanceMeters > maxRadiusMeters) {
      continue;
    }

    const registryId = String(record.registryId ?? record.id ?? "").trim();
    const dedupKey = `${record.sourceId}:${registryId || normalizeFacilityName(record.name)}:${coords.lat.toFixed(
      5
    )},${coords.lng.toFixed(5)}`;
    if (seenRegistryKeys.has(dedupKey)) {
      continue;
    }
    seenRegistryKeys.add(dedupKey);

    evaluated.push({
      id: String(record.id ?? (registryId || dedupKey)),
      registryId: registryId || "EPA-FRS",
      sourceId: record.sourceId as SourceId,
      name: record.name.trim(),
      lat: coords.lat,
      lng: coords.lng,
      distanceMeters: roundClean(distanceMeters, 2),
      programs,
      status: record.status ?? "Active EPA FRS Program Record",
      profileUrl: record.profileUrl,
      dueDiligenceNotice: ENVIRONMENTAL_DUE_DILIGENCE_DISCLAIMER,
      isAutomaticHealthDetermination: false,
    });
  }

  evaluated.sort((a, b) => {
    if (a.distanceMeters !== b.distanceMeters) {
      return a.distanceMeters - b.distanceMeters;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return evaluated;
}

export interface UserPreferenceCompositeResult {
  readonly preferenceCompositeScore: number;
  readonly baseAccessibilityScore: number;
  readonly externalityPenaltyPoints: number;
  readonly unit: "uncalibrated_preference_index_0_100";
  readonly isMarketDollarEstimate: false;
  readonly modifiesAvmEstimate: false;
  readonly disclaimer: string;
}

/**
 * Optional helper for user-configured preference exploration when the user explicitly opts
 * to subtract an externality preference penalty from their accessibility score.
 *
 * Explicitly labeled as an uncalibrated preference index (0-100), NEVER market dollars,
 * and NEVER applied to RentCast AVM values.
 */
export function computeOptionalUserPreferenceComposite(
  accessibilityScore: number,
  externalityPenaltyPoints = 0
): UserPreferenceCompositeResult {
  const safeBase = Number.isFinite(accessibilityScore)
    ? Math.max(0, Math.min(100, accessibilityScore))
    : 0;
  const safePenalty = Number.isFinite(externalityPenaltyPoints)
    ? Math.max(0, Math.min(100, externalityPenaltyPoints))
    : 0;
  const composite = Math.max(0, Math.min(100, roundClean(safeBase - safePenalty, 6)));

  return {
    preferenceCompositeScore: composite,
    baseAccessibilityScore: roundClean(safeBase, 6),
    externalityPenaltyPoints: roundClean(safePenalty, 6),
    unit: "uncalibrated_preference_index_0_100",
    isMarketDollarEstimate: false,
    modifiesAvmEstimate: false,
    disclaimer:
      "Uncalibrated user preference score (0-100); never represents market dollar value and never multiplies or alters RentCast AVM estimates.",
  };
}

// ============================================================================
// Asking-vs-AVM Price-Gap & Range Classification (`computePriceGap`)
// ============================================================================

export type PriceGapRangePosition =
  | "in_range"
  | "below_estimate_range_candidate"
  | "above_estimate_range_candidate"
  | "range_unknown"
  | "no_avm";

export interface PriceGapInput {
  readonly askingPrice: number | null | undefined;
  readonly avmPrice: number | null | undefined;
  readonly avmLow?: number | null | undefined;
  readonly avmHigh?: number | null | undefined;
}

export interface PriceGapResult {
  /** `100 * (avmPrice - askingPrice) / avmPrice` for valid positive USD inputs, else `null` */
  readonly gapPct: number | null;
  /** `avmPrice - askingPrice` in USD for valid positive inputs, else `null` */
  readonly gapAmountUsd: number | null;
  readonly rangePosition: PriceGapRangePosition;
  readonly askingPrice: number | null;
  readonly avmPrice: number | null;
  readonly avmLow: number | null;
  readonly avmHigh: number | null;
  readonly isWithinEstimateRange: boolean | null;
  readonly isProvenUndervaluation: false;
  readonly interpretationNote: string;
}

function isPositiveFiniteUsd(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/**
 * Computes the asking-vs-AVM percentage gap (`gapPct = 100 * (avmPrice - askingPrice) / avmPrice`)
 * and classifies `askingPrice` against the AVM confidence interval `[avmLow, avmHigh]`.
 *
 * Supports both:
 * - `computePriceGap({ askingPrice, avmPrice, avmLow, avmHigh })`
 * - `computePriceGap(askingPrice, avmPrice, avmLow, avmHigh)`
 *
 * Key Invariants:
 * - `AVM=500,000, ask=450,000 => gapPct = +10.0%`
 * - `AVM=1,000,000, ask=900,000, range=[850,000, 1,150,000] => gapPct = +10.0% AND rangePosition = "in_range"` (not proven undervaluation)
 * - Missing/non-positive/inverted `[avmLow, avmHigh]` when `avmPrice > 0` and `askingPrice > 0` => `rangePosition = "range_unknown"` while retaining `gapPct`
 * - Missing/non-positive `avmPrice` or `askingPrice` => `gapPct = null` and `rangePosition = "no_avm"`
 */
export function computePriceGap(input: PriceGapInput): PriceGapResult;
export function computePriceGap(
  askingPrice: number | null | undefined,
  avmPrice: number | null | undefined,
  avmLow?: number | null | undefined,
  avmHigh?: number | null | undefined
): PriceGapResult;
export function computePriceGap(
  inputOrAsking: PriceGapInput | number | null | undefined,
  maybeAvmPrice?: number | null | undefined,
  maybeAvmLow?: number | null | undefined,
  maybeAvmHigh?: number | null | undefined
): PriceGapResult {
  let rawAsking: number | null | undefined;
  let rawAvm: number | null | undefined;
  let rawLow: number | null | undefined;
  let rawHigh: number | null | undefined;

  if (typeof inputOrAsking === "object" && inputOrAsking !== null) {
    rawAsking = inputOrAsking.askingPrice;
    rawAvm = inputOrAsking.avmPrice;
    rawLow = inputOrAsking.avmLow;
    rawHigh = inputOrAsking.avmHigh;
  } else {
    rawAsking = inputOrAsking;
    rawAvm = maybeAvmPrice;
    rawLow = maybeAvmLow;
    rawHigh = maybeAvmHigh;
  }

  const validAsking = isPositiveFiniteUsd(rawAsking) ? rawAsking : null;
  const validAvm = isPositiveFiniteUsd(rawAvm) ? rawAvm : null;
  const validLow = isPositiveFiniteUsd(rawLow) ? rawLow : null;
  const validHigh = isPositiveFiniteUsd(rawHigh) ? rawHigh : null;

  if (validAsking === null || validAvm === null) {
    return {
      gapPct: null,
      gapAmountUsd: null,
      rangePosition: "no_avm",
      askingPrice: validAsking,
      avmPrice: validAvm,
      avmLow: validLow,
      avmHigh: validHigh,
      isWithinEstimateRange: null,
      isProvenUndervaluation: false,
      interpretationNote:
        "No AVM comparison available because a valid positive asking price or RentCast AVM point estimate is missing.",
    };
  }

  const gapAmountUsd = roundClean(validAvm - validAsking, 2);
  const gapPct = roundClean((100 * (validAvm - validAsking)) / validAvm, 4);

  if (validLow === null || validHigh === null || validLow > validHigh) {
    return {
      gapPct,
      gapAmountUsd,
      rangePosition: "range_unknown",
      askingPrice: validAsking,
      avmPrice: validAvm,
      avmLow: null,
      avmHigh: null,
      isWithinEstimateRange: null,
      isProvenUndervaluation: false,
      interpretationNote:
        "Point gap computed against AVM midpoint, but AVM confidence range bounds [avmLow, avmHigh] are missing or invalid (`range_unknown`). Not proven undervaluation.",
    };
  }

  const avmLow: number = validLow;
  const avmHigh: number = validHigh;

  if (validAsking < avmLow) {
    return {
      gapPct,
      gapAmountUsd,
      rangePosition: "below_estimate_range_candidate",
      askingPrice: validAsking,
      avmPrice: validAvm,
      avmLow,
      avmHigh,
      isWithinEstimateRange: false,
      isProvenUndervaluation: false,
      interpretationNote:
        "Asking price is below both the AVM midpoint and the lower bound of the AVM confidence interval (`below_estimate_range_candidate`). This is a statistical screening signal for human due diligence, not proven undervaluation.",
    };
  }

  if (validAsking > avmHigh) {
    return {
      gapPct,
      gapAmountUsd,
      rangePosition: "above_estimate_range_candidate",
      askingPrice: validAsking,
      avmPrice: validAvm,
      avmLow,
      avmHigh,
      isWithinEstimateRange: false,
      isProvenUndervaluation: false,
      interpretationNote:
        "Asking price is above the upper bound of the AVM confidence interval (`above_estimate_range_candidate`). May reflect uncaptured renovations, lot attributes, or seller pricing strategy.",
    };
  }

  return {
    gapPct,
    gapAmountUsd,
    rangePosition: "in_range",
    askingPrice: validAsking,
    avmPrice: validAvm,
    avmLow,
    avmHigh,
    isWithinEstimateRange: true,
    isProvenUndervaluation: false,
    interpretationNote:
      gapPct > 0
        ? `Asking price is ${gapPct}% below the AVM midpoint but lies inside the AVM confidence range [${avmLow.toLocaleString(
            "en-US"
          )}, ${avmHigh.toLocaleString(
            "en-US"
          )}] (\`in_range\`). Normal model dispersion — not proven undervaluation.`
        : "Asking price lies within the RentCast AVM statistical confidence range (`in_range`).",
  };
}
