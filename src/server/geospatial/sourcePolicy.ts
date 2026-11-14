/**
 * Server-side Source-Policy Registry & Enforcement (`sourcePolicy.ts`)
 *
 * Pure zero-external-dependency module enforcing strict licensing and usage boundaries
 * across all geospatial and environmental data sources.
 *
 * CRITICAL INVARIANT:
 * `google_places_context` is ALWAYS `analysisEligible: false` regardless of caller-supplied
 * flags or schema compatibility. It is strictly rejected from spatial scoring, grid overlap
 * heatmaps, derived feature storage, and grounded Gemini `/api/explain` evidence.
 */

export const ALL_SOURCE_IDS = [
  "osm_overpass",
  "osm_extract",
  "epa_frs",
  "synthetic_demo",
  "google_places_context",
] as const;

export type SourceId = (typeof ALL_SOURCE_IDS)[number];

export interface SourcePolicyEntry {
  readonly sourceId: SourceId;
  readonly displayName: string;
  readonly licenseName: string;
  readonly attributionText: string;
  /** Whether records from this source may enter deterministic scoring, heatmaps, storage, or explain evidence */
  readonly analysisEligible: boolean;
  /** Whether records from this source may contribute to amenity convenience kernels (a_c, A) */
  readonly amenityScoringEligible: boolean;
  /** Whether records from this source may populate the separate environmental due-diligence layer */
  readonly environmentalLayerEligible: boolean;
  /** Whether records from this source may be used in bounded grid/kernel overlap heatmaps */
  readonly heatmapEligible: boolean;
  /** Whether derived spatial features from this source may be cached/stored */
  readonly featureStorageEligible: boolean;
  /** Whether records from this source may be passed as grounded evidence to `/api/explain` */
  readonly explainEvidenceEligible: boolean;
  /** Whether attributed display-only rendering in the UI is permitted */
  readonly displayContextAllowed: boolean;
  /** Whether this source requires explicit synthetic demo mode opt-in in production/server runtime */
  readonly requiresSyntheticDemoMode: boolean;
}

export interface SourcePolicyCheckOptions {
  /**
   * When explicitly set to `false`, `synthetic_demo` records are treated as ineligible.
   * Defaults to `true` when omitted so pure scoring/unit tests can evaluate synthetic fixtures directly.
   */
  readonly allowSyntheticDemo?: boolean;
}

export class SourcePolicyViolationError extends Error {
  public readonly sourceId: string;
  public readonly code = "SOURCE_POLICY_VIOLATION" as const;

  constructor(sourceId: string, message?: string) {
    super(
      message ??
        `Source "${sourceId}" is not eligible for spatial scoring, heatmaps, feature storage, or explanation evidence.`
    );
    this.name = "SourcePolicyViolationError";
    this.sourceId = sourceId;
  }
}

