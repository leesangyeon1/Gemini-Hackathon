import {
  DEFAULT_PREFERENCE_RADII_METERS,
  DEFAULT_PREFERENCE_WEIGHTS,
  DEFAULT_SOURCE_ATTRIBUTIONS,
  ENVIRONMENTAL_LAYER_DISCLAIMER,
  MANDATORY_NON_CLAIMS,
  VIEWPORT_APPROXIMATION_DISCLAIMER,
} from '../../src/shared/constants';
import type {
  AnalysisArea,
  BudgetSnapshot,
  ExplainResponse,
  GeospatialAnalyzeResponse,
  PropertyAvmResponse,
  PropertyDetailRecord,
  PropertyListingSummary,
  PropertySearchResponse,
  PublicRuntimeConfig,
  RegionCandidate,
  RegionResolveResponse,
  SessionExpandResponse,
} from '../../src/shared/types';

export function makeSetupNeededConfig(
  overrides: Partial<PublicRuntimeConfig> = {}
): PublicRuntimeConfig {
  return {
    appTitle: 'Foreal-Estate',
    uiSetupState: 'setup_needed',
    capabilities: {
      rentcastConfigured: false,
      geminiConfigured: true,
      mapsBasemapConfigured: false,
      placesContextConfigured: false,
      syntheticDemoEnabled: true,
    },
    missingSetupEnvVars: [
      {
        envVarName: 'RENTCAST_API_KEY',
        feature: 'Live US Property Listings & On-Demand AVM',
        requiredForLiveMode: true,
      },
      {
        envVarName: 'GOOGLE_MAPS_BROWSER_KEY',
        feature: 'Interactive Google Maps JS Basemap',
        requiredForLiveMode: false,
      },
    ],
    mapsBrowserKey: null,
    defaultPreferences: {
      weights: { ...DEFAULT_PREFERENCE_WEIGHTS },
      radiiMeters: { ...DEFAULT_PREFERENCE_RADII_METERS },
      includeEnvironmentalDueDiligenceLayer: true,
      optionalExternalityPenaltyWeight: 0,
    },
    analysisBounds: {
      minAreaRadiusMeters: 400,
      maxAreaRadiusMeters: 5000,
      defaultAreaRadiusMeters: 1600,
      minCategoryRadiusMeters: 200,
      maxCategoryRadiusMeters: 4000,
      maxListingsPerSearch: 25,
    },
    budgetLimits: {
      globalMonthlyLimit: 35,
      defaultSessionListingsLimit: 1,
      defaultSessionAvmsLimit: 5,
      expandedSessionAvmsLimit: 10,
      expandedSessionPropertyRecordsLimit: 1,
      durabilityMode: 'sqlite',
    },
    attributions: [...DEFAULT_SOURCE_ATTRIBUTIONS],
    ...overrides,
  };
}

export const AUSTIN_AREA: AnalysisArea = {
  areaId: 'us-tx-austin-78704',
  label: 'Austin, TX (78704)',
  centerLat: 30.2458,
  centerLng: -97.7689,
  radiusMeters: 1600,
  boundingBox: {
    minLat: 30.2314,
    maxLat: 30.2602,
    minLng: -97.7855,
    maxLng: -97.7523,
  },
  city: 'Austin',
  state: 'TX',
  zipCode: '78704',
  isUsLocation: true,
  isViewportApproximation: true,
  approximationDisclaimer: VIEWPORT_APPROXIMATION_DISCLAIMER,
};

export const SEATTLE_AREA: AnalysisArea = {
  areaId: 'us-wa-seattle-ballard',
  label: 'Ballard, Seattle, WA',
  centerLat: 47.6687,
  centerLng: -122.3845,
  radiusMeters: 1600,
  boundingBox: {
    minLat: 47.6543,
    maxLat: 47.6831,
    minLng: -122.4058,
    maxLng: -122.3632,
  },
  city: 'Seattle',
  state: 'WA',
  zipCode: '98107',
  isUsLocation: true,
  isViewportApproximation: true,
  approximationDisclaimer: VIEWPORT_APPROXIMATION_DISCLAIMER,
};

