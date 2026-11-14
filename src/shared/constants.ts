/**
 * Canonical Shared Constants (`src/shared/constants.ts`)
 *
 * Single source of truth for category defaults, spatial bounds, RentCast budget caps,
 * UI states, source IDs, and mandatory product guardrails shared by server and client.
 */

export const APP_NAME = 'Foreal-Estate' as const;
export const APP_SERVICE_ID = 'foreal-estate' as const;
export const APP_VERSION = '0.1.0' as const;

export const DEFAULT_HOST = '0.0.0.0' as const;
export const DEFAULT_PORT = 8080 as const;

export const ALL_SOURCE_IDS = [
  'osm_overpass',
  'osm_extract',
  'epa_frs',
  'synthetic_demo',
  'google_places_context',
] as const;

export const AMENITY_CATEGORIES = [
  'grocery',
  'parks',
  'transit',
  'healthcare',
  'schools',
  'fast_food',
] as const;

export const DEFAULT_PREFERENCE_WEIGHTS = Object.freeze({
  grocery: 25,
  parks: 20,
  transit: 20,
  healthcare: 15,
  schools: 20,
  /** Optional commercial/fast-food context MUST default to 0 weight and never claim causal appreciation */
  fast_food: 0,
} as const);

export const DEFAULT_PREFERENCE_RADII_METERS = Object.freeze({
  grocery: 1600,
  parks: 1200,
  transit: 1000,
  healthcare: 2400,
  schools: 1600,
  fast_food: 1200,
} as const);

export const DEFAULT_PREFERENCE_CAPS = Object.freeze({
  grocery: 2.0,
  parks: 2.5,
  transit: 3.0,
  healthcare: 2.0,
  schools: 2.0,
  fast_food: 3.0,
} as const);

export const AMENITY_CATEGORY_METADATA = Object.freeze({
  grocery: Object.freeze({
    category: 'grocery',
    label: 'Grocery & Supermarkets',
    shortLabel: 'Grocery',
    defaultWeight: DEFAULT_PREFERENCE_WEIGHTS.grocery,
    defaultRadiusMeters: DEFAULT_PREFERENCE_RADII_METERS.grocery,
    defaultCap: DEFAULT_PREFERENCE_CAPS.grocery,
    isOptionalCommercialContext: false,
  }),
  parks: Object.freeze({
    category: 'parks',
    label: 'Parks & Green Space',
    shortLabel: 'Parks',
    defaultWeight: DEFAULT_PREFERENCE_WEIGHTS.parks,
    defaultRadiusMeters: DEFAULT_PREFERENCE_RADII_METERS.parks,
    defaultCap: DEFAULT_PREFERENCE_CAPS.parks,
    isOptionalCommercialContext: false,
  }),
  transit: Object.freeze({
    category: 'transit',
    label: 'Public Transit Stops & Stations',
    shortLabel: 'Transit',
    defaultWeight: DEFAULT_PREFERENCE_WEIGHTS.transit,
    defaultRadiusMeters: DEFAULT_PREFERENCE_RADII_METERS.transit,
    defaultCap: DEFAULT_PREFERENCE_CAPS.transit,
    isOptionalCommercialContext: false,
  }),
  healthcare: Object.freeze({
    category: 'healthcare',
    label: 'Healthcare, Clinics & Pharmacies',
    shortLabel: 'Healthcare',
    defaultWeight: DEFAULT_PREFERENCE_WEIGHTS.healthcare,
    defaultRadiusMeters: DEFAULT_PREFERENCE_RADII_METERS.healthcare,
    defaultCap: DEFAULT_PREFERENCE_CAPS.healthcare,
    isOptionalCommercialContext: false,
  }),
  schools: Object.freeze({
    category: 'schools',
    label: 'Schools & Public Libraries',
    shortLabel: 'Schools & Libraries',
    defaultWeight: DEFAULT_PREFERENCE_WEIGHTS.schools,
    defaultRadiusMeters: DEFAULT_PREFERENCE_RADII_METERS.schools,
    defaultCap: DEFAULT_PREFERENCE_CAPS.schools,
    isOptionalCommercialContext: false,
  }),
  fast_food: Object.freeze({
    category: 'fast_food',
    label: 'Commercial / Fast-Food Context (Optional)',
    shortLabel: 'Commercial (Opt-In)',
    defaultWeight: DEFAULT_PREFERENCE_WEIGHTS.fast_food,
    defaultRadiusMeters: DEFAULT_PREFERENCE_RADII_METERS.fast_food,
    defaultCap: DEFAULT_PREFERENCE_CAPS.fast_food,
    isOptionalCommercialContext: true,
    nonCausalNotice:
      'Optional commercial/fast-food density defaults to 0 weight and expresses user convenience preference only; never interpreted as causing home price appreciation.',
  }),
} as const);

