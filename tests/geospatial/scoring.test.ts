import { describe, expect, it } from "vitest";
import {
  DEFAULT_CATEGORY_CONFIGS,
  InvalidCoordinateError,
  type ScorableFacilityInput,
  computeAccessibilityScore,
  computeBoundedGridOverlap,
  computeCategorySaturation,
  computeGeodesicDistanceMeters,
  computeInfluenceBufferRadiusMeters,
  computeLinearKernel,
  computeOptionalUserPreferenceComposite,
  computePriceGap,
  deduplicateFacilities,
  evaluateEnvironmentalLayer,
  validateCoordinates,
} from "../../src/server/geospatial/scoring";
import {
  SOURCE_POLICY_REGISTRY,
  SourcePolicyViolationError,
  assertSourceAnalysisEligible,
  enforceSourcePolicyOnRecord,
  isSourceAnalysisEligible,
  partitionFacilitiesBySourcePolicy,
} from "../../src/server/geospatial/sourcePolicy";

describe("Geospatial Source-Policy Registry (`sourcePolicy.ts`)", () => {
  it("enforces analysisEligible=false unconditionally for google_places_context", () => {
    expect(SOURCE_POLICY_REGISTRY.google_places_context.analysisEligible).toBe(false);
    expect(isSourceAnalysisEligible("google_places_context")).toBe(false);
    expect(isSourceAnalysisEligible("google_places_context", { allowSyntheticDemo: true })).toBe(
      false
    );
    expect(() => assertSourceAnalysisEligible("google_places_context")).toThrow(
      SourcePolicyViolationError
    );
  });

  it("strips forged analysisEligible=true on google_places_context records", () => {
    const forgedRecord = {
      id: "forged_gplace_1",
      sourceId: "google_places_context",
      analysisEligible: true,
      category: "grocery",
      name: "Forged Google Place Supermarket",
      lat: 30.2672,
      lng: -97.7431,
    };

    const enforced = enforceSourcePolicyOnRecord(forgedRecord);
    expect(enforced.analysisEligible).toBe(false);

    const partitioned = partitionFacilitiesBySourcePolicy([
      forgedRecord,
      {
        id: "osm_1",
        sourceId: "osm_overpass",
        analysisEligible: true,
        category: "grocery",
        name: "Licensed OSM Grocery",
        lat: 30.2675,
        lng: -97.7435,
      },
    ]);

    expect(partitioned.eligible).toHaveLength(1);
    expect(partitioned.eligible[0].id).toBe("osm_1");
    expect(partitioned.rejected).toHaveLength(1);
    expect(partitioned.rejected[0].id).toBe("forged_gplace_1");
    expect(partitioned.rejectedCountBySource.google_places_context).toBe(1);
  });

  it("blocks synthetic_demo when allowSyntheticDemo is false", () => {
    expect(isSourceAnalysisEligible("synthetic_demo", { allowSyntheticDemo: true })).toBe(true);
    expect(isSourceAnalysisEligible("synthetic_demo", { allowSyntheticDemo: false })).toBe(false);
    expect(isSourceAnalysisEligible("unknown_provider")).toBe(false);
  });
});

