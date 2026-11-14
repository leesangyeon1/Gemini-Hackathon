/**
 * Shared Zod Validation Schemas (`src/shared/schemas.ts`)
 *
 * Enforces strict runtime validation at all HTTP API boundaries, rejecting
 * `NaN`/`Infinity`, out-of-bounds coordinates, negative preference weights,
 * oversized payloads, and disallowed `google_places_context` evidence sources.
 */

import { z } from 'zod';
import {
  ACCESSIBILITY_COMPLETENESS_VALUES,
  ALL_SOURCE_IDS,
  AMENITY_CATEGORIES,
  ANALYSIS_BOUNDS,
  API_ERROR_CODES,
  BUDGET_STORE_MODES,
  DEFAULT_PREFERENCE_RADII_METERS,
  DEFAULT_PREFERENCE_WEIGHTS,
  PRICE_GAP_RANGE_POSITIONS,
  UI_STATES,
  VIEWPORT_APPROXIMATION_DISCLAIMER,
} from './constants';
import type { ApiErrorResponse, PreferenceProfile } from './types';

// ============================================================================
// Primitive Numeric, Coordinate & Identifier Validators
// ============================================================================

export const FiniteNumberSchema = z
  .number({ invalid_type_error: 'Expected a finite number.' })
  .finite('Value must be finite (not NaN or Infinity).');

export const LatitudeSchema = FiniteNumberSchema.min(-90, 'Latitude must be >= -90.').max(
  90,
  'Latitude must be <= 90.'
);

export const LongitudeSchema = FiniteNumberSchema.min(-180, 'Longitude must be >= -180.').max(
  180,
  'Longitude must be <= 180.'
);

export const CoordinatePointSchema = z.object({
  lat: LatitudeSchema,
  lng: LongitudeSchema,
});

export const BoundingBoxSchema = z
  .object({
    minLat: LatitudeSchema,
    maxLat: LatitudeSchema,
    minLng: LongitudeSchema,
    maxLng: LongitudeSchema,
  })
  .refine((b) => b.minLat <= b.maxLat, {
    message: 'minLat must be less than or equal to maxLat.',
    path: ['minLat'],
  });

export const ClientRequestSeqSchema = z.number().int().min(0).max(1_000_000_000).optional();

export function extractValidClientRequestSeq(raw: unknown): number | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const parsed = ClientRequestSeqSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

export const SessionIdSchema = z
  .string()
  .trim()
  .regex(/^[a-zA-Z0-9_-]{8,64}$/, 'sessionId must be 8–64 alphanumeric, underscore, or hyphen characters.');

export const SourceIdSchema = z.enum(ALL_SOURCE_IDS);
export const AnalysisEligibleSourceIdSchema = z.enum([
  'osm_overpass',
  'osm_extract',
  'epa_frs',
  'synthetic_demo',
]);
export const EnvironmentalSourceIdSchema = z.enum(['epa_frs', 'synthetic_demo']);
export const AmenityCategorySchema = z.enum(AMENITY_CATEGORIES);
export const UiStateSchema = z.enum(UI_STATES);
export const PriceGapRangePositionSchema = z.enum(PRICE_GAP_RANGE_POSITIONS);
export const AccessibilityCompletenessSchema = z.enum(ACCESSIBILITY_COMPLETENESS_VALUES);
export const BudgetStoreModeSchema = z.enum(BUDGET_STORE_MODES);
export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);

// ============================================================================
// Geography & Region Schemas
// ============================================================================

export const AreaRadiusMetersSchema = FiniteNumberSchema.min(
  ANALYSIS_BOUNDS.minAreaRadiusMeters,
  `radiusMeters must be >= ${ANALYSIS_BOUNDS.minAreaRadiusMeters}m.`
).max(
  ANALYSIS_BOUNDS.maxAreaRadiusMeters,
  `radiusMeters must be <= ${ANALYSIS_BOUNDS.maxAreaRadiusMeters}m.`
);

