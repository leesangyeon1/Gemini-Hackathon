/**
 * Shared TypeScript Domain & HTTP Contract Interfaces (`src/shared/types.ts`)
 *
 * Matches `docs/API-CONTRACTS.md`, `src/server/geospatial/sourcePolicy.ts`,
 * `src/server/geospatial/scoring.ts`, and `docs/DATA-SOURCES.md`.
 */

import type {
  ACCESSIBILITY_COMPLETENESS_VALUES,
  ALL_SOURCE_IDS,
  AMENITY_CATEGORIES,
  API_ERROR_CODES,
  BUDGET_STORE_MODES,
  PRICE_GAP_RANGE_POSITIONS,
  UI_STATES,
} from './constants';

export type SourceId = (typeof ALL_SOURCE_IDS)[number];
export type AmenityCategory = (typeof AMENITY_CATEGORIES)[number];
export type UiState = (typeof UI_STATES)[number];
export type PriceGapRangePosition = (typeof PRICE_GAP_RANGE_POSITIONS)[number];
export type AccessibilityCompleteness = (typeof ACCESSIBILITY_COMPLETENESS_VALUES)[number];
export type BudgetStoreMode = (typeof BUDGET_STORE_MODES)[number];
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface CoordinatePoint {
  lat: number;
  lng: number;
}