const RAW_REGISTRY: Record<SourceId, SourcePolicyEntry> = {
  osm_overpass: Object.freeze({
    sourceId: "osm_overpass",
    displayName: "OpenStreetMap (Overpass API)",
    licenseName: "Open Database License (ODbL 1.0)",
    attributionText: "© OpenStreetMap contributors (ODbL)",
    analysisEligible: true,
    amenityScoringEligible: true,
    environmentalLayerEligible: false,
    heatmapEligible: true,
    featureStorageEligible: true,
    explainEvidenceEligible: true,
    displayContextAllowed: true,
    requiresSyntheticDemoMode: false,
  }),
  osm_extract: Object.freeze({
    sourceId: "osm_extract",
    displayName: "OpenStreetMap (Licensed Extract)",
    licenseName: "Open Database License (ODbL 1.0)",
    attributionText: "© OpenStreetMap contributors (ODbL)",
    analysisEligible: true,
    amenityScoringEligible: true,
    environmentalLayerEligible: false,
    heatmapEligible: true,
    featureStorageEligible: true,
    explainEvidenceEligible: true,
    displayContextAllowed: true,
    requiresSyntheticDemoMode: false,
  }),
  epa_frs: Object.freeze({
    sourceId: "epa_frs",
    displayName: "US EPA Facility Registry Service (FRS)",
    licenseName: "US Federal Public Domain",
    attributionText: "US EPA Facility Registry Service (Public Domain)",
    analysisEligible: true,
    amenityScoringEligible: false,
    environmentalLayerEligible: true,
    heatmapEligible: false,
    featureStorageEligible: true,
    explainEvidenceEligible: true,
    displayContextAllowed: true,
    requiresSyntheticDemoMode: false,
  }),
  synthetic_demo: Object.freeze({
    sourceId: "synthetic_demo",
    displayName: "Synthetic Demo Dataset (Opt-In Only)",
    licenseName: "Internal Hackathon Synthetic Fixture License",
    attributionText: "Synthetic Demo Fixture (Not Live Market/Facility Data)",
    analysisEligible: true,
    amenityScoringEligible: true,
    environmentalLayerEligible: true,
    heatmapEligible: true,
    featureStorageEligible: true,
    explainEvidenceEligible: true,
    displayContextAllowed: true,
    requiresSyntheticDemoMode: true,
  }),
  google_places_context: Object.freeze({
    sourceId: "google_places_context",
    displayName: "Google Places Context (Display-Only)",
    licenseName: "Google Maps Platform Terms of Service",
    attributionText: "Places context powered by Google",
    analysisEligible: false,
    amenityScoringEligible: false,
    environmentalLayerEligible: false,
    heatmapEligible: false,
    featureStorageEligible: false,
    explainEvidenceEligible: false,
    displayContextAllowed: true,
    requiresSyntheticDemoMode: false,
  }),
};

/**
 * Authoritative, deeply-frozen server-side source policy registry.
 */
export const SOURCE_POLICY_REGISTRY: Readonly<Record<SourceId, Readonly<SourcePolicyEntry>>> =
  Object.freeze(RAW_REGISTRY);

/**
 * Type guard checking if an unknown value is a registered `SourceId`.
 */
export function isKnownSourceId(value: unknown): value is SourceId {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(SOURCE_POLICY_REGISTRY, value)
  );
}

/**
 * Looks up the authoritative `SourcePolicyEntry` for a given `sourceId`,
 * returning `null` for unknown or unregistered sources.
 */
export function getSourcePolicy(sourceId: unknown): Readonly<SourcePolicyEntry> | null {
  if (!isKnownSourceId(sourceId)) {
    return null;
  }
  return SOURCE_POLICY_REGISTRY[sourceId];
}

/**
 * Determines whether a `sourceId` is eligible for server analysis (scoring, storage, evidence).
 *
 * - Always returns `false` for `"google_places_context"` and any unknown source.
 * - Returns `false` for `"synthetic_demo"` when `options.allowSyntheticDemo === false`.
 */
export function isSourceAnalysisEligible(
  sourceId: unknown,
  options?: SourcePolicyCheckOptions
): boolean {
  const policy = getSourcePolicy(sourceId);
  if (!policy || !policy.analysisEligible) {
    return false;
  }
  if (policy.requiresSyntheticDemoMode && options?.allowSyntheticDemo === false) {
    return false;
  }
  return true;
}

/**
 * Determines whether a `sourceId` is eligible for amenity convenience scoring & grid heatmaps.
 * (`osm_overpass`, `osm_extract`, and opt-in `synthetic_demo`; never `google_places_context` or `epa_frs`).
 */
export function isSourceAmenityEligible(
  sourceId: unknown,
  options?: SourcePolicyCheckOptions
): boolean {
  const policy = getSourcePolicy(sourceId);
  if (!policy || !policy.analysisEligible || !policy.amenityScoringEligible) {
    return false;
  }
  if (policy.requiresSyntheticDemoMode && options?.allowSyntheticDemo === false) {
    return false;
  }
  return true;
}

/**
 * Determines whether a `sourceId` is eligible for the separate environmental due-diligence layer.
 * (`epa_frs` and opt-in `synthetic_demo`; never `google_places_context`).
 */
export function isSourceEnvironmentalEligible(
  sourceId: unknown,
  options?: SourcePolicyCheckOptions
): boolean {
  const policy = getSourcePolicy(sourceId);
  if (!policy || !policy.analysisEligible || !policy.environmentalLayerEligible) {
    return false;
  }
  if (policy.requiresSyntheticDemoMode && options?.allowSyntheticDemo === false) {
    return false;
  }
  return true;
}

