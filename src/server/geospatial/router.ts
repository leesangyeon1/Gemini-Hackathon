/**
 * Geospatial Analysis Service & Express Router (`src/server/geospatial/router.ts`)
 *
 * Exposes `POST /api/geospatial/analyze` and server-side methods (`analyzeArea`,
 * `scorePointForArea`, `getCachedAreaGeospatial`) for deterministic multi-category
 * accessibility scoring, bounded grid/kernel Venn-like overlap, and separate EPA FRS
 * environmental due-diligence records.
 */

import { Router, type Request, type Response } from "express";
import {
  DEFAULT_SOURCE_ATTRIBUTIONS,
  ENVIRONMENTAL_LAYER_DISCLAIMER,
  MANDATORY_NON_CLAIMS,
} from "../../shared/constants";
import {
  ClientRequestSeqSchema,
  GeospatialAnalyzeRequestSchema,
  GeospatialAnalyzeResponseSchema,
  buildValidationErrorResponse,
  createDefaultPreferenceProfile,
} from "../../shared/schemas";
import type {
  AccessibilityResult,
  ApiErrorCode,
  ApiErrorResponse,
  CoordinatePoint,
  DisplayOnlyPlaceRecord,
  EnvironmentalLayerPayload,
  EnvironmentalRecord,
  FacilityRecord,
  GeospatialAnalyzeRequest,
  GeospatialAnalyzeResponse,
  PreferenceProfile,
  UiState,
} from "../../shared/types";
import {
  type ServerConfig,
  loadServerConfig,
  redactSecretsFromText,
} from "../config";
import {
  AreaGeospatialCache,
  type CachedAreaGeospatialEntry,
  buildSpatialFetchCacheKey,
} from "./cache";
import {
  fetchDisplayOnlyGooglePlacesContext,
  fetchEpaFrsEnvironmentalRecords,
  fetchOsmOverpassAmenities,
  generateSyntheticGeospatialDataset,
} from "./providers";
import {
  type CategorySourceStatus,
  type ScorableFacilityInput,
  computeAccessibilityScore,
  computeBoundedGridOverlap,
  computeGeodesicDistanceMeters,
  computeInfluenceBufferRadiusMeters,
  deduplicateFacilities,
  evaluateEnvironmentalLayer,
  validateCoordinates,
} from "./scoring";
import {
  SOURCE_POLICY_REGISTRY,
  partitionFacilitiesBySourcePolicy,
} from "./sourcePolicy";

/**
 * Checks whether validated coordinates fall within United States territory envelopes
 * (50 states, DC, Puerto Rico, US Virgin Islands, Guam/CNMI).
 */
export function isCoordinateWithinUsBounds(lat: number, lng: number): boolean {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return false;
  }
  // Contiguous 48 states + DC
  if (lat >= 24.0 && lat <= 50.0 && lng >= -125.5 && lng <= -66.0) {
    return true;
  }
  // Alaska
  if (lat >= 51.0 && lat <= 71.6 && lng >= -179.9 && lng <= -129.0) {
    return true;
  }
  // Hawaii
  if (lat >= 18.5 && lat <= 22.5 && lng >= -160.5 && lng <= -154.5) {
    return true;
  }
  // Puerto Rico & US Virgin Islands
  if (lat >= 17.5 && lat <= 18.6 && lng >= -67.5 && lng <= -64.5) {
    return true;
  }
  // Guam & Northern Mariana Islands
  if (lat >= 13.0 && lat <= 20.6 && lng >= 144.5 && lng <= 146.2) {
    return true;
  }
  return false;
}

export class GeospatialServiceError extends Error {
  public readonly statusCode: number;
  public readonly code: ApiErrorCode;
  public readonly uiState: UiState;
  public readonly retryable: boolean;
  public readonly missingEnvVarNames?: string[];

  constructor(params: {
    statusCode: number;
    code: ApiErrorCode;
    message: string;
    uiState: UiState;
    retryable?: boolean;
    missingEnvVarNames?: string[];
  }) {
    super(params.message);
    this.name = "GeospatialServiceError";
    this.statusCode = params.statusCode;
    this.code = params.code;
    this.uiState = params.uiState;
    this.retryable = params.retryable ?? false;
    this.missingEnvVarNames = params.missingEnvVarNames;
  }
}