export const RegionCandidateSchema = z.object({
  candidateId: z.string().min(1).max(160),
  displayName: z.string().min(1).max(320),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zipCode: z.string().nullable(),
  centerLat: LatitudeSchema,
  centerLng: LongitudeSchema,
  suggestedRadiusMeters: AreaRadiusMetersSchema,
  boundingBox: BoundingBoxSchema,
  placeKind: z.enum(['city', 'neighborhood', 'zip', 'address', 'county', 'viewport']),
  isUsLocation: z.boolean(),
  isViewportApproximation: z.literal(true),
  source: z.enum(['census_geocoder', 'osm_nominatim', 'user_bounds', 'synthetic_demo']),
});

export const AnalysisAreaSchema = z.object({
  areaId: z.string().trim().min(1).max(160),
  label: z.string().trim().min(1).max(320),
  centerLat: LatitudeSchema,
  centerLng: LongitudeSchema,
  radiusMeters: AreaRadiusMetersSchema,
  boundingBox: BoundingBoxSchema,
  city: z.string().nullable(),
  state: z.string().nullable(),
  zipCode: z.string().nullable(),
  isUsLocation: z.literal(true),
  isViewportApproximation: z.literal(true),
  approximationDisclaimer: z.string().default(VIEWPORT_APPROXIMATION_DISCLAIMER),
});

export const RegionBoundsInputSchema = z.object({
  centerLat: LatitudeSchema,
  centerLng: LongitudeSchema,
  radiusMeters: AreaRadiusMetersSchema,
});

export const RegionResolveRequestSchema = z
  .object({
    query: z.string().trim().min(1).max(160).optional(),
    bounds: RegionBoundsInputSchema.optional(),
    preferredRadiusMeters: AreaRadiusMetersSchema.optional(),
    useSyntheticDemo: z.boolean().optional(),
    clientRequestSeq: ClientRequestSeqSchema,
  })
  .refine((data) => Boolean(data.query) !== Boolean(data.bounds), {
    message: 'Provide exactly one of `query` or `bounds`.',
    path: ['query'],
  });

export const RegionResolveResponseSchema = z.object({
  status: z.enum(['resolved', 'ambiguous', 'unsupported_area']),
  candidates: z.array(RegionCandidateSchema).max(10),
  selectedArea: AnalysisAreaSchema.nullable(),
  message: z.string(),
  clientRequestSeq: ClientRequestSeqSchema,
});

// ============================================================================
// Preference Profile & Geospatial Schemas (Fast-Food Default Weight = 0)
// ============================================================================

const CategoryWeightValueSchema = FiniteNumberSchema.min(
  0,
  'Category weight must be >= 0.'
).max(ANALYSIS_BOUNDS.maxCategoryWeight, `Category weight must be <= ${ANALYSIS_BOUNDS.maxCategoryWeight}.`);

const CategoryRadiusValueSchema = FiniteNumberSchema.min(
  ANALYSIS_BOUNDS.minCategoryRadiusMeters,
  `Category radiusMeters must be >= ${ANALYSIS_BOUNDS.minCategoryRadiusMeters}m.`
).max(
  ANALYSIS_BOUNDS.maxCategoryRadiusMeters,
  `Category radiusMeters must be <= ${ANALYSIS_BOUNDS.maxCategoryRadiusMeters}m.`
);

const CategoryCapValueSchema = FiniteNumberSchema.gt(0, 'Saturation cap must be > 0.').max(50);

export const PreferenceWeightsSchema = z.object({
  grocery: CategoryWeightValueSchema.default(DEFAULT_PREFERENCE_WEIGHTS.grocery),
  parks: CategoryWeightValueSchema.default(DEFAULT_PREFERENCE_WEIGHTS.parks),
  transit: CategoryWeightValueSchema.default(DEFAULT_PREFERENCE_WEIGHTS.transit),
  healthcare: CategoryWeightValueSchema.default(DEFAULT_PREFERENCE_WEIGHTS.healthcare),
  schools: CategoryWeightValueSchema.default(DEFAULT_PREFERENCE_WEIGHTS.schools),
  /** Commercial / fast-food context defaults to 0 weight */
  fast_food: CategoryWeightValueSchema.default(DEFAULT_PREFERENCE_WEIGHTS.fast_food),
});