/**
 * Throws a `SourcePolicyViolationError` if the given `sourceId` is not eligible for analysis.
 */
export function assertSourceAnalysisEligible(
  sourceId: unknown,
  options?: SourcePolicyCheckOptions
): asserts sourceId is Exclude<SourceId, "google_places_context"> {
  if (!isSourceAnalysisEligible(sourceId, options)) {
    const idStr = typeof sourceId === "string" ? sourceId : String(sourceId);
    throw new SourcePolicyViolationError(idStr);
  }
}

/**
 * Strips any caller-supplied `analysisEligible` boolean on a record and replaces it
 * with the authoritative server-side registry determination.
 */
export function enforceSourcePolicyOnRecord<
  T extends { readonly sourceId: string; readonly analysisEligible?: boolean }
>(record: T, options?: SourcePolicyCheckOptions): T & { readonly analysisEligible: boolean } {
  const eligible = isSourceAnalysisEligible(record.sourceId, options);
  return {
    ...record,
    analysisEligible: eligible,
  };
}

export interface PartitionedFacilitiesResult<T> {
  readonly eligible: Array<T & { readonly analysisEligible: true }>;
  readonly rejected: Array<
    T & { readonly analysisEligible: false; readonly rejectionReason: string }
  >;
  readonly rejectedCountBySource: Record<string, number>;
}

/**
 * Partitions an array of candidate facility/environmental records by server source policy,
 * unconditionally rejecting `google_places_context` (even if the caller passed `analysisEligible: true`)
 * and any unknown or disabled sources.
 */
export function partitionFacilitiesBySourcePolicy<
  T extends { readonly sourceId: string; readonly analysisEligible?: boolean }
>(
  records: readonly T[],
  options?: SourcePolicyCheckOptions & { readonly requireAmenityEligible?: boolean }
): PartitionedFacilitiesResult<T> {
  const eligible: Array<T & { readonly analysisEligible: true }> = [];
  const rejected: Array<
    T & { readonly analysisEligible: false; readonly rejectionReason: string }
  > = [];
  const rejectedCountBySource: Record<string, number> = {};

  for (const record of records) {
    const rawSourceId =
      record && typeof record.sourceId === "string" ? record.sourceId : "unknown";
    const policy = getSourcePolicy(rawSourceId);

    let isAllowed = false;
    let rejectionReason = "";

    if (!policy) {
      rejectionReason = `Unregistered sourceId "${rawSourceId}" is barred by server source policy.`;
    } else if (!policy.analysisEligible) {
      rejectionReason = `Source "${rawSourceId}" (${policy.displayName}) is strictly display-only and barred from scoring, heatmaps, feature storage, and explanation evidence.`;
    } else if (policy.requiresSyntheticDemoMode && options?.allowSyntheticDemo === false) {
      rejectionReason = `Source "${rawSourceId}" requires ENABLE_SYNTHETIC_DEMO_MODE=true.`;
    } else if (options?.requireAmenityEligible && !policy.amenityScoringEligible) {
      rejectionReason = `Source "${rawSourceId}" belongs to the separate environmental due-diligence layer and cannot enter amenity convenience scoring.`;
    } else {
      isAllowed = true;
    }

    if (isAllowed) {
      eligible.push({
        ...record,
        analysisEligible: true,
      });
    } else {
      rejectedCountBySource[rawSourceId] = (rejectedCountBySource[rawSourceId] ?? 0) + 1;
      rejected.push({
        ...record,
        analysisEligible: false,
        rejectionReason,
      });
    }
  }

  return {
    eligible,
    rejected,
    rejectedCountBySource,
  };
}

/**
 * Convenience helper returning only the records that pass server-side source policy enforcement.
 */
export function filterEligibleFacilities<
  T extends { readonly sourceId: string; readonly analysisEligible?: boolean }
>(
  records: readonly T[],
  options?: SourcePolicyCheckOptions & { readonly requireAmenityEligible?: boolean }
): Array<T & { readonly analysisEligible: true }> {
  return partitionFacilitiesBySourcePolicy(records, options).eligible;
}