export const SPRINGFIELD_CANDIDATES: RegionCandidate[] = [
  {
    candidateId: 'us-il-springfield',
    displayName: 'Springfield, Sangamon County, IL, USA',
    city: 'Springfield',
    state: 'IL',
    zipCode: null,
    centerLat: 39.7817,
    centerLng: -89.6501,
    suggestedRadiusMeters: 1600,
    boundingBox: { minLat: 39.767, maxLat: 39.796, minLng: -89.669, maxLng: -89.631 },
    placeKind: 'city',
    isUsLocation: true,
    isViewportApproximation: true,
    source: 'osm_nominatim',
  },
  {
    candidateId: 'us-mo-springfield',
    displayName: 'Springfield, Greene County, MO, USA',
    city: 'Springfield',
    state: 'MO',
    zipCode: null,
    centerLat: 37.209,
    centerLng: -93.2923,
    suggestedRadiusMeters: 1600,
    boundingBox: { minLat: 37.194, maxLat: 37.224, minLng: -93.31, maxLng: -93.274 },
    placeKind: 'city',
    isUsLocation: true,
    isViewportApproximation: true,
    source: 'osm_nominatim',
  },
];

export function makeBudget(overrides: Partial<BudgetSnapshot> = {}): BudgetSnapshot {
  return {
    billingMonth: '2026-11',
    globalMonthlyLimit: 35,
    initialSpentCalls: 0,
    runtimeSpentCalls: 1,
    totalSpentCalls: 1,
    globalRemaining: 34,
    sessionId: 'sess_austin_001',
    sessionListingsUsed: 1,
    sessionListingsLimit: 1,
    sessionAvmsUsed: 0,
    sessionAvmsLimit: 5,
    sessionPropertyRecordsUsed: 0,
    sessionPropertyRecordsLimit: 1,
    sessionExpanded: false,
    durabilityMode: 'sqlite',
    quotaExhausted: false,
    ...overrides,
  };
}

export function makeAustinListing(
  overrides: Partial<PropertyListingSummary> = {}
): PropertyListingSummary {
  return {
    id: 'prop-austin-1',
    formattedAddress: '1804 S Congress Ave, Austin, TX 78704',
    city: 'Austin',
    state: 'TX',
    zipCode: '78704',
    latitude: 30.2462,
    longitude: -97.7501,
    propertyType: 'Single Family',
    bedrooms: 3,
    bathrooms: 2,
    squareFootage: 1850,
    lotSize: 6200,
    yearBuilt: 1998,
    askingPrice: 900000,
    listingLastSeenAt: '2026-11-12T18:00:00.000Z',
    avmPrice: null,
    avmLow: null,
    avmHigh: null,
    avmFetchedAt: null,
    lastSalePrice: 540000,
    lastSaleDate: '2018-06-15T00:00:00.000Z',
    assessedValue: 760000,
    assessedYear: 2025,
    comparablesSummary: null,
    priceGap: {
      gapPct: null,
      gapAmountUsd: null,
      rangePosition: 'no_avm',
      askingPrice: 900000,
      avmPrice: null,
      avmLow: null,
      avmHigh: null,
      isWithinEstimateRange: null,
      isProvenUndervaluation: false,
      interpretationNote: 'AVM not fetched yet.',
    },
    accessibility: {
      score: 78.5,
      completeness: 'partial',
      missingOrFailedCategories: ['transit'],
      failedWeightedCategories: ['transit'],
      categoryBreakdown: {
        grocery: {
          category: 'grocery',
          label: 'Grocery & Supermarkets',
          weight: 25,
          radiusMeters: 1600,
          cap: 2,
          status: 'ok',
          facilityCount: 3,
          rawKernelSum: 1.9,
          intensity: 0.95,
          effectiveIntensity: 0.95,
          weightedContribution: 23.75,
          nearestDistanceMeters: 310,
          topFacilities: [],
        },
        transit: {
          category: 'transit',
          label: 'Public Transit Stops & Stations',
          weight: 20,
          radiusMeters: 1000,
          cap: 3,
          status: 'unknown',
          facilityCount: 0,
          rawKernelSum: 0,
          intensity: null,
          effectiveIntensity: 0,
          weightedContribution: 0,
          nearestDistanceMeters: null,
          topFacilities: [],
        },
      },
      categories: [
        {
          category: 'grocery',
          label: 'Grocery & Supermarkets',
          weight: 25,
          radiusMeters: 1600,
          cap: 2,
          status: 'ok',
          facilityCount: 3,
          rawKernelSum: 1.9,
          intensity: 0.95,
          effectiveIntensity: 0.95,
          weightedContribution: 23.75,
          nearestDistanceMeters: 310,
          topFacilities: [],
        },
        {
          category: 'transit',
          label: 'Public Transit Stops & Stations',
          weight: 20,
          radiusMeters: 1000,
          cap: 3,
          status: 'unknown',
          facilityCount: 0,
          rawKernelSum: 0,
          intensity: null,
          effectiveIntensity: 0,
          weightedContribution: 0,
          nearestDistanceMeters: null,
          topFacilities: [],
        },
      ],
      totalWeight: 100,
      knownWeight: 80,
      knownWeightFraction: 0.8,
      deduplicatedFacilityCount: 12,
      duplicatesMergedCount: 2,
      rejectedFacilityCount: 0,
      rejectedCountBySource: {},
    },
    nearbyEnvironmentalCount: 1,
    dataProvenance: 'synthetic_demo',
    ...overrides,
  };
}