export const PreferenceRadiiSchema = z.object({
  grocery: CategoryRadiusValueSchema.default(DEFAULT_PREFERENCE_RADII_METERS.grocery),
  parks: CategoryRadiusValueSchema.default(DEFAULT_PREFERENCE_RADII_METERS.parks),
  transit: CategoryRadiusValueSchema.default(DEFAULT_PREFERENCE_RADII_METERS.transit),
  healthcare: CategoryRadiusValueSchema.default(DEFAULT_PREFERENCE_RADII_METERS.healthcare),
  schools: CategoryRadiusValueSchema.default(DEFAULT_PREFERENCE_RADII_METERS.schools),
  fast_food: CategoryRadiusValueSchema.default(DEFAULT_PREFERENCE_RADII_METERS.fast_food),
});

export const PreferenceCapsSchema = z
  .object({
    grocery: CategoryCapValueSchema.optional(),
    parks: CategoryCapValueSchema.optional(),
    transit: CategoryCapValueSchema.optional(),
    healthcare: CategoryCapValueSchema.optional(),
    schools: CategoryCapValueSchema.optional(),
    fast_food: CategoryCapValueSchema.optional(),
  })
  .optional();

export const PreferenceProfileSchema = z.object({
  weights: PreferenceWeightsSchema.default({ ...DEFAULT_PREFERENCE_WEIGHTS }),
  radiiMeters: PreferenceRadiiSchema.default({ ...DEFAULT_PREFERENCE_RADII_METERS }),
  caps: PreferenceCapsSchema,
  includeEnvironmentalDueDiligenceLayer: z.boolean().default(true),
  optionalExternalityPenaltyWeight: FiniteNumberSchema.min(0).max(50).default(0),
});

export function createDefaultPreferenceProfile(): PreferenceProfile {
  return {
    weights: { ...DEFAULT_PREFERENCE_WEIGHTS },
    radiiMeters: { ...DEFAULT_PREFERENCE_RADII_METERS },
    includeEnvironmentalDueDiligenceLayer: true,
    optionalExternalityPenaltyWeight: 0,
  };
}

export const FacilityRecordSchema = z
  .object({
    id: z.string().min(1),
    externalId: z.string().optional(),
    sourceId: SourceIdSchema,
    analysisEligible: z.boolean(),
    category: z.string().min(1),
    name: z.string(),
    lat: LatitudeSchema,
    lng: LongitudeSchema,
    distanceMeters: FiniteNumberSchema.min(0).optional(),
    tags: z.record(z.string(), z.string()).optional(),
    attribution: z.string(),
  })
  .refine((record) => !(record.sourceId === 'google_places_context' && record.analysisEligible), {
    message:
      'Source "google_places_context" is display-only and cannot have analysisEligible: true.',
    path: ['analysisEligible'],
  });

export const EnvironmentalRecordSchema = z.object({
  id: z.string().min(1),
  registryId: z.string().min(1),
  sourceId: EnvironmentalSourceIdSchema,
  name: z.string().min(1),
  lat: LatitudeSchema,
  lng: LongitudeSchema,
  distanceMeters: FiniteNumberSchema.min(0),
  programs: z.array(z.string()),
  status: z.string(),
  profileUrl: z.string().url().optional(),
  dueDiligenceNotice: z.string(),
  isAutomaticHealthDetermination: z.literal(false),
  attribution: z.string().optional(),
});

export const DisplayOnlyPlaceRecordSchema = z.object({
  placeId: z.string().min(1),
  sourceId: z.literal('google_places_context'),
  analysisEligible: z.literal(false),
  name: z.string(),
  lat: LatitudeSchema,
  lng: LongitudeSchema,
  primaryType: z.string().optional(),
  formattedAddress: z.string().optional(),
  attribution: z.string(),
});