describe("Coordinate Validation & WGS84 Geodesic Distance (`scoring.ts`)", () => {
  it("accepts valid finite WGS84 coordinates and rejects NaN, Infinity, and out-of-bounds values", () => {
    expect(validateCoordinates(30.2672, -97.7431)).toEqual({
      lat: 30.2672,
      lng: -97.7431,
    });
    expect(validateCoordinates(-90, 180)).toEqual({ lat: -90, lng: 180 });
    expect(validateCoordinates(90, -180)).toEqual({ lat: 90, lng: -180 });

    expect(() => validateCoordinates(Number.NaN, -97.74)).toThrow(InvalidCoordinateError);
    expect(() => validateCoordinates(30.26, Number.POSITIVE_INFINITY)).toThrow(
      InvalidCoordinateError
    );
    expect(() => validateCoordinates(90.001, -97.74)).toThrow(InvalidCoordinateError);
    expect(() => validateCoordinates(-90.001, -97.74)).toThrow(InvalidCoordinateError);
    expect(() => validateCoordinates(30.26, 180.001)).toThrow(InvalidCoordinateError);
    expect(() => validateCoordinates(30.26, -180.001)).toThrow(InvalidCoordinateError);
  });

  it("computes accurate, symmetric WGS84 geodesic distances in meters", () => {
    const austinCapitol = { lat: 30.2747, lng: -97.7403 };
    expect(computeGeodesicDistanceMeters(austinCapitol, austinCapitol)).toBe(0);

    // 1 degree of latitude along a meridian is ~111,195 meters on WGS84 mean sphere
    const oneDegLatMeters = computeGeodesicDistanceMeters(0, 0, 1, 0);
    expect(oneDegLatMeters).toBeGreaterThan(111_100);
    expect(oneDegLatMeters).toBeLessThan(111_300);

    // Symmetry check
    const seattle = { lat: 47.6062, lng: -122.3321 };
    const bellevue = { lat: 47.6101, lng: -122.2015 };
    const d1 = computeGeodesicDistanceMeters(seattle, bellevue);
    const d2 = computeGeodesicDistanceMeters(bellevue, seattle);
    expect(d1).toBeCloseTo(d2, 9);
    expect(d1).toBeGreaterThan(9_500);
    expect(d1).toBeLessThan(10_200);
  });

  it("computes influence-buffered fetch radius as analysisArea.radiusMeters + max(radius_c)", () => {
    // Default max category radius is healthcare = 2400m
    expect(computeInfluenceBufferRadiusMeters(1600)).toBe(1600 + 2400);
    expect(
      computeInfluenceBufferRadiusMeters(1500, {
        weights: {
          grocery: 50,
          parks: 50,
          transit: 0,
          healthcare: 0,
          schools: 0,
          fast_food: 0,
        },
        radiiMeters: {
          grocery: 1800,
          parks: 1200,
          transit: 1000,
          healthcare: 2400,
          schools: 1600,
          fast_food: 1200,
        },
      })
    ).toBe(1500 + 1800);

    // Single object argument returns the buffer delta itself
    expect(
      computeInfluenceBufferRadiusMeters({
        radiiMeters: { grocery: 2000, parks: 1200 },
      })
    ).toBe(2000);
  });
});