export interface BoundingBox {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

// ============================================================================
// Geography & Region Resolution (`/api/regions/resolve`)
// ============================================================================

export type RegionResolveStatus = 'resolved' | 'ambiguous' | 'unsupported_area';

export type RegionPlaceKind =
  | 'city'
  | 'neighborhood'
  | 'zip'
  | 'address'
  | 'county'
  | 'viewport';

export interface RegionCandidate {
  candidateId: string;
  displayName: string;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  centerLat: number;
  centerLng: number;
  suggestedRadiusMeters: number;
  boundingBox: BoundingBox;
  placeKind: RegionPlaceKind;
  isUsLocation: boolean;
  isViewportApproximation: true;
  source: 'census_geocoder' | 'osm_nominatim' | 'user_bounds' | 'synthetic_demo';
}

export interface AnalysisArea {
  areaId: string;
  label: string;
  centerLat: number;
  centerLng: number;
  radiusMeters: number;
  boundingBox: BoundingBox;
  city: string | null;
  state: string | null;
  zipCode: string | null;
  isUsLocation: true;
  isViewportApproximation: true;
  approximationDisclaimer: string;
}

// ============================================================================
// Preferences, Facilities, Environmental Records & Accessibility Scoring
// ============================================================================

export interface PreferenceProfile {
  /** Non-negative user preference weights (`w_c >= 0`); `fast_food` defaults to `0` */
  weights: Record<AmenityCategory, number>;
  /** Positive geodesic kernel radii in meters (`radius_c > 0`) */
  radiiMeters: Record<AmenityCategory, number>;
  /** Optional category saturation caps (`cap_c > 0`) */
  caps?: Partial<Record<AmenityCategory, number>>;
  /** Whether the separate EPA FRS environmental due-diligence layer is visible */
  includeEnvironmentalDueDiligenceLayer?: boolean;
  /** Optional user-defined externality preference penalty (`0..50`, never market dollars) */
  optionalExternalityPenaltyWeight?: number;
}

export interface FacilityRecord {
  id: string;
  externalId?: string;
  sourceId: SourceId;
  /** Server-enforced eligibility flag (`false` unconditionally for `google_places_context`) */
  analysisEligible: boolean;
  category: AmenityCategory | string;
  name: string;
  lat: number;
  lng: number;
  distanceMeters?: number;
  tags?: Record<string, string>;
  attribution: string;
}

export interface EnvironmentalRecord {
  id: string;
  registryId: string;
  sourceId: SourceId;
  name: string;
  lat: number;
  lng: number;
  distanceMeters: number;
  programs: string[];
  status: string;
  profileUrl?: string;
  dueDiligenceNotice: string;
  isAutomaticHealthDetermination: false;
  attribution?: string;
}

export interface DisplayOnlyPlaceRecord {
  placeId: string;
  sourceId: 'google_places_context';
  analysisEligible: false;
  name: string;
  lat: number;
  lng: number;
  primaryType?: string;
  formattedAddress?: string;
  attribution: string;
}

export interface EvaluatedFacilityContribution {
  id: string;
  name: string;
  sourceId: SourceId;
  category: string;
  lat: number;
  lng: number;
  distanceMeters: number;
  kernelValue: number;
}

export interface CategoryScoreBreakdown {
  category: string;
  label: string;
  weight: number;
  radiusMeters: number;
  cap: number;
  status: 'ok' | 'unknown';
  facilityCount: number;
  rawKernelSum: number;
  /** `a_c` in `[0, 1]` when `status === "ok"`, or `null` when `status === "unknown"` */
  intensity: number | null;
  effectiveIntensity: number;
  weightedContribution: number;
  nearestDistanceMeters: number | null;
  topFacilities: EvaluatedFacilityContribution[];
}

export interface AccessibilityResult {
  /** Deterministic weighted accessibility score `A` in `[0, 100]` */
  score: number;
  completeness: AccessibilityCompleteness;
  missingOrFailedCategories: string[];
  failedWeightedCategories: string[];
  categoryBreakdown: Record<string, CategoryScoreBreakdown>;
  categories: CategoryScoreBreakdown[];
  totalWeight: number;
  knownWeight: number;
  knownWeightFraction: number;
  deduplicatedFacilityCount: number;
  duplicatesMergedCount: number;
  rejectedFacilityCount: number;
  rejectedCountBySource: Record<string, number>;
}

export type AccessibilityScoreResult = AccessibilityResult;

export interface GridOverlapCell {
  cellId: string;
  row: number;
  col: number;
  lat: number;
  lng: number;
  distanceFromCenterMeters: number;
  accessibilityScore: number;
  completeness: AccessibilityCompleteness;
  categoryIntensities: Record<string, number | null>;
  presentCategories: string[];
  overlapCount: number;
  minActiveIntensity: number;
}

export interface BoundedGridOverlapResult {
  center: CoordinatePoint;
  radiusMeters: number;
  gridResolution: number;
  overlapThreshold: number;
  activeCategories: string[];
  maxOverlapCount: number;
  cells: GridOverlapCell[];
  sweetSpotCells: GridOverlapCell[];
}

// ============================================================================
// Property Listings, On-Demand AVM, Price-Gap & Durable Budget
// ============================================================================

export type ResidentialPropertyType =
  | 'Single Family'
  | 'Condo'
  | 'Townhouse'
  | 'Multi-Family'
  | 'Manufactured'
  | 'Land'
  | 'Other';

export interface ComparableListingRecord {
  id: string;
  formattedAddress: string;
  propertyType: string | null;
  bedrooms: number | null;
  bathrooms: number | null;
  squareFootage: number | null;
  price: number | null;
  status: string | null;
  lastSeenAt: string | null;
  distanceMiles: number | null;
  correlation: number | null;
  daysOld: number | null;
  isSubjectDuplicate: boolean;
}

export interface ComparablesSummary {
  compCount: number;
  medianCompPrice: number | null;
  minDistanceMiles: number | null;
  maxDistanceMiles: number | null;
  meanCorrelation: number | null;
  /** True when the active subject listing itself appears in RentCast's AVM `comparables[]` */
  subjectIncludedInComps: boolean;
  comparables: ComparableListingRecord[];
}

export interface PriceGapResult {
  /** `100 * (avmPrice - askingPrice) / avmPrice` for valid positive USD inputs, else `null` */
  gapPct: number | null;
  /** `avmPrice - askingPrice` in USD, else `null` */
  gapAmountUsd: number | null;
  rangePosition: PriceGapRangePosition;
  askingPrice: number | null;
  avmPrice: number | null;
  avmLow: number | null;
  avmHigh: number | null;
  isWithinEstimateRange: boolean | null;
  isProvenUndervaluation: false;
  interpretationNote: string;
}

export type ContraryEvidenceSeverity = 'info' | 'caution' | 'warning';

export interface ContraryEvidenceItem {
  code:
    | 'asking_inside_avm_range'
    | 'subject_included_in_comps'
    | 'wide_avm_uncertainty_band'
    | 'few_comparables'
    | 'distant_comparables'
    | 'stale_listing_timestamp'
    | 'non_standard_property_type'
    | 'missing_structural_attributes'
    | 'avm_methodology_limitation';
  severity: ContraryEvidenceSeverity;
  title: string;
  detail: string;
}

export type PropertyDataProvenance = 'rentcast_live' | 'synthetic_demo';

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
  /** Current active listing asking price in USD (`GET /v1/listings/sale` -> `price`) */
  askingPrice: number | null;
  /** ISO-8601 timestamp when RentCast last observed the active listing */
  listingLastSeenAt: string | null;
  /** RentCast AVM point midpoint estimate in USD (`null` until selected) */
  avmPrice: number | null;
  /** RentCast AVM lower confidence bound in USD */
  avmLow: number | null;
  /** RentCast AVM upper confidence bound in USD */
  avmHigh: number | null;
  /** ISO-8601 server timestamp when `/v1/avm/value` was fetched */
  avmFetchedAt: string | null;
  /** Historical closed deed transaction price in USD (never substituted for AVM or asking) */
  lastSalePrice: number | null;
  /** ISO-8601 historical closed deed sale date */
  lastSaleDate: string | null;
  /** Most recent county tax assessor valuation in USD */
  assessedValue: number | null;
  assessedYear?: number | null;
  comparablesSummary: ComparablesSummary | null;
  priceGap: PriceGapResult;
  accessibility: AccessibilityResult | null;
  nearbyEnvironmentalCount: number;
  dataProvenance: PropertyDataProvenance;
}