export const EvaluatedFacilityContributionSchema = z.object({
  id: z.string(),
  name: z.string(),
  sourceId: AnalysisEligibleSourceIdSchema,
  category: z.string(),
  lat: LatitudeSchema,
  lng: LongitudeSchema,
  distanceMeters: FiniteNumberSchema.min(0),
  kernelValue: FiniteNumberSchema.min(0).max(1),
});

export const CategoryScoreBreakdownSchema = z.object({
  category: z.string(),
  label: z.string(),
  weight: FiniteNumberSchema.min(0),
  radiusMeters: FiniteNumberSchema.gt(0),
  cap: FiniteNumberSchema.gt(0),
  status: z.enum(['ok', 'unknown']),
  facilityCount: z.number().int().min(0),
  rawKernelSum: FiniteNumberSchema.min(0),
  intensity: FiniteNumberSchema.min(0).max(1).nullable(),
  effectiveIntensity: FiniteNumberSchema.min(0).max(1),
  weightedContribution: FiniteNumberSchema.min(0),
  nearestDistanceMeters: FiniteNumberSchema.min(0).nullable(),
  topFacilities: z.array(EvaluatedFacilityContributionSchema),
});

export const AccessibilityResultSchema = z.object({
  score: FiniteNumberSchema.min(0).max(100),
  completeness: AccessibilityCompletenessSchema,
  missingOrFailedCategories: z.array(z.string()),
  failedWeightedCategories: z.array(z.string()),
  categoryBreakdown: z.record(z.string(), CategoryScoreBreakdownSchema),
  categories: z.array(CategoryScoreBreakdownSchema),
  totalWeight: FiniteNumberSchema.min(0),
  knownWeight: FiniteNumberSchema.min(0),
  knownWeightFraction: FiniteNumberSchema.min(0).max(1),
  deduplicatedFacilityCount: z.number().int().min(0),
  duplicatesMergedCount: z.number().int().min(0),
  rejectedFacilityCount: z.number().int().min(0),
  rejectedCountBySource: z.record(z.string(), z.number().int().min(0)),
});

export const GridOverlapCellSchema = z.object({
  cellId: z.string(),
  row: z.number().int().min(0),
  col: z.number().int().min(0),
  lat: LatitudeSchema,
  lng: LongitudeSchema,
  distanceFromCenterMeters: FiniteNumberSchema.min(0),
  accessibilityScore: FiniteNumberSchema.min(0).max(100),
  completeness: AccessibilityCompletenessSchema,
  categoryIntensities: z.record(z.string(), FiniteNumberSchema.min(0).max(1).nullable()),
  presentCategories: z.array(z.string()),
  overlapCount: z.number().int().min(0),
  minActiveIntensity: FiniteNumberSchema.min(0).max(1),
});

export const BoundedGridOverlapResultSchema = z.object({
  center: CoordinatePointSchema,
  radiusMeters: FiniteNumberSchema.gt(0),
  gridResolution: z.number().int().min(ANALYSIS_BOUNDS.minGridResolution).max(ANALYSIS_BOUNDS.maxGridResolution),
  overlapThreshold: FiniteNumberSchema.gt(0).max(1),
  activeCategories: z.array(z.string()),
  maxOverlapCount: z.number().int().min(0),
  cells: z.array(GridOverlapCellSchema),
  sweetSpotCells: z.array(GridOverlapCellSchema),
});

export const EvaluatePointInputSchema = z.object({
  id: z.string().trim().min(1).max(160),
  lat: LatitudeSchema,
  lng: LongitudeSchema,
});