describe("Linear Kernel, Category Saturation & Order-Invariant Deduplication", () => {
  it("evaluates linear distance-decay kernel at d=0, d=0.5*radius, d=radius, and d>radius", () => {
    expect(computeLinearKernel(0, 1000)).toBe(1);
    expect(computeLinearKernel(500, 1000)).toBeCloseTo(0.5, 6);
    expect(computeLinearKernel(1000, 1000)).toBe(0);
    expect(computeLinearKernel(1500, 1000)).toBe(0);

    expect(() => computeLinearKernel(-1, 1000)).toThrow(RangeError);
    expect(() => computeLinearKernel(100, 0)).toThrow(RangeError);
  });

  it("saturates category intensity a_c = min(1, sum_k / cap_c)", () => {
    expect(computeCategorySaturation(0, 2.0)).toBe(0);
    expect(computeCategorySaturation(1.0, 2.0)).toBeCloseTo(0.5, 6);
    expect(computeCategorySaturation(2.0, 2.0)).toBe(1);
    expect(computeCategorySaturation(5.5, 2.0)).toBe(1);
    expect(() => computeCategorySaturation(1.0, 0)).toThrow(RangeError);
  });

  it("produces bit-identical deduplicated facilities and scores across input permutations", () => {
    const evaluationPoint = { lat: 39.7392, lng: -104.9903 }; // Denver, CO
    const baseFacilities: ScorableFacilityInput[] = [
      // Duplicate pair (OSM node + way for same grocery store ~4m apart)
      {
        id: "osm:node:101",
        externalId: "osm:node:101",
        sourceId: "osm_overpass",
        category: "grocery",
        name: "Trader Joe's",
        lat: 39.7401,
        lng: -104.9903,
      },
      {
        id: "osm:way:202",
        externalId: "osm:way:202",
        sourceId: "osm_overpass",
        category: "grocery",
        name: "Trader Joes",
        lat: 39.74013,
        lng: -104.99031,
      },
      // Distinct grocery store at same shopping plaza (different name -> NOT merged)
      {
        id: "osm:node:103",
        externalId: "osm:node:103",
        sourceId: "osm_overpass",
        category: "grocery",
        name: "Natural Grocers",
        lat: 39.7401,
        lng: -104.9903,
      },
      {
        id: "osm:way:301",
        externalId: "osm:way:301",
        sourceId: "osm_overpass",
        category: "parks",
        name: "Civic Center Park",
        lat: 39.7395,
        lng: -104.9885,
      },
      {
        id: "osm:node:401",
        externalId: "osm:node:401",
        sourceId: "osm_overpass",
        category: "transit",
        name: "Union Station Light Rail",
        lat: 39.743,
        lng: -104.992,
      },
      // Forged google_places_context entry that must be rejected
      {
        id: "gplace:999",
        sourceId: "google_places_context",
        analysisEligible: true,
        category: "grocery",
        name: "Google Places Supermarket",
        lat: 39.7392,
        lng: -104.9903,
      },
    ];

    const permutationA = [...baseFacilities];
    const permutationB = [...baseFacilities].reverse();
    const permutationC = [
      baseFacilities[3],
      baseFacilities[1],
      baseFacilities[5],
      baseFacilities[0],
      baseFacilities[4],
      baseFacilities[2],
    ];

    const scoreA = computeAccessibilityScore(evaluationPoint, permutationA);
    const scoreB = computeAccessibilityScore(evaluationPoint, permutationB);
    const scoreC = computeAccessibilityScore(evaluationPoint, permutationC);

    expect(scoreA.score).toBe(scoreB.score);
    expect(scoreB.score).toBe(scoreC.score);
    expect(scoreA.categoryBreakdown).toEqual(scoreB.categoryBreakdown);
    expect(scoreB.categoryBreakdown).toEqual(scoreC.categoryBreakdown);

    // Verify 1 duplicate was merged (Trader Joe's node+way) and 1 google_places_context was rejected
    expect(scoreA.duplicatesMergedCount).toBe(1);
    expect(scoreA.rejectedFacilityCount).toBe(1);
    expect(scoreA.rejectedCountBySource.google_places_context).toBe(1);
    expect(scoreA.categoryBreakdown.grocery.facilityCount).toBe(2); // Trader Joe's + Natural Grocers
  });

  it("includes buffered edge facilities located outside analysisArea.radiusMeters for boundary properties", () => {
    // Area center at (41.8781, -87.6298), analysisArea.radiusMeters = 1000m
    // Property sits near northern boundary (+950m north of center: lat ~ 41.88664)
    // Grocery facility sits +1200m north of center (lat ~ 41.88889): 200m outside analysisArea,
    // but only ~250m from the boundary property!
    const boundaryProperty = { lat: 41.88664, lng: -87.6298 };
    const edgeGroceryFacility: ScorableFacilityInput = {
      id: "osm:edge_grocery",
      sourceId: "osm_overpass",
      category: "grocery",
      name: "Edge Buffer Supermarket",
      lat: 41.88889,
      lng: -87.6298,
    };

    const scoreWithoutBuffer = computeAccessibilityScore(boundaryProperty, []);
    const scoreWithBuffer = computeAccessibilityScore(boundaryProperty, [
      edgeGroceryFacility,
    ]);

    expect(scoreWithoutBuffer.categoryBreakdown.grocery.intensity).toBe(0);
    expect(scoreWithBuffer.categoryBreakdown.grocery.intensity).toBeGreaterThan(0.4);
    expect(scoreWithBuffer.score).toBeGreaterThan(scoreWithoutBuffer.score);
  });
});