export function makeAustinGeospatialResponse(
  area: AnalysisArea = AUSTIN_AREA,
  isDemo = true
): GeospatialAnalyzeResponse {
  const listing = makeAustinListing();
  return {
    uiState: 'partial',
    dataMode: isDemo ? 'synthetic_demo' : 'live_open_data',
    isSyntheticDemo: isDemo,
    analysisArea: area,
    influenceFetchRadiusMeters: 4000,
    centerAccessibility: listing.accessibility!,
    pointEvaluations: {
      [listing.id]: listing.accessibility!,
    },
    gridOverlap: {
      center: { lat: area.centerLat, lng: area.centerLng },
      radiusMeters: area.radiusMeters,
      gridResolution: 11,
      overlapThreshold: 0.25,
      activeCategories: ['grocery', 'parks', 'transit', 'healthcare', 'schools'],
      maxOverlapCount: 4,
      cells: [
        {
          cellId: 'cell-5-5',
          row: 5,
          col: 5,
          lat: area.centerLat,
          lng: area.centerLng,
          distanceFromCenterMeters: 0,
          accessibilityScore: 78.5,
          completeness: 'partial',
          categoryIntensities: { grocery: 0.95, transit: null },
          presentCategories: ['grocery', 'parks', 'healthcare', 'schools'],
          overlapCount: 4,
          minActiveIntensity: 0.4,
        },
      ],
      sweetSpotCells: [
        {
          cellId: 'cell-5-5',
          row: 5,
          col: 5,
          lat: area.centerLat,
          lng: area.centerLng,
          distanceFromCenterMeters: 0,
          accessibilityScore: 78.5,
          completeness: 'partial',
          categoryIntensities: { grocery: 0.95, transit: null },
          presentCategories: ['grocery', 'parks', 'healthcare', 'schools'],
          overlapCount: 4,
          minActiveIntensity: 0.4,
        },
      ],
    },
    amenities: [
      {
        id: 'osm-groc-1',
        sourceId: isDemo ? 'synthetic_demo' : 'osm_overpass',
        analysisEligible: true,
        category: 'grocery',
        name: 'South Congress Market',
        lat: area.centerLat + 0.002,
        lng: area.centerLng + 0.002,
        attribution: '© OpenStreetMap contributors (ODbL)',
      },
    ],
    environmentalLayer: {
      status: 'ok',
      records: [
        {
          id: 'epa-tx-1',
          registryId: '110000123456',
          sourceId: 'epa_frs',
          name: 'South Austin Fleet Maintenance Facility',
          lat: area.centerLat - 0.003,
          lng: area.centerLng + 0.002,
          distanceMeters: 410,
          programs: ['RCRAINFO'],
          status: 'ACTIVE',
          dueDiligenceNotice: ENVIRONMENTAL_LAYER_DISCLAIMER,
          isAutomaticHealthDetermination: false,
        },
      ],
      disclaimer: ENVIRONMENTAL_LAYER_DISCLAIMER,
    },
    displayOnlyPlacesContext: [
      {
        placeId: 'gp-1',
        sourceId: 'google_places_context',
        analysisEligible: false,
        name: 'Display-Only Coffee Shop',
        lat: area.centerLat + 0.001,
        lng: area.centerLng - 0.001,
        attribution: 'Google Places (Display Only)',
      },
    ],
    sourceAttributions: [...DEFAULT_SOURCE_ATTRIBUTIONS],
    nonClaims: [...MANDATORY_NON_CLAIMS],
    fetchedAt: '2026-11-14T07:45:00.000Z',
  };
}

export function makeAustinSearchResponse(
  area: AnalysisArea = AUSTIN_AREA,
  isDemo = true
): PropertySearchResponse {
  return {
    sessionId: 'sess_austin_001',
    uiState: isDemo ? 'synthetic_demo' : 'ready',
    isSyntheticDemo: isDemo,
    fromCache: false,
    listings: [
      makeAustinListing({
        dataProvenance: isDemo ? 'synthetic_demo' : 'rentcast_live',
      }),
    ],
    budget: makeBudget(),
    fetchedAt: '2026-11-14T07:45:02.000Z',
  };
}