export interface GeospatialModuleOptions {
  readonly config?: ServerConfig;
  readonly fetchImpl?: typeof fetch;
  readonly cache?: AreaGeospatialCache;
  readonly overpassTimeoutMs?: number;
  readonly epaTimeoutMs?: number;
  readonly placesTimeoutMs?: number;
  /**
   * Optional test hook allowing injection of candidate records (e.g. forged
   * `google_places_context` records with `analysisEligible: true`) to verify that
   * `sourcePolicy.ts` strips and rejects them before scoring, grid overlap, and storage.
   */
  readonly extraCandidateFacilities?: readonly ScorableFacilityInput[];
  readonly categoryStatusOverrides?: Readonly<Record<string, CategorySourceStatus>>;
}

export interface PointAreaScoreEvaluation {
  readonly accessibility: AccessibilityResult;
  readonly nearbyEnvironmentalCount: number;
  readonly environmentalRecords: EnvironmentalRecord[];
  readonly isSyntheticDemo: boolean;
  readonly fetchedAt: string;
}

export interface GeospatialModule {
  readonly geospatialRouter: Router;
  readonly analyzeArea: (
    request: GeospatialAnalyzeRequest
  ) => Promise<GeospatialAnalyzeResponse>;
  readonly scorePointForArea: (
    areaId: string,
    point: CoordinatePoint,
    preferences?: PreferenceProfile
  ) => PointAreaScoreEvaluation | null;
  readonly getCachedAreaGeospatial: (
    areaId: string
  ) => CachedAreaGeospatialEntry | null;
  readonly cache: AreaGeospatialCache;
  readonly clearCache: () => void;
}

function isServerConfig(
  value: ServerConfig | GeospatialModuleOptions | undefined
): value is ServerConfig {
  return Boolean(
    value &&
      typeof value === "object" &&
      "osmOverpassUrl" in value &&
      "enableSyntheticDemoMode" in value
  );
}