export const GeospatialAnalyzeRequestSchema = z.object({
  analysisArea: AnalysisAreaSchema,
  preferences: PreferenceProfileSchema.default(createDefaultPreferenceProfile()),
  gridResolution: z
    .number()
    .int()
    .min(ANALYSIS_BOUNDS.minGridResolution)
    .max(ANALYSIS_BOUNDS.maxGridResolution)
    .optional(),
  overlapThreshold: FiniteNumberSchema.gt(0).max(1).optional(),
  evaluatePoints: z
    .array(EvaluatePointInputSchema)
    .max(ANALYSIS_BOUNDS.maxEvaluatePoints)
    .optional(),
  useSyntheticDemo: z.boolean().optional(),
  clientRequestSeq: ClientRequestSeqSchema,
});

export const GeospatialAnalyzeResponseSchema = z.object({
  uiState: UiStateSchema,
  dataMode: z.enum(['live_open_data', 'synthetic_demo']),
  isSyntheticDemo: z.boolean(),
  analysisArea: AnalysisAreaSchema,
  influenceFetchRadiusMeters: FiniteNumberSchema.gt(0),
  centerAccessibility: AccessibilityResultSchema,
  pointEvaluations: z.record(z.string(), AccessibilityResultSchema),
  gridOverlap: BoundedGridOverlapResultSchema,
  amenities: z.array(FacilityRecordSchema),
  environmentalLayer: z.object({
    status: z.enum(['ok', 'unknown']),
    records: z.array(EnvironmentalRecordSchema),
    disclaimer: z.string(),
  }),
  displayOnlyPlacesContext: z.array(DisplayOnlyPlaceRecordSchema),
  sourceAttributions: z.array(z.string()),
  nonClaims: z.array(z.string()),
  fetchedAt: z.string(),
  clientRequestSeq: ClientRequestSeqSchema,
});

// ============================================================================
// Property, Valuation, Price-Gap & Durable Budget Schemas
// ============================================================================

export const ComparableListingRecordSchema = z.object({
  id: z.string(),
  formattedAddress: z.string(),
  propertyType: z.string().nullable(),
  bedrooms: FiniteNumberSchema.min(0).nullable(),
  bathrooms: FiniteNumberSchema.min(0).nullable(),
  squareFootage: FiniteNumberSchema.min(0).nullable(),
  price: FiniteNumberSchema.gt(0).nullable(),
  status: z.string().nullable(),
  lastSeenAt: z.string().nullable(),
  distanceMiles: FiniteNumberSchema.min(0).nullable(),
  correlation: FiniteNumberSchema.min(0).max(1).nullable(),
  daysOld: FiniteNumberSchema.min(0).nullable(),
  isSubjectDuplicate: z.boolean(),
});

export const ComparablesSummarySchema = z.object({
  compCount: z.number().int().min(0),
  medianCompPrice: FiniteNumberSchema.gt(0).nullable(),
  minDistanceMiles: FiniteNumberSchema.min(0).nullable(),
  maxDistanceMiles: FiniteNumberSchema.min(0).nullable(),
  meanCorrelation: FiniteNumberSchema.min(0).max(1).nullable(),
  subjectIncludedInComps: z.boolean(),
  comparables: z.array(ComparableListingRecordSchema),
});

export const PriceGapResultSchema = z.object({
  gapPct: FiniteNumberSchema.nullable(),
  gapAmountUsd: FiniteNumberSchema.nullable(),
  rangePosition: PriceGapRangePositionSchema,
  askingPrice: FiniteNumberSchema.gt(0).nullable(),
  avmPrice: FiniteNumberSchema.gt(0).nullable(),
  avmLow: FiniteNumberSchema.gt(0).nullable(),
  avmHigh: FiniteNumberSchema.gt(0).nullable(),
  isWithinEstimateRange: z.boolean().nullable(),
  isProvenUndervaluation: z.literal(false),
  interpretationNote: z.string(),
});

export const ContraryEvidenceItemSchema = z.object({
  code: z.enum([
    'asking_inside_avm_range',
    'subject_included_in_comps',
    'wide_avm_uncertainty_band',
    'few_comparables',
    'distant_comparables',
    'stale_listing_timestamp',
    'non_standard_property_type',
    'missing_structural_attributes',
    'avm_methodology_limitation',
  ]),
  severity: z.enum(['info', 'caution', 'warning']),
  title: z.string(),
  detail: z.string(),
});