export const ANALYSIS_BOUNDS = Object.freeze({
  minAreaRadiusMeters: 400,
  maxAreaRadiusMeters: 5000,
  defaultAreaRadiusMeters: 1600,
  minCategoryRadiusMeters: 200,
  maxCategoryRadiusMeters: 4000,
  maxCategoryWeight: 100,
  maxListingsPerSearch: 25,
  minGridResolution: 4,
  maxGridResolution: 20,
  defaultGridResolution: 11,
  defaultOverlapThreshold: 0.25,
  maxEvaluatePoints: 30,
} as const);

export const RENTCAST_BUDGET_DEFAULTS = Object.freeze({
  accountMonthlyFreeTier: 50,
  maxConfigurableMonthlyLimit: 49,
  defaultGlobalMonthlyLimit: 35,
  defaultInitialSpentCalls: 0,
  defaultSessionListingsLimit: 1,
  defaultSessionAvmsLimit: 5,
  expandedSessionAvmsLimit: 10,
  defaultSessionPropertyRecordsLimit: 0,
  expandedSessionPropertyRecordsLimit: 1,
} as const);

export const UI_STATES = [
  'ready',
  'setup_needed',
  'loading',
  'empty',
  'partial',
  'unsupported_area',
  'quota_exhausted',
  'timeout',
  'recovery',
  'synthetic_demo',
] as const;

export const PRICE_GAP_RANGE_POSITIONS = [
  'in_range',
  'below_estimate_range_candidate',
  'above_estimate_range_candidate',
  'range_unknown',
  'no_avm',
] as const;

export const ACCESSIBILITY_COMPLETENESS_VALUES = [
  'complete',
  'partial',
  'unknown',
] as const;

export const BUDGET_STORE_MODES = ['firestore', 'sqlite', 'memory'] as const;

export const API_ERROR_CODES = [
  'VALIDATION_ERROR',
  'SOURCE_POLICY_VIOLATION',
  'UNSUPPORTED_AREA',
  'SETUP_NEEDED',
  'SESSION_EXPIRED',
  'SESSION_CAP_REACHED',
  'GLOBAL_QUOTA_EXHAUSTED',
  'BUDGET_STORE_UNAVAILABLE',
  'RATE_LIMITED',
  'UPSTREAM_TIMEOUT',
  'PROVIDER_ERROR',
  'NOT_FOUND',
  'INTERNAL_ERROR',
] as const;

/**
 * Multi-city US example suggestions for the search input placeholder/quick-chips.
 * Never locks or hardcodes the application to Berkeley, CA.
 */
export const EXAMPLE_US_LOCATIONS = Object.freeze([
  'Austin, TX',
  'Seattle, WA',
  'Denver, CO',
  'Chicago, IL',
  'Cambridge, MA',
  'Atlanta, GA',
] as const);

export const VIEWPORT_APPROXIMATION_DISCLAIMER =
  'Circular geodesic viewport approximation — not an official municipal, school, or neighborhood boundary polygon.' as const;

export const ENVIRONMENTAL_LAYER_DISCLAIMER =
  'Documented US EPA Facility Registry Service (FRS) permit/program records are surfaced strictly as a separate user-controlled due-diligence layer, never an automatic environmental hazard or health determination.' as const;

export const MANDATORY_NON_CLAIMS = Object.freeze([
  'RentCast AVM values are comparable-listing statistical estimates, not closed-sale truth or physical appraisals.',
  'An asking price below the AVM midpoint or range is a candidate signal for human due diligence, never proven undervaluation.',
  'Accessibility weights and geodesic radii reflect uncalibrated user convenience preferences, never market dollar premiums, and never multiply AVM estimates.',
  'Straight-line WGS84 geodesic circles are not walking-time or transit-network isochrones.',
  'Optional commercial/fast-food context defaults to 0 weight and makes no causal appreciation claims.',
  'No demographic, resident, tenant, borrower, or protected-group scoring is performed.',
] as const);

export const DEFAULT_SOURCE_ATTRIBUTIONS = Object.freeze([
  '© OpenStreetMap contributors (ODbL)',
  'US EPA Facility Registry Service (FRS) / Envirofacts (Public Domain)',
  'US Census Geocoder (Public Domain)',
  'Property listings & AVM estimates via RentCast API',
] as const);