export function createGeospatialModule(
  configOrOptions?: ServerConfig | GeospatialModuleOptions,
  maybeOptions?: GeospatialModuleOptions
): GeospatialModule {
  const config: ServerConfig = isServerConfig(configOrOptions)
    ? configOrOptions
    : configOrOptions?.config ?? maybeOptions?.config ?? loadServerConfig();

  const options: GeospatialModuleOptions = isServerConfig(configOrOptions)
    ? maybeOptions ?? {}
    : configOrOptions ?? {};

  const cache = options.cache ?? new AreaGeospatialCache();

  async function analyzeArea(
    rawRequest: GeospatialAnalyzeRequest
  ): Promise<GeospatialAnalyzeResponse> {
    const preferences =
      rawRequest.preferences ?? createDefaultPreferenceProfile();
    const { analysisArea } = rawRequest;

    // 1. Validate finite WGS84 coordinates and US coverage gate
    const validCenter = validateCoordinates(
      analysisArea.centerLat,
      analysisArea.centerLng,
      "analysisArea center"
    );

    if (
      !analysisArea.isUsLocation ||
      !isCoordinateWithinUsBounds(validCenter.lat, validCenter.lng)
    ) {
      throw new GeospatialServiceError({
        statusCode: 422,
        code: "UNSUPPORTED_AREA",
        message: `Selected area "${analysisArea.label}" (${validCenter.lat}, ${validCenter.lng}) is outside supported United States geographic coverage.`,
        uiState: "unsupported_area",
        retryable: false,
      });
    }

    // 2. Check synthetic demo mode authorization
    const requestedSynthetic = Boolean(rawRequest.useSyntheticDemo);
    if (requestedSynthetic && !config.enableSyntheticDemoMode) {
      throw new GeospatialServiceError({
        statusCode: 403,
        code: "SETUP_NEEDED",
        message:
          "Synthetic Demo Mode was requested (`useSyntheticDemo: true`), but ENABLE_SYNTHETIC_DEMO_MODE is not enabled on the server.",
        uiState: "setup_needed",
        retryable: false,
        missingEnvVarNames: ["ENABLE_SYNTHETIC_DEMO_MODE"],
      });
    }

    const isSyntheticDemo = requestedSynthetic && config.enableSyntheticDemoMode;
    const dataMode: GeospatialAnalyzeResponse["dataMode"] = isSyntheticDemo
      ? "synthetic_demo"
      : "live_open_data";

    // 3. Compute influence-buffered fetch radius: analysisArea.radiusMeters + max(radius_c)
    const influenceFetchRadiusMeters = computeInfluenceBufferRadiusMeters(
      analysisArea.radiusMeters,
      preferences
    );

    const spatialKey = buildSpatialFetchCacheKey(
      validCenter.lat,
      validCenter.lng,
      influenceFetchRadiusMeters,
      isSyntheticDemo
    );

    // 4. Resolve or fetch licensed area dataset
    let cachedDataset = cache.getBySpatialKey(spatialKey);
    const existingByAreaId = cache.getByAreaId(analysisArea.areaId);
    if (
      !cachedDataset &&
      existingByAreaId &&
      existingByAreaId.isSyntheticDemo === isSyntheticDemo &&
      existingByAreaId.influenceFetchRadiusMeters >= influenceFetchRadiusMeters
    ) {
      cachedDataset = existingByAreaId;
    }

    let rawCandidates: ScorableFacilityInput[];
    let categorySourceStatuses: Record<string, CategorySourceStatus>;
    let environmentalLayer: EnvironmentalLayerPayload;
    let displayOnlyPlacesContext: DisplayOnlyPlaceRecord[];
    let fetchedAt: string;

    if (cachedDataset && !options.extraCandidateFacilities && !options.categoryStatusOverrides) {
      rawCandidates = cachedDataset.eligibleFacilityCandidates;
      categorySourceStatuses = cachedDataset.categorySourceStatuses;
      environmentalLayer = cachedDataset.environmentalLayer;
      displayOnlyPlacesContext = cachedDataset.displayOnlyPlacesContext;
      fetchedAt = cachedDataset.fetchedAt;
    } else {
      fetchedAt = new Date().toISOString();

      if (isSyntheticDemo) {
        const synth = generateSyntheticGeospatialDataset(
          analysisArea,
          influenceFetchRadiusMeters
        );
        rawCandidates = synth.facilities;
        categorySourceStatuses = synth.categorySourceStatuses;
        environmentalLayer = synth.environmentalLayer;
        displayOnlyPlacesContext = [];
      } else {
        const [osmResult, epaResult, placesContext] = await Promise.all([
          fetchOsmOverpassAmenities({
            osmOverpassUrl: config.osmOverpassUrl,
            centerLat: validCenter.lat,
            centerLng: validCenter.lng,
            fetchRadiusMeters: influenceFetchRadiusMeters,
            timeoutMs: options.overpassTimeoutMs,
            fetchImpl: options.fetchImpl,
          }),
          fetchEpaFrsEnvironmentalRecords({
            centerLat: validCenter.lat,
            centerLng: validCenter.lng,
            fetchRadiusMeters: influenceFetchRadiusMeters,
            timeoutMs: options.epaTimeoutMs,
            fetchImpl: options.fetchImpl,
          }),
          fetchDisplayOnlyGooglePlacesContext({
            googlePlacesServerKey: config.secrets.googlePlacesServerKey,
            centerLat: validCenter.lat,
            centerLng: validCenter.lng,
            radiusMeters: analysisArea.radiusMeters,
            timeoutMs: options.placesTimeoutMs,
            fetchImpl: options.fetchImpl,
          }),
        ]);

        rawCandidates = osmResult.facilities;
        categorySourceStatuses = osmResult.categorySourceStatuses;
        environmentalLayer = epaResult;
        displayOnlyPlacesContext = placesContext;
      }

      if (options.categoryStatusOverrides) {
        categorySourceStatuses = {
          ...categorySourceStatuses,
          ...options.categoryStatusOverrides,
        };
      }

      if (options.extraCandidateFacilities && options.extraCandidateFacilities.length > 0) {
        rawCandidates = [...rawCandidates, ...options.extraCandidateFacilities];
      }

      // Enforce source policy and deduplicate for canonical area storage
      const dedupedForStorage = deduplicateFacilities(rawCandidates, {
        allowSyntheticDemo: isSyntheticDemo,
        requireAmenityEligible: true,
      });

      const amenitiesForCache: FacilityRecord[] = dedupedForStorage.facilities.map(
        (fac) => {
          const distFromCenter = computeGeodesicDistanceMeters(
            validCenter.lat,
            validCenter.lng,
            fac.lat,
            fac.lng
          );
          const policy = SOURCE_POLICY_REGISTRY[fac.sourceId];
          return {
            id: fac.canonicalId,
            externalId: fac.externalId || undefined,
            sourceId: fac.sourceId,
            analysisEligible: true,
            category: fac.category,
            name: fac.name,
            lat: fac.lat,
            lng: fac.lng,
            distanceMeters: Math.round(distFromCenter * 100) / 100,
            tags: fac.original.tags
              ? { ...fac.original.tags }
              : undefined,
            attribution:
              policy?.attributionText ?? "© OpenStreetMap contributors (ODbL)",
          };
        }
      );

      const partitioned = partitionFacilitiesBySourcePolicy(rawCandidates, {
        allowSyntheticDemo: isSyntheticDemo,
        requireAmenityEligible: true,
      });

      cache.put(
        {
          areaId: analysisArea.areaId,
          spatialKey,
          analysisArea,
          isSyntheticDemo,
          dataMode,
          influenceFetchRadiusMeters,
          eligibleFacilityCandidates: partitioned.eligible,
          amenities: amenitiesForCache,
          categorySourceStatuses,
          environmentalLayer,
          displayOnlyPlacesContext,
          fetchedAt,
        },
        isSyntheticDemo
      );
    }

    // 5. Evaluate center accessibility (passing rawCandidates so rejected count is accurately reported)
    const centerAccessibility = computeAccessibilityScore(
      validCenter,
      rawCandidates,
      preferences,
      {
        allowSyntheticDemo: isSyntheticDemo,
        requireAmenityEligible: true,
        categorySourceStatuses,
      }
    );

    // 6. Evaluate requested property/point coordinates (`evaluatePoints`)
    const pointEvaluations: Record<string, AccessibilityResult> = {};
    if (Array.isArray(rawRequest.evaluatePoints)) {
      for (const pt of rawRequest.evaluatePoints) {
        const validPt = validateCoordinates(
          pt.lat,
          pt.lng,
          `evaluatePoints[${pt.id}]`
        );
        pointEvaluations[pt.id] = computeAccessibilityScore(
          validPt,
          rawCandidates,
          preferences,
          {
            allowSyntheticDemo: isSyntheticDemo,
            requireAmenityEligible: true,
            categorySourceStatuses,
          }
        );
      }
    }

    // 7. Compute bounded regular grid Venn-like multi-category overlap
    const gridOverlap = computeBoundedGridOverlap(
      validCenter,
      analysisArea.radiusMeters,
      rawCandidates,
      preferences,
      {
        gridResolution: rawRequest.gridResolution,
        overlapThreshold: rawRequest.overlapThreshold,
        allowSyntheticDemo: isSyntheticDemo,
        requireAmenityEligible: true,
        categorySourceStatuses,
      }
    );

    // 8. Build canonical deduplicated `amenities` list
    const latestCached = cache.getByAreaId(analysisArea.areaId);
    const amenities: FacilityRecord[] = latestCached ? latestCached.amenities : [];

    // Respect user preference visibility toggle for the separate environmental due-diligence layer
    const includeEnvLayer =
      preferences.includeEnvironmentalDueDiligenceLayer !== false;
    const effectiveEnvironmentalLayer: EnvironmentalLayerPayload = includeEnvLayer
      ? environmentalLayer
      : {
          status: environmentalLayer.status,
          records: [],
          disclaimer: ENVIRONMENTAL_LAYER_DISCLAIMER,
        };

    // 9. Determine canonical operational UI state
    let uiState: UiState = "ready";
    if (isSyntheticDemo) {
      uiState = "synthetic_demo";
    } else if (centerAccessibility.completeness === "unknown") {
      uiState = "timeout";
    } else if (
      centerAccessibility.completeness === "partial" ||
      environmentalLayer.status === "unknown"
    ) {
      uiState = "partial";
    } else if (amenities.length === 0) {
      uiState = "empty";
    }

    // 10. Assemble attributions and non-claims
    const sourceAttributions: string[] = [...DEFAULT_SOURCE_ATTRIBUTIONS];
    if (isSyntheticDemo) {
      sourceAttributions.unshift(
        "SYNTHETIC DEMO DATA — NOT LIVE MARKET OR FACILITY DATA"
      );
    }
    if (displayOnlyPlacesContext.length > 0) {
      sourceAttributions.push(
        "Places context powered by Google (Display-Only; Excluded from Spatial Scoring)"
      );
    }

    const responsePayload: GeospatialAnalyzeResponse = {
      uiState,
      dataMode,
      isSyntheticDemo,
      analysisArea,
      influenceFetchRadiusMeters,
      centerAccessibility,
      pointEvaluations,
      gridOverlap,
      amenities,
      environmentalLayer: effectiveEnvironmentalLayer,
      displayOnlyPlacesContext,
      sourceAttributions,
      nonClaims: [...MANDATORY_NON_CLAIMS],
      fetchedAt,
      ...(rawRequest.clientRequestSeq !== undefined
        ? { clientRequestSeq: rawRequest.clientRequestSeq }
        : {}),
    };

    return GeospatialAnalyzeResponseSchema.parse(responsePayload);
  }

  function getCachedAreaGeospatial(
    areaId: string
  ): CachedAreaGeospatialEntry | null {
    return cache.getByAreaId(areaId);
  }

  function scorePointForArea(
    areaId: string,
    point: CoordinatePoint,
    preferences?: PreferenceProfile
  ): PointAreaScoreEvaluation | null {
    const cached = cache.getByAreaId(areaId);
    if (!cached) {
      return null;
    }

    const validPoint = validateCoordinates(
      point.lat,
      point.lng,
      "property coordinate"
    );
    const effectivePrefs = preferences ?? createDefaultPreferenceProfile();

    const accessibility = computeAccessibilityScore(
      validPoint,
      cached.eligibleFacilityCandidates,
      effectivePrefs,
      {
        allowSyntheticDemo: cached.isSyntheticDemo,
        requireAmenityEligible: true,
        categorySourceStatuses: cached.categorySourceStatuses,
      }
    );

    const evaluatedEnv = evaluateEnvironmentalLayer(
      validPoint,
      cached.environmentalLayer.records,
      1600,
      { allowSyntheticDemo: cached.isSyntheticDemo }
    ).map((rec) => ({
      ...rec,
      attribution: cached.isSyntheticDemo
        ? SOURCE_POLICY_REGISTRY.synthetic_demo.attributionText
        : SOURCE_POLICY_REGISTRY.epa_frs.attributionText,
    }));

    return {
      accessibility,
      nearbyEnvironmentalCount: evaluatedEnv.length,
      environmentalRecords: evaluatedEnv,
      isSyntheticDemo: cached.isSyntheticDemo,
      fetchedAt: cached.fetchedAt,
    };
  }

  // ==========================================================================
  // Express Router (`POST /api/geospatial/analyze`)
  // ==========================================================================

  const geospatialRouter = Router();

  const handleAnalyzeRequest = async (
    req: Request,
    res: Response
  ): Promise<void> => {
    const seqParse =
      req.body && typeof req.body === "object"
        ? ClientRequestSeqSchema.safeParse(
            (req.body as { clientRequestSeq?: unknown }).clientRequestSeq
          )
        : null;
    const clientRequestSeq =
      seqParse && seqParse.success ? seqParse.data : undefined;

    const parsed = GeospatialAnalyzeRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      const errorPayload = buildValidationErrorResponse(
        parsed.error,
        clientRequestSeq
      );
      res.status(400).json(errorPayload);
      return;
    }

    try {
      const result = await analyzeArea(parsed.data);
      res.status(200).json(result);
    } catch (err) {
      if (err instanceof GeospatialServiceError) {
        const errorResponse: ApiErrorResponse = {
          error: {
            code: err.code,
            message: redactSecretsFromText(err.message, config),
            uiState: err.uiState,
            retryable: err.retryable,
            ...(err.missingEnvVarNames
              ? { missingEnvVarNames: err.missingEnvVarNames }
              : {}),
          },
          budget: null,
          ...(clientRequestSeq !== undefined ? { clientRequestSeq } : {}),
        };
        res.status(err.statusCode).json(errorResponse);
        return;
      }

      const rawMessage =
        err instanceof Error
          ? err.message
          : "Unexpected error during geospatial analysis.";
      const safeMessage = redactSecretsFromText(rawMessage, config);

      const fallbackError: ApiErrorResponse = {
        error: {
          code: "INTERNAL_ERROR",
          message: safeMessage,
          uiState: "recovery",
          retryable: true,
        },
        budget: null,
        ...(clientRequestSeq !== undefined ? { clientRequestSeq } : {}),
      };
      res.status(500).json(fallbackError);
    }
  };

  geospatialRouter.post("/analyze", handleAnalyzeRequest);
  geospatialRouter.post("/", handleAnalyzeRequest);

  return {
    geospatialRouter,
    analyzeArea,
    scorePointForArea,
    getCachedAreaGeospatial,
    cache,
    clearCache: () => cache.clear(),
  };
}