describe("Missing / Failed Source Handling vs. Zero Facilities & Preference Weights", () => {
  const point = { lat: 42.3736, lng: -71.1097 }; // Cambridge, MA

  it("distinguishes 0 returned facilities from a healthy source (a_c = 0, complete) vs failed source (unknown, partial, no silent renormalization)", () => {
    const prefs = {
      weights: {
        grocery: 50,
        parks: 50,
        transit: 0,
        healthcare: 0,
        schools: 0,
        fast_food: 0,
      },
      radiiMeters: {
        grocery: 1000,
        parks: 1000,
        transit: 1000,
        healthcare: 1000,
        schools: 1000,
        fast_food: 1000,
      },
      caps: {
        grocery: 1.0,
        parks: 1.0,
      },
    };

    const groceryAtZeroDistance: ScorableFacilityInput[] = [
      {
        id: "osm:g1",
        sourceId: "osm_overpass",
        category: "grocery",
        name: "Harvard Sq Market",
        lat: point.lat,
        lng: point.lng,
      },
    ];

    // Case 1: Both sources healthy ("ok"), parks genuinely has 0 facilities
    const healthyZeroParks = computeAccessibilityScore(
      point,
      groceryAtZeroDistance,
      prefs,
      {
        categorySourceStatuses: { grocery: "ok", parks: "ok" },
      }
    );
    expect(healthyZeroParks.completeness).toBe("complete");
    expect(healthyZeroParks.categoryBreakdown.parks.status).toBe("ok");
    expect(healthyZeroParks.categoryBreakdown.parks.intensity).toBe(0);
    expect(healthyZeroParks.score).toBe(50);

    // Case 2: Parks source timed out ("timeout" -> "unknown").
    // Must NOT silently renormalize totalWeight to 50 and report score=100!
    const failedParks = computeAccessibilityScore(
      point,
      groceryAtZeroDistance,
      prefs,
      {
        categorySourceStatuses: { grocery: "ok", parks: "timeout" },
      }
    );
    expect(failedParks.completeness).toBe("partial");
    expect(failedParks.missingOrFailedCategories).toContain("parks");
    expect(failedParks.failedWeightedCategories).toContain("parks");
    expect(failedParks.categoryBreakdown.parks.status).toBe("unknown");
    expect(failedParks.categoryBreakdown.parks.intensity).toBeNull();
    expect(failedParks.totalWeight).toBe(100);
    expect(failedParks.knownWeight).toBe(50);
    expect(failedParks.knownWeightFraction).toBe(0.5);
    expect(failedParks.score).toBe(50);

    // Case 3: All weighted categories failed -> completeness = "unknown"
    const allFailed = computeAccessibilityScore(point, groceryAtZeroDistance, prefs, {
      categorySourceStatuses: { grocery: "failed", parks: "timeout" },
    });
    expect(allFailed.completeness).toBe("unknown");
    expect(allFailed.score).toBe(0);
  });

  it("enforces default weight 0 for fast_food commercial context and updates score when user preferences change", () => {
    expect(DEFAULT_CATEGORY_CONFIGS.fast_food.defaultWeight).toBe(0);

    const fastFoodOnly: ScorableFacilityInput[] = [
      {
        id: "osm:ff1",
        sourceId: "osm_overpass",
        category: "fast_food",
        name: "Burger Chain",
        lat: point.lat,
        lng: point.lng,
      },
    ];

    // With default preferences, fast_food has weight 0 -> composite score is 0
    const defaultResult = computeAccessibilityScore(point, fastFoodOnly);
    expect(defaultResult.categoryBreakdown.fast_food.weight).toBe(0);
    expect(defaultResult.categoryBreakdown.fast_food.intensity).toBeGreaterThan(0);
    expect(defaultResult.score).toBe(0);

    // When user explicitly sets fast_food weight > 0, score reflects user preference
    const customResult = computeAccessibilityScore(point, fastFoodOnly, {
      weights: {
        grocery: 0,
        parks: 0,
        transit: 0,
        healthcare: 0,
        schools: 0,
        fast_food: 25,
      },
      caps: { fast_food: 1.0 },
    });
    expect(customResult.score).toBe(100);
  });

  it("evaluates bounded grid Venn-like overlap and separate environmental due-diligence layer", () => {
    const facilities: ScorableFacilityInput[] = [
      {
        id: "osm:g1",
        sourceId: "osm_overpass",
        category: "grocery",
        name: "Central Market",
        lat: point.lat,
        lng: point.lng,
      },
      {
        id: "osm:p1",
        sourceId: "osm_overpass",
        category: "parks",
        name: "Cambridge Common",
        lat: point.lat,
        lng: point.lng,
      },
    ];

    const grid = computeBoundedGridOverlap(point, 800, facilities, {
      weights: {
        grocery: 50,
        parks: 50,
        transit: 0,
        healthcare: 0,
        schools: 0,
        fast_food: 0,
      },
    });
    expect(grid.cells.length).toBeGreaterThan(0);
    expect(grid.maxOverlapCount).toBe(2);
    expect(grid.sweetSpotCells.length).toBeGreaterThan(0);

    // AUDIT-05: Non-finite gridResolution (e.g. NaN) safely falls back to 11
    const nanGrid = computeBoundedGridOverlap(
      point,
      800,
      facilities,
      undefined,
      { gridResolution: Number.NaN }
    );
    expect(nanGrid.gridResolution).toBe(11);
    expect(nanGrid.cells.length).toBeGreaterThan(0);

    const envRecords = evaluateEnvironmentalLayer(point, [
      // Bare industrial building with no EPA programs -> ignored
      {
        id: "neutral_1",
        sourceId: "epa_frs",
        name: "Neutral Data Center",
        lat: point.lat,
        lng: point.lng,
        programs: [],
        activePermitsOrEmissions: false,
      },
      // Documented EPA FRS facility -> retained with non-automatic-health-determination flag
      {
        id: "epa_100",
        registryId: "110000123456",
        sourceId: "epa_frs",
        name: "Regulated Lab Facility",
        lat: point.lat,
        lng: point.lng,
        programs: ["RCRAInfo"],
      },
    ]);

    expect(envRecords).toHaveLength(1);
    expect(envRecords[0].isAutomaticHealthDetermination).toBe(false);

    const prefComposite = computeOptionalUserPreferenceComposite(80, 10);
    expect(prefComposite.preferenceCompositeScore).toBe(70);
    expect(prefComposite.isMarketDollarEstimate).toBe(false);
    expect(prefComposite.modifiesAvmEstimate).toBe(false);
  });
});