export const PropertyListingSummarySchema = z.object({
  id: z.string().min(1),
  formattedAddress: z.string().min(1),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zipCode: z.string().nullable(),
  latitude: LatitudeSchema,
  longitude: LongitudeSchema,
  propertyType: z.string(),
  bedrooms: FiniteNumberSchema.min(0).nullable(),
  bathrooms: FiniteNumberSchema.min(0).nullable(),
  squareFootage: FiniteNumberSchema.min(0).nullable(),
  lotSize: FiniteNumberSchema.min(0).nullable(),
  yearBuilt: z.number().int().min(1600).max(2100).nullable(),
  askingPrice: FiniteNumberSchema.gt(0).nullable(),
  listingLastSeenAt: z.string().nullable(),
  avmPrice: FiniteNumberSchema.gt(0).nullable(),
  avmLow: FiniteNumberSchema.gt(0).nullable(),
  avmHigh: FiniteNumberSchema.gt(0).nullable(),
  avmFetchedAt: z.string().nullable(),
  lastSalePrice: FiniteNumberSchema.gt(0).nullable(),
  lastSaleDate: z.string().nullable(),
  assessedValue: FiniteNumberSchema.gt(0).nullable(),
  assessedYear: z.number().int().min(1900).max(2100).nullable().optional(),
  comparablesSummary: ComparablesSummarySchema.nullable(),
  priceGap: PriceGapResultSchema,
  accessibility: AccessibilityResultSchema.nullable(),
  nearbyEnvironmentalCount: z.number().int().min(0),
  dataProvenance: z.enum(['rentcast_live', 'synthetic_demo']),
});

export const PropertyDetailRecordSchema = PropertyListingSummarySchema.extend({
  contraryEvidence: z.array(ContraryEvidenceItemSchema),
});

export const BudgetSnapshotSchema = z.object({
  billingMonth: z.string().regex(/^\d{4}-\d{2}$/),
  globalMonthlyLimit: z.number().int().min(1).max(49),
  initialSpentCalls: z.number().int().min(0),
  runtimeSpentCalls: z.number().int().min(0),
  totalSpentCalls: z.number().int().min(0),
  globalRemaining: z.number().int().min(0),
  sessionId: z.string().nullable(),
  sessionListingsUsed: z.number().int().min(0),
  sessionListingsLimit: z.number().int().min(1),
  sessionAvmsUsed: z.number().int().min(0),
  sessionAvmsLimit: z.number().int().min(1),
  sessionPropertyRecordsUsed: z.number().int().min(0),
  sessionPropertyRecordsLimit: z.number().int().min(0),
  sessionExpanded: z.boolean(),
  durabilityMode: BudgetStoreModeSchema,
  quotaExhausted: z.boolean(),
});

export const PropertySearchRequestSchema = z.object({
  sessionId: SessionIdSchema.optional(),
  analysisArea: AnalysisAreaSchema,
  limit: z
    .number()
    .int()
    .min(1)
    .max(ANALYSIS_BOUNDS.maxListingsPerSearch)
    .default(ANALYSIS_BOUNDS.maxListingsPerSearch),
  propertyType: z
    .enum(['Single Family', 'Condo', 'Townhouse', 'Multi-Family', 'Manufactured', 'Land', 'Other'])
    .optional(),
  preferences: PreferenceProfileSchema.optional(),
  useSyntheticDemo: z.boolean().optional(),
  clientRequestSeq: ClientRequestSeqSchema,
});

export const PropertySearchResponseSchema = z.object({
  sessionId: SessionIdSchema,
  uiState: UiStateSchema,
  isSyntheticDemo: z.boolean(),
  fromCache: z.boolean(),
  listings: z.array(PropertyListingSummarySchema).max(ANALYSIS_BOUNDS.maxListingsPerSearch),
  budget: BudgetSnapshotSchema,
  fetchedAt: z.string(),
  clientRequestSeq: ClientRequestSeqSchema,
});