export interface PropertyDetailRecord extends PropertyListingSummary {
  contraryEvidence: ContraryEvidenceItem[];
}

export interface BudgetSnapshot {
  billingMonth: string;
  globalMonthlyLimit: number;
  initialSpentCalls: number;
  runtimeSpentCalls: number;
  totalSpentCalls: number;
  globalRemaining: number;
  sessionId: string | null;
  sessionListingsUsed: number;
  sessionListingsLimit: number;
  sessionAvmsUsed: number;
  sessionAvmsLimit: number;
  sessionPropertyRecordsUsed: number;
  sessionPropertyRecordsLimit: number;
  sessionExpanded: boolean;
  durabilityMode: BudgetStoreMode;
  quotaExhausted: boolean;
}

// ============================================================================
// HTTP Endpoint Request & Response Contracts (`docs/API-CONTRACTS.md`)
// ============================================================================

export interface RuntimeCapabilities {
  rentcastConfigured: boolean;
  geminiConfigured: boolean;
  mapsBasemapConfigured: boolean;
  placesContextConfigured: boolean;
  syntheticDemoEnabled: boolean;
}

export interface HealthResponse {
  status: 'ok';
  service: string;
  version: string;
  timestamp: string;
  uptimeSeconds: number;
  durabilityMode: BudgetStoreMode;
  capabilities: RuntimeCapabilities;
}

export interface MissingSetupEnvVar {
  envVarName: string;
  feature: string;
  requiredForLiveMode: boolean;
}

export interface PublicRuntimeConfig {
  appTitle: string;
  uiSetupState: 'ready' | 'setup_needed' | 'synthetic_demo';
  capabilities: RuntimeCapabilities;
  missingSetupEnvVars: MissingSetupEnvVar[];
  /** HTTP-referrer-restricted Maps JS browser key, or `null` if unconfigured. Never contains server keys! */
  mapsBrowserKey: string | null;
  defaultPreferences: PreferenceProfile;
  analysisBounds: {
    minAreaRadiusMeters: number;
    maxAreaRadiusMeters: number;
    defaultAreaRadiusMeters: number;
    minCategoryRadiusMeters: number;
    maxCategoryRadiusMeters: number;
    maxListingsPerSearch: number;
  };
  budgetLimits: {
    globalMonthlyLimit: number;
    defaultSessionListingsLimit: number;
    defaultSessionAvmsLimit: number;
    expandedSessionAvmsLimit: number;
    expandedSessionPropertyRecordsLimit: number;
    durabilityMode: BudgetStoreMode;
  };
  attributions: string[];
}

export interface RegionBoundsInput {
  centerLat: number;
  centerLng: number;
  radiusMeters: number;
}

export interface RegionResolveRequest {
  query?: string;
  bounds?: RegionBoundsInput;
  preferredRadiusMeters?: number;
  useSyntheticDemo?: boolean;
  clientRequestSeq?: number;
}

export interface RegionResolveResponse {
  status: RegionResolveStatus;
  candidates: RegionCandidate[];
  selectedArea: AnalysisArea | null;
  message: string;
  clientRequestSeq?: number;
}