describe("Asking-vs-AVM Price-Gap & Range Classification (`computePriceGap`)", () => {
  it("computes +10.0% gapPct and below_estimate_range_candidate for AVM=500,000, ask=450,000, range=[460,000, 540,000]", () => {
    const res = computePriceGap({
      avmPrice: 500_000,
      askingPrice: 450_000,
      avmLow: 460_000,
      avmHigh: 540_000,
    });

    expect(res.gapPct).toBe(10);
    expect(res.gapAmountUsd).toBe(50_000);
    expect(res.rangePosition).toBe("below_estimate_range_candidate");
    expect(res.isWithinEstimateRange).toBe(false);
    expect(res.isProvenUndervaluation).toBe(false);
  });

  it("classifies AVM=1,000,000, ask=900,000, range=[850,000, 1,150,000] as +10.0% AND in_range (not proven undervaluation)", () => {
    const res = computePriceGap({
      avmPrice: 1_000_000,
      askingPrice: 900_000,
      avmLow: 850_000,
      avmHigh: 1_150_000,
    });

    expect(res.gapPct).toBe(10);
    expect(res.gapAmountUsd).toBe(100_000);
    expect(res.rangePosition).toBe("in_range");
    expect(res.isWithinEstimateRange).toBe(true);
    expect(res.isProvenUndervaluation).toBe(false);
    expect(res.interpretationNote).toContain("in_range");
    expect(res.interpretationNote).toContain("not proven undervaluation");
  });

  it("classifies askingPrice > avmHigh as above_estimate_range_candidate with negative gapPct", () => {
    const res = computePriceGap(550_000, 500_000, 470_000, 530_000);
    expect(res.gapPct).toBe(-10);
    expect(res.gapAmountUsd).toBe(-50_000);
    expect(res.rangePosition).toBe("above_estimate_range_candidate");
    expect(res.isWithinEstimateRange).toBe(false);
  });

  it("returns range_unknown when [avmLow, avmHigh] is missing, non-positive, or inverted while preserving point gapPct", () => {
    const missingRange = computePriceGap({
      avmPrice: 500_000,
      askingPrice: 450_000,
      avmLow: null,
      avmHigh: null,
    });
    expect(missingRange.gapPct).toBe(10);
    expect(missingRange.rangePosition).toBe("range_unknown");

    const invertedRange = computePriceGap({
      avmPrice: 500_000,
      askingPrice: 450_000,
      avmLow: 550_000,
      avmHigh: 480_000,
    });
    expect(invertedRange.gapPct).toBe(10);
    expect(invertedRange.rangePosition).toBe("range_unknown");
  });

  it("returns no_avm and gapPct=null when avmPrice or askingPrice is missing, <= 0, or non-finite", () => {
    expect(computePriceGap({ avmPrice: null, askingPrice: 450_000 }).rangePosition).toBe(
      "no_avm"
    );
    expect(computePriceGap({ avmPrice: 0, askingPrice: 450_000 }).gapPct).toBeNull();
    expect(computePriceGap({ avmPrice: -500_000, askingPrice: 450_000 }).rangePosition).toBe(
      "no_avm"
    );
    expect(computePriceGap({ avmPrice: 500_000, askingPrice: 0 }).rangePosition).toBe("no_avm");
    expect(
      computePriceGap({ avmPrice: Number.NaN, askingPrice: 450_000 }).rangePosition
    ).toBe("no_avm");
  });
});