export const PropertySubjectSnapshotInputSchema = z.object({
  formattedAddress: z.string().trim().min(1).max(320),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  zipCode: z.string().nullable().optional(),
  latitude: LatitudeSchema,
  longitude: LongitudeSchema,
  propertyType: z.string().max(80).optional(),
  bedrooms: FiniteNumberSchema.min(0).nullable().optional(),
  bathrooms: FiniteNumberSchema.min(0).nullable().optional(),
  squareFootage: FiniteNumberSchema.min(0).nullable().optional(),
  lotSize: FiniteNumberSchema.min(0).nullable().optional(),
  yearBuilt: z.number().int().min(1600).max(2100).nullable().optional(),
  askingPrice: FiniteNumberSchema.gt(0).nullable().optional(),
  listingLastSeenAt: z.string().nullable().optional(),
});

export const PropertyAvmRequestSchema = z.object({
  sessionId: SessionIdSchema,
  propertySnapshot: PropertySubjectSnapshotInputSchema.optional(),
  includeRecentSalesRecord: z.boolean().default(false),
  useSyntheticDemo: z.boolean().optional(),
  clientRequestSeq: ClientRequestSeqSchema,
});

export const PropertyAvmResponseSchema = z.object({
  sessionId: SessionIdSchema,
  uiState: UiStateSchema,
  isSyntheticDemo: z.boolean(),
  fromCache: z.boolean(),
  property: PropertyDetailRecordSchema,
  budget: BudgetSnapshotSchema,
  disclaimers: z.array(z.string()),
  clientRequestSeq: ClientRequestSeqSchema,
});

export const SessionExpandRequestSchema = z.object({
  userConfirmed: z.literal(true, {
    errorMap: () => ({ message: 'userConfirmed must be explicitly true to expand session budget.' }),
  }),
  clientRequestSeq: ClientRequestSeqSchema,
});

export const SessionExpandResponseSchema = z.object({
  sessionId: SessionIdSchema,
  expanded: z.boolean(),
  budget: BudgetSnapshotSchema,
  message: z.string(),
  clientRequestSeq: ClientRequestSeqSchema,
});

// ============================================================================
// Grounded Gemini Explanation Schemas (`/api/explain`)
// ============================================================================

export const EligibleExplainEvidenceSourceSchema = z.enum([
  'osm_overpass',
  'osm_extract',
  'epa_frs',
  'synthetic_demo',
  'rentcast',
]);

export const ExplainEvidenceItemSchema = z.object({
  evidenceId: z.string().min(1).max(120),
  sourceId: EligibleExplainEvidenceSourceSchema,
  label: z.string().min(1).max(240),
  detail: z.string().min(1).max(600),
});

export const ExplainDataAsOfSchema = z.object({
  listingLastSeenAt: z.string().nullable(),
  avmFetchedAt: z.string().nullable(),
  geospatialFetchedAt: z.string().nullable(),
});

export const ExplainRequestSchema = z.object({
  sessionId: SessionIdSchema,
  propertyId: z.string().trim().min(1).max(160),
  preferences: PreferenceProfileSchema.default(createDefaultPreferenceProfile()),
  propertyContext: PropertyDetailRecordSchema.optional(),
  accessibilityContext: AccessibilityResultSchema.optional(),
  environmentalRecords: z.array(EnvironmentalRecordSchema).max(25).optional(),
  useSyntheticDemo: z.boolean().optional(),
  clientRequestSeq: ClientRequestSeqSchema,
});

/**
 * Schema for structured JSON returned by Gemini prior to server post-validation.
 */
export const GeminiStructuredExplainPayloadSchema = z.object({
  summary: z.string().min(1).max(1200),
  evidenceIds: z.array(z.string().min(1).max(120)).max(25),
  positiveFactors: z.array(z.string().min(1).max(400)).max(8),
  contraryAndUncertaintyFactors: z.array(z.string().min(1).max(400)).max(8),
  limitations: z.array(z.string().min(1).max(400)).max(8),
});

