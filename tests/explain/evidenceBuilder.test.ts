import { describe, expect, it } from 'vitest';
import { buildEvidenceCatalog } from '../../src/server/explain/evidenceBuilder';
import type {
  AccessibilityResult,
  EnvironmentalRecord,
  PropertyDetailRecord,
} from '../../src/shared/types';

describe('explain/evidenceBuilder', () => {
  const mockProperty: PropertyDetailRecord = {
    id: 'prop_seattle_01',
    dataProvenance: 'rentcast_live',
    formattedAddress: '1234 NW Market St, Seattle, WA 98107',
    city: 'Seattle',
    state: 'WA',
    zipCode: '98107',
    latitude: 47.6687,
    longitude: -122.3831,
    propertyType: 'Single Family',
    bedrooms: 3,
    bathrooms: 2,
    squareFootage: 1850,
    lotSize: 5000,
    yearBuilt: 1952,
    askingPrice: 900000,
    listingLastSeenAt: '2026-11-12T18:00:00.000Z',
    avmPrice: 1000000,
    avmLow: 850000,
    avmHigh: 1150000,
    avmFetchedAt: '2026-11-14T07:43:10.000Z',
    lastSalePrice: 650000,
    lastSaleDate: '2019-05-15',
    assessedValue: 820000,
    assessedYear: 2025,
    comparablesSummary: {
      compCount: 8,
      medianCompPrice: 980000,
      minDistanceMiles: 0.2,
      maxDistanceMiles: 0.9,
      meanCorrelation: 0.88,
      subjectIncludedInComps: false,
      comparables: [],
    },
    priceGap: {
      gapPct: 10.0,
      gapAmountUsd: 100000,
      rangePosition: 'in_range',
      askingPrice: 900000,
      avmPrice: 1000000,
      avmLow: 850000,
      avmHigh: 1150000,
      isWithinEstimateRange: true,
      isProvenUndervaluation: false,
      interpretationNote: 'Asking price is inside the statistical AVM estimate range.',
    },
    accessibility: null,
    nearbyEnvironmentalCount: 1,
    contraryEvidence: [
      {
        code: 'asking_inside_avm_range',
        severity: 'info',
        title: 'Asking Price Inside AVM Confidence Range',
        detail: 'Asking $900,000 sits within [$850,000, $1,150,000].',
      },
    ],
  };

  const mockAccessibility: AccessibilityResult = {
    score: 82.4,
    completeness: 'complete',
    missingOrFailedCategories: [],
    failedWeightedCategories: [],
    categoryBreakdown: {},
    categories: [
      {
        category: 'grocery',
        label: 'Grocery',
        weight: 25,
        radiusMeters: 1200,
        cap: 3,
        status: 'ok',
        facilityCount: 4,
        rawKernelSum: 2.76,
        intensity: 0.92,
        effectiveIntensity: 0.92,
        weightedContribution: 23,
        nearestDistanceMeters: 250,
        topFacilities: [],
      },
    ],
    totalWeight: 25,
    knownWeight: 25,
    knownWeightFraction: 1.0,
    deduplicatedFacilityCount: 4,
    duplicatesMergedCount: 0,
    rejectedFacilityCount: 0,
    rejectedCountBySource: {},
  };

  it('builds a complete evidence catalog with valuation, accessibility, and contrary items', () => {
    const result = buildEvidenceCatalog({
      property: mockProperty,
      accessibility: mockAccessibility,
      environmentalRecords: [],
      isSyntheticDemo: false,
    });

    expect(result.evidenceCatalog.length).toBeGreaterThanOrEqual(4);
    const ids = result.evidenceCatalog.map((e) => e.evidenceId);
    expect(ids).toContain('ev_prop_pricing');
    expect(ids).toContain('ev_prop_range');
    expect(ids).toContain('ev_acc_overall');
    expect(ids).toContain('ev_cat_grocery');
    expect(ids).toContain('ev_contrary_asking_inside_avm_range');

    // Allowed numbers should record all key valuation and spatial metrics
    expect(result.facts.allowedNumbers.has(900000)).toBe(true);
    expect(result.facts.allowedNumbers.has(1000000)).toBe(true);
    expect(result.facts.allowedNumbers.has(10)).toBe(true);
    expect(result.facts.allowedNumbers.has(82.4)).toBe(true);
  });

  it('unconditionally bars google_places_context from evidence catalog entry', () => {
    const poisonedEnvRecords: EnvironmentalRecord[] = [
      {
        id: 'env_legit_1',
        registryId: '110001',
        sourceId: 'epa_frs',
        name: 'Legit FRS Facility',
        lat: 47.669,
        lng: -122.383,
        distanceMeters: 450,
        programs: ['RCRA'],
        status: 'Active',
        dueDiligenceNotice: 'Notice',
        isAutomaticHealthDetermination: false,
      },
      {
        id: 'places_poison_1',
        registryId: 'PLACES_999',
        sourceId: 'google_places_context' as any,
        name: 'Poisoned Google Places Amenity',
        lat: 47.67,
        lng: -122.38,
        distanceMeters: 100,
        programs: [],
        status: 'Active',
        dueDiligenceNotice: 'Notice',
        isAutomaticHealthDetermination: false,
      },
    ];

    const result = buildEvidenceCatalog({
      property: mockProperty,
      accessibility: mockAccessibility,
      environmentalRecords: poisonedEnvRecords,
      isSyntheticDemo: false,
    });

    // Check evidence IDs and details
    for (const item of result.evidenceCatalog) {
      expect(item.sourceId).not.toBe('google_places_context');
      expect(item.evidenceId).not.toContain('places_poison');
      expect(item.detail).not.toContain('Poisoned Google Places');
    }

    // Legit EPA record should be present
    expect(result.evidenceCatalog.some((e) => e.evidenceId === 'ev_env_env_legit_1')).toBe(true);
  });

  it('correctly maps synthetic_demo source when demo mode is active', () => {
    const result = buildEvidenceCatalog({
      property: mockProperty,
      accessibility: mockAccessibility,
      environmentalRecords: [],
      isSyntheticDemo: true,
    });

    const pricingItem = result.evidenceCatalog.find((e) => e.evidenceId === 'ev_prop_pricing');
    expect(pricingItem?.sourceId).toBe('synthetic_demo');
  });

  it('whitelists server-computed AVM spread percentage and contraryEvidence figures in allowedNumbers', () => {
    const austinCondo: PropertyDetailRecord = {
      ...mockProperty,
      id: 'prop_austin_48_east_ave_2002',
      formattedAddress: '48 East Ave, Unit 2002, Austin, TX 78701',
      city: 'Austin',
      state: 'TX',
      zipCode: '78701',
      askingPrice: 505000,
      avmPrice: 401000,
      avmLow: 321000,
      avmHigh: 481000,
      priceGap: {
        gapPct: -25.93516209476309,
        gapAmountUsd: -104000,
        rangePosition: 'above_estimate_range_candidate',
        askingPrice: 505000,
        avmPrice: 401000,
        avmLow: 321000,
        avmHigh: 481000,
        isWithinEstimateRange: false,
        isProvenUndervaluation: false,
        interpretationNote: 'Asking price exceeds the upper AVM confidence bound.',
      },
      contraryEvidence: [
        {
          code: 'wide_avm_uncertainty_band',
          severity: 'caution',
          title: 'Wide Valuation Uncertainty Band (40% Spread)',
          detail:
            'The AVM confidence range spans $321,000 to $481,000 (40% of midpoint), indicating high local price heterogeneity.',
        },
      ],
    };

    const result = buildEvidenceCatalog({
      property: austinCondo,
      accessibility: null,
      environmentalRecords: [],
      isSyntheticDemo: false,
    });

    expect(
      result.evidenceCatalog.some((e) => e.evidenceId === 'ev_contrary_wide_avm_uncertainty_band')
    ).toBe(true);
    expect(result.facts.allowedNumbers.has(40)).toBe(true);
    expect(result.facts.allowedNumbers.has(39.9)).toBe(true);
    expect(result.facts.allowedNumbers.has(160000)).toBe(true);
  });
});