export function makeAustinAvmResponse(): PropertyAvmResponse {
  const base = makeAustinListing();
  const detail: PropertyDetailRecord = {
    ...base,
    avmPrice: 1000000,
    avmLow: 850000,
    avmHigh: 1150000,
    avmFetchedAt: '2026-11-14T07:46:00.000Z',
    comparablesSummary: {
      compCount: 5,
      medianCompPrice: 985000,
      minDistanceMiles: 0.15,
      maxDistanceMiles: 0.85,
      meanCorrelation: 0.88,
      subjectIncludedInComps: true,
      comparables: [],
    },
    priceGap: {
      gapPct: 10,
      gapAmountUsd: 100000,
      rangePosition: 'in_range',
      askingPrice: 900000,
      avmPrice: 1000000,
      avmLow: 850000,
      avmHigh: 1150000,
      isWithinEstimateRange: true,
      isProvenUndervaluation: false,
      interpretationNote:
        'Asking ($900,000) is +10.0% below AVM midpoint ($1,000,000) but remains inside [$850,000, $1,150,000].',
    },
    contraryEvidence: [
      {
        code: 'asking_inside_avm_range',
        severity: 'caution',
        title: 'Inside AVM Confidence Interval',
        detail: '$900,000 sits within [$850,000, $1,150,000].',
      },
      {
        code: 'subject_included_in_comps',
        severity: 'warning',
        title: 'Subject Listing Appears in Comparables',
        detail: 'The active listing is duplicated in RentCast comparables.',
      },
    ],
  };

  return {
    sessionId: 'sess_austin_001',
    uiState: 'synthetic_demo',
    isSyntheticDemo: true,
    fromCache: false,
    property: detail,
    budget: makeBudget({ sessionAvmsUsed: 1, runtimeSpentCalls: 2, globalRemaining: 33 }),
    disclaimers: [
      'RentCast AVM is a comparable-listing statistical estimate, not a physical appraisal.',
    ],
  };
}

export function makeExplainResponse(available = true): ExplainResponse {
  return {
    explanationAvailable: available,
    fallbackUsed: !available,
    unavailableReason: available ? null : 'GEMINI_API_KEY is not configured on the server.',
    modelUsed: available ? 'gemini-4-hydrogen' : null,
    isSyntheticDemo: true,
    summary:
      '1804 S Congress Ave is listed at $900,000 (+10.0% below the $1,000,000 AVM midpoint), yet remains inside the $850,000–$1,150,000 estimate range.',
    evidenceIds: ['ev_prop_pricing', 'ev_cat_grocery'],
    evidenceCatalog: [
      {
        evidenceId: 'ev_prop_pricing',
        sourceId: 'rentcast',
        label: 'Asking vs. AVM Midpoint',
        detail: 'Asking $900,000 vs AVM $1,000,000 (+10.0%, in_range)',
      },
      {
        evidenceId: 'ev_cat_grocery',
        sourceId: 'synthetic_demo',
        label: 'Grocery Proximity Intensity',
        detail: '3 grocery facilities within 1,600 m (intensity 0.95)',
      },
    ],
    positiveFactors: ['Strong grocery proximity within 1,600 m straight-line radius.'],
    contraryAndUncertaintyFactors: [
      'Asking price lies inside the AVM range [$850,000, $1,150,000].',
      'Transit category failed/unknown; total weight denominator preserved.',
    ],
    limitations: ['Straight-line WGS84 geodesic circles are not walking-time isochrones.'],
    dataAsOf: {
      listingLastSeenAt: '2026-11-12T18:00:00.000Z',
      avmFetchedAt: '2026-11-14T07:46:00.000Z',
      geospatialFetchedAt: '2026-11-14T07:45:00.000Z',
    },
  };
}

export function makeResolveResponse(
  overrides: Partial<RegionResolveResponse> = {}
): RegionResolveResponse {
  return {
    status: 'resolved',
    candidates: [],
    selectedArea: AUSTIN_AREA,
    message: 'Resolved Austin, TX (78704).',
    ...overrides,
  };
}

export function makeExpandResponse(): SessionExpandResponse {
  return {
    sessionId: 'sess_austin_001',
    expanded: true,
    budget: makeBudget({
      sessionAvmsUsed: 1,
      sessionAvmsLimit: 10,
      sessionExpanded: true,
    }),
    message: 'Session expanded to allow up to 10 on-demand home AVM comparisons.',
  };
}