export const ExplainResponseSchema = z.object({
  explanationAvailable: z.boolean(),
  fallbackUsed: z.boolean(),
  unavailableReason: z.string().nullable(),
  modelUsed: z.string().nullable(),
  isSyntheticDemo: z.boolean(),
  summary: z.string(),
  evidenceIds: z.array(z.string()),
  evidenceCatalog: z.array(ExplainEvidenceItemSchema),
  positiveFactors: z.array(z.string()),
  contraryAndUncertaintyFactors: z.array(z.string()),
  limitations: z.array(z.string()),
  dataAsOf: ExplainDataAsOfSchema,
  clientRequestSeq: ClientRequestSeqSchema,
});

// ============================================================================
// Health, Public Runtime Config & Safe Error Schemas
// ============================================================================

export const RuntimeCapabilitiesSchema = z.object({
  rentcastConfigured: z.boolean(),
  geminiConfigured: z.boolean(),
  mapsBasemapConfigured: z.boolean(),
  placesContextConfigured: z.boolean(),
  syntheticDemoEnabled: z.boolean(),
});

export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  version: z.string(),
  timestamp: z.string(),
  uptimeSeconds: FiniteNumberSchema.min(0),
  durabilityMode: BudgetStoreModeSchema,
  capabilities: RuntimeCapabilitiesSchema,
});

export const PublicRuntimeConfigSchema = z.object({
  appTitle: z.string(),
  uiSetupState: z.enum(['ready', 'setup_needed', 'synthetic_demo']),
  capabilities: RuntimeCapabilitiesSchema,
  missingSetupEnvVars: z.array(
    z.object({
      envVarName: z.string(),
      feature: z.string(),
      requiredForLiveMode: z.boolean(),
    })
  ),
  mapsBrowserKey: z.string().nullable(),
  defaultPreferences: PreferenceProfileSchema,
  analysisBounds: z.object({
    minAreaRadiusMeters: z.number(),
    maxAreaRadiusMeters: z.number(),
    defaultAreaRadiusMeters: z.number(),
    minCategoryRadiusMeters: z.number(),
    maxCategoryRadiusMeters: z.number(),
    maxListingsPerSearch: z.number(),
  }),
  budgetLimits: z.object({
    globalMonthlyLimit: z.number(),
    defaultSessionListingsLimit: z.number(),
    defaultSessionAvmsLimit: z.number(),
    expandedSessionAvmsLimit: z.number(),
    expandedSessionPropertyRecordsLimit: z.number(),
    durabilityMode: BudgetStoreModeSchema,
  }),
  attributions: z.array(z.string()),
});

export const ApiErrorResponseSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
    uiState: UiStateSchema.optional(),
    retryable: z.boolean(),
    missingEnvVarNames: z.array(z.string()).optional(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
  budget: BudgetSnapshotSchema.nullable().optional(),
  clientRequestSeq: ClientRequestSeqSchema,
});

/**
 * Converts a ZodError into a sanitized `ApiErrorResponse` (never echoing secret values).
 */
export function buildValidationErrorResponse(
  zodError: z.ZodError,
  clientRequestSeq?: unknown
): ApiErrorResponse {
  const flattened = zodError.flatten();
  const firstIssue = zodError.issues[0];
  const pathPrefix =
    firstIssue && firstIssue.path.length > 0 ? `${firstIssue.path.join('.')}: ` : '';
  const validSeq = extractValidClientRequestSeq(clientRequestSeq);

  return {
    error: {
      code: 'VALIDATION_ERROR',
      message: firstIssue
        ? `${pathPrefix}${firstIssue.message}`
        : 'Invalid request payload.',
      uiState: 'recovery',
      retryable: false,
      details: {
        fieldErrors: flattened.fieldErrors,
        formErrors: flattened.formErrors,
      },
    },
    budget: null,
    ...(validSeq !== undefined ? { clientRequestSeq: validSeq } : {}),
  };
}