export interface EvaluatePointInput {
  id: string;
  lat: number;
  lng: number;
}

export interface GeospatialAnalyzeRequest {
  analysisArea: AnalysisArea;
  preferences: PreferenceProfile;
  gridResolution?: number;
  overlapThreshold?: number;
  evaluatePoints?: EvaluatePointInput[];
  useSyntheticDemo?: boolean;
  clientRequestSeq?: number;
}

export interface EnvironmentalLayerPayload {
  status: 'ok' | 'unknown';
  records: EnvironmentalRecord[];
  disclaimer: string;
}

export interface GeospatialAnalyzeResponse {
  uiState: UiState;
  dataMode: 'live_open_data' | 'synthetic_demo';
  isSyntheticDemo: boolean;
  analysisArea: AnalysisArea;
  influenceFetchRadiusMeters: number;
  centerAccessibility: AccessibilityResult;
  pointEvaluations: Record<string, AccessibilityResult>;
  gridOverlap: BoundedGridOverlapResult;
  amenities: FacilityRecord[];
  environmentalLayer: EnvironmentalLayerPayload;
  displayOnlyPlacesContext: DisplayOnlyPlaceRecord[];
  sourceAttributions: string[];
  nonClaims: string[];
  fetchedAt: string;
  clientRequestSeq?: number;
}

export interface PropertySearchRequest {
  sessionId?: string;
  analysisArea: AnalysisArea;
  limit?: number;
  propertyType?: ResidentialPropertyType;
  preferences?: PreferenceProfile;
  useSyntheticDemo?: boolean;
  clientRequestSeq?: number;
}

export interface PropertySearchResponse {
  sessionId: string;
  uiState: UiState;
  isSyntheticDemo: boolean;
  fromCache: boolean;
  listings: PropertyListingSummary[];
  budget: BudgetSnapshot;
  fetchedAt: string;
  clientRequestSeq?: number;
}

export interface PropertySubjectSnapshotInput {
  formattedAddress: string;
  city?: string | null;
  state?: string | null;
  zipCode?: string | null;
  latitude: number;
  longitude: number;
  propertyType?: string;
  bedrooms?: number | null;
  bathrooms?: number | null;
  squareFootage?: number | null;
  lotSize?: number | null;
  yearBuilt?: number | null;
  askingPrice?: number | null;
  listingLastSeenAt?: string | null;
}

export interface PropertyAvmRequest {
  sessionId: string;
  propertySnapshot?: PropertySubjectSnapshotInput;
  includeRecentSalesRecord?: boolean;
  useSyntheticDemo?: boolean;
  clientRequestSeq?: number;
}

export interface PropertyAvmResponse {
  sessionId: string;
  uiState: UiState;
  isSyntheticDemo: boolean;
  fromCache: boolean;
  property: PropertyDetailRecord;
  budget: BudgetSnapshot;
  disclaimers: string[];
  clientRequestSeq?: number;
}

export interface SessionExpandRequest {
  userConfirmed: true;
  clientRequestSeq?: number;
}

export interface SessionExpandResponse {
  sessionId: string;
  expanded: boolean;
  budget: BudgetSnapshot;
  message: string;
  clientRequestSeq?: number;
}

export interface ExplainEvidenceItem {
  evidenceId: string;
  /** Eligible source identifier (`rentcast` or eligible `SourceId` — never `google_places_context`) */
  sourceId: Exclude<SourceId, 'google_places_context'> | 'rentcast';
  label: string;
  detail: string;
}

export interface ExplainDataAsOf {
  listingLastSeenAt: string | null;
  avmFetchedAt: string | null;
  geospatialFetchedAt: string | null;
}

export interface ExplainRequest {
  sessionId: string;
  propertyId: string;
  preferences: PreferenceProfile;
  propertyContext?: PropertyDetailRecord;
  accessibilityContext?: AccessibilityResult;
  environmentalRecords?: EnvironmentalRecord[];
  useSyntheticDemo?: boolean;
  clientRequestSeq?: number;
}

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

export interface ApiErrorDetail {
  code: ApiErrorCode;
  message: string;
  uiState?: UiState;
  retryable: boolean;
  missingEnvVarNames?: string[];
  details?: Record<string, unknown>;
}

export interface ApiErrorResponse {
  error: ApiErrorDetail;
  budget?: BudgetSnapshot | null;
  clientRequestSeq?: number;
}
