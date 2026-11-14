import fs from 'node:fs';
import http from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';
import { Duplex } from 'node:stream';
import express, { type Express } from 'express';
import { describe, expect, it } from 'vitest';
import {
  ANALYSIS_BOUNDS,
  DEFAULT_PREFERENCE_CAPS,
  DEFAULT_PREFERENCE_RADII_METERS,
  DEFAULT_PREFERENCE_WEIGHTS,
  EXAMPLE_US_LOCATIONS,
  RENTCAST_BUDGET_DEFAULTS,
} from '../../src/shared/constants';
import {
  AccessibilityResultSchema,
  AnalysisAreaSchema,
  ApiErrorResponseSchema,
  BoundedGridOverlapResultSchema,
  BudgetStoreModeSchema,
  EligibleExplainEvidenceSourceSchema,
  EnvironmentalRecordSchema,
  EvaluatedFacilityContributionSchema,
  ExplainEvidenceItemSchema,
  FacilityRecordSchema,
  HealthResponseSchema,
  PreferenceProfileSchema,
  PriceGapResultSchema,
  PropertySearchRequestSchema,
  PublicRuntimeConfigSchema,
  RegionResolveRequestSchema,
  SessionExpandRequestSchema,
  createDefaultPreferenceProfile,
} from '../../src/shared/schemas';
import { createApp } from '../../src/server/app';
import {
  buildPublicRuntimeConfig,
  loadServerConfig,
  redactSecretsFromText,
} from '../../src/server/config';
import { AreaGeospatialCache } from '../../src/server/geospatial/cache';
import { startServer } from '../../src/server/index';
import {
  DEFAULT_CATEGORY_CONFIGS,
  InvalidCoordinateError,
  WGS84_MEAN_EARTH_RADIUS_METERS,
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
  type ScorableFacilityInput,
  validateCoordinates,
  validatePoint,
} from '../../src/server/geospatial/scoring';
import {
  SOURCE_POLICY_REGISTRY,
  SourcePolicyViolationError,
  assertSourceAnalysisEligible,
  enforceSourcePolicyOnRecord,
  filterEligibleFacilities,
  isSourceAmenityEligible,
  isSourceAnalysisEligible,
  isSourceEnvironmentalEligible,
  partitionFacilitiesBySourcePolicy,
} from '../../src/server/geospatial/sourcePolicy';

const REPO_ROOT = path.resolve(__dirname, '../..');

function createSeededRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function shuffleDeterministic<T>(items: readonly T[], rng: () => number): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy;
}

interface SimulatedHttpResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | number | undefined>;
  readonly text: string;
  readonly body: any;
}

/**
 * Invokes an Express `app` through Node's real `http.IncomingMessage` / `http.ServerResponse`
 * pipeline over an in-memory Duplex stream so full middleware (`express.json`, limits,
 * headers, routers, error handlers) is exercised deterministically without TCP socket binds.
 */
async function invokeExpressApp(
  app: Express,
  options: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
    rawBody?: string;
  }
): Promise<SimulatedHttpResponse> {
  return new Promise((resolve, reject) => {
    const reqSocket = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
    Object.assign(reqSocket, { remoteAddress: '127.0.0.1' });

    const wireChunks: Buffer[] = [];
    const resSocket = new Duplex({
      read() {},
      write(chunk, encoding, callback) {
        wireChunks.push(
          Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8')
        );
        callback();
      },
    });
    Object.assign(resSocket, { writable: true });

    const req = new http.IncomingMessage(reqSocket as unknown as Socket);
    req._read = () => {};
    req.method = options.method;
    req.url = options.url;

    const payloadString =
      options.rawBody !== undefined
        ? options.rawBody
        : options.body !== undefined
          ? JSON.stringify(options.body)
          : undefined;
    const payloadBuffer =
      payloadString !== undefined ? Buffer.from(payloadString, 'utf8') : undefined;

    const normalizedHeaders: Record<string, string> = {
      host: 'localhost',
    };
    if (payloadBuffer !== undefined) {
      normalizedHeaders['content-type'] = 'application/json';
      normalizedHeaders['content-length'] = String(payloadBuffer.byteLength);
    }
    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
        normalizedHeaders[k.toLowerCase()] = v;
      }
    }
    req.headers = normalizedHeaders;

    const res = new http.ServerResponse(req);
    res.assignSocket(resSocket as unknown as Socket);

    res.on('finish', () => {
      const rawWire = Buffer.concat(wireChunks).toString('utf8');
      const headerSplitIdx = rawWire.indexOf('\r\n\r\n');
      const text = headerSplitIdx >= 0 ? rawWire.slice(headerSplitIdx + 4) : rawWire;

      let parsedBody: unknown = text;
      try {
        parsedBody = text.length > 0 ? JSON.parse(text) : undefined;
      } catch {
        // Keep raw text when non-JSON
      }
      const rawHeaders = res.getHeaders();
      const headers: Record<string, string | string[] | number | undefined> = {};
      for (const [k, v] of Object.entries(rawHeaders)) {
        headers[k.toLowerCase()] = v;
      }
      reqSocket.destroy();
      resSocket.destroy();
      resolve({
        status: res.statusCode,
        headers,
        text,
        body: parsedBody,
      });
    });

    res.on('error', reject);

    app(req, res);

    queueMicrotask(() => {
      if (payloadBuffer !== undefined) {
        req.push(payloadBuffer);
      }
      req.push(null);
    });
  });
}

describe('Stage 1 Pre-Integration Adversarial Audit', () => {
  describe('GEO-01 & GEO-02: WGS84 Geodesic Distance & Strict Coordinate Validation', () => {
    it('returns exact 0 for coincident points and normalizes -0 to +0', () => {
      expect(computeGeodesicDistanceMeters(47.6062, -122.3321, 47.6062, -122.3321)).toBe(0);
      expect(
        computeGeodesicDistanceMeters({ lat: 30.2672, lng: -97.7431 }, { lat: 30.2672, lng: -97.7431 })
      ).toBe(0);

      const normalizedZero = validateCoordinates(-0, -0);
      expect(Object.is(normalizedZero.lat, 0)).toBe(true);
      expect(Object.is(normalizedZero.lng, 0)).toBe(true);
    });

    it('is bit-identically symmetric and matches WGS84 spherical arc lengths', () => {
      const pairs = [
        [
          { lat: 47.6062, lng: -122.3321 }, // Seattle, WA
          { lat: 30.2672, lng: -97.7431 }, // Austin, TX
        ],
        [
          { lat: 42.3736, lng: -71.1097 }, // Cambridge, MA
          { lat: 25.7617, lng: -80.1918 }, // Miami, FL
        ],
        [
          { lat: 61.2181, lng: -149.9003 }, // Anchorage, AK
          { lat: 21.3069, lng: -157.8583 }, // Honolulu, HI
        ],
      ] as const;

      for (const [a, b] of pairs) {
        const dAb = computeGeodesicDistanceMeters(a, b);
        const dBa = computeGeodesicDistanceMeters(b, a);
        const dOverload = computeGeodesicDistanceMeters(a.lat, a.lng, b.lat, b.lng);
        expect(dAb).toBe(dBa);
        expect(dAb).toBe(dOverload);
        expect(dAb).toBeGreaterThan(100_000);
      }

      // 1 degree along the equator: R * pi / 180 = 111,195.0802335329 m
      const oneDegEquator = computeGeodesicDistanceMeters(0, 0, 0, 1);
      const expectedMeters = (WGS84_MEAN_EARTH_RADIUS_METERS * Math.PI) / 180;
      expect(oneDegEquator).toBeCloseTo(expectedMeters, 6);
    });

    it('handles antipodal and polar extremes without NaN domain errors', () => {
      const halfCircumference = WGS84_MEAN_EARTH_RADIUS_METERS * Math.PI;
      expect(computeGeodesicDistanceMeters(0, 0, 0, 180)).toBeCloseTo(halfCircumference, 4);
      expect(computeGeodesicDistanceMeters(90, 0, -90, 0)).toBeCloseTo(halfCircumference, 4);
      expect(computeGeodesicDistanceMeters(0, -180, 0, 180)).toBeCloseTo(0, 6);
    });

    it('rejects NaN, +/-Infinity, out-of-range lat/lng, and non-numeric coordinates', () => {
      const invalidPairs: Array<[unknown, unknown]> = [
        [Number.NaN, -122.4],
        [37.7, Number.NaN],
        [Number.POSITIVE_INFINITY, -97.7],
        [30.2, Number.NEGATIVE_INFINITY],
        [-90.0001, 0],
        [90.0001, 0],
        [0, -180.0001],
        [0, 180.0001],
        ['37.77', -122.41],
        [null, undefined],
      ];

      for (const [lat, lng] of invalidPairs) {
        expect(() => validateCoordinates(lat as number, lng as number)).toThrow(
          InvalidCoordinateError
        );
        expect(() =>
          computeGeodesicDistanceMeters(lat as number, lng as number, 39.7392, -104.9903)
        ).toThrow(InvalidCoordinateError);
      }

      expect(() => validatePoint(null as unknown as { lat: number; lng: number })).toThrow(
        InvalidCoordinateError
      );
    });
  });

  describe('GEO-03: Linear Distance-Decay Kernel & Category Saturation', () => {
    it('evaluates exact linear kernel endpoints and rejects invalid inputs', () => {
      expect(computeLinearKernel(0, 1600)).toBe(1);
      expect(computeLinearKernel(400, 1600)).toBe(0.75);
      expect(computeLinearKernel(800, 1600)).toBe(0.5);
      expect(computeLinearKernel(1600, 1600)).toBe(0);
      expect(computeLinearKernel(1600.0001, 1600)).toBe(0);
      expect(computeLinearKernel(4000, 1600)).toBe(0);

      expect(() => computeLinearKernel(-1, 1600)).toThrow(RangeError);
      expect(() => computeLinearKernel(Number.NaN, 1600)).toThrow(RangeError);
      expect(() => computeLinearKernel(100, 0)).toThrow(RangeError);
      expect(() => computeLinearKernel(100, -500)).toThrow(RangeError);
      expect(() => computeLinearKernel(100, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    });

    it('saturates category intensity at 1.0 and rejects non-positive caps', () => {
      expect(computeCategorySaturation(0, 2.0)).toBe(0);
      expect(computeCategorySaturation(1.0, 2.0)).toBe(0.5);
      expect(computeCategorySaturation(2.0, 2.0)).toBe(1);
      expect(computeCategorySaturation(19.5, 2.0)).toBe(1);

      expect(() => computeCategorySaturation(-0.1, 2.0)).toThrow(RangeError);
      expect(() => computeCategorySaturation(1.0, 0)).toThrow(RangeError);
      expect(() => computeCategorySaturation(1.0, -2)).toThrow(RangeError);
      expect(() => computeCategorySaturation(Number.NaN, 2.0)).toThrow(RangeError);
    });
  });

  describe('GEO-08: Server Source-Policy Enforcement & google_places_context Rejection', () => {
    it('deeply freezes SOURCE_POLICY_REGISTRY and bars google_places_context unconditionally', () => {
      expect(Object.isFrozen(SOURCE_POLICY_REGISTRY)).toBe(true);
      for (const entry of Object.values(SOURCE_POLICY_REGISTRY)) {
        expect(Object.isFrozen(entry)).toBe(true);
      }

      const gpPolicy = SOURCE_POLICY_REGISTRY.google_places_context;
      expect(gpPolicy.analysisEligible).toBe(false);
      expect(gpPolicy.amenityScoringEligible).toBe(false);
      expect(gpPolicy.environmentalLayerEligible).toBe(false);
      expect(gpPolicy.heatmapEligible).toBe(false);
      expect(gpPolicy.featureStorageEligible).toBe(false);
      expect(gpPolicy.explainEvidenceEligible).toBe(false);
      expect(gpPolicy.displayContextAllowed).toBe(true);

      expect(isSourceAnalysisEligible('google_places_context')).toBe(false);
      expect(isSourceAmenityEligible('google_places_context')).toBe(false);
      expect(isSourceEnvironmentalEligible('google_places_context')).toBe(false);
      expect(() => assertSourceAnalysisEligible('google_places_context')).toThrow(
        SourcePolicyViolationError
      );

      // Unknown / scraped sources must also be barred
      expect(isSourceAnalysisEligible('scraped_portal')).toBe(false);
      expect(() => assertSourceAnalysisEligible('scraped_portal')).toThrow(
        SourcePolicyViolationError
      );
    });

    it('overrides forged analysisEligible: true on google_places_context across all scoring, grid, and environmental pipelines', () => {
      const origin = { lat: 30.2672, lng: -97.7431 }; // Austin, TX
      const forgedPlacesFacility: ScorableFacilityInput = {
        id: 'gp_forged_1',
        externalId: 'ChIJ_forged_place',
        sourceId: 'google_places_context',
        analysisEligible: true, // Forged caller flag!
        category: 'grocery',
        name: 'Forged Places Supermarket',
        lat: origin.lat,
        lng: origin.lng,
      };

      const enforced = enforceSourcePolicyOnRecord(forgedPlacesFacility);
      expect(enforced.analysisEligible).toBe(false);

      const partitioned = partitionFacilitiesBySourcePolicy([forgedPlacesFacility]);
      expect(partitioned.eligible).toHaveLength(0);
      expect(partitioned.rejected).toHaveLength(1);
      expect(partitioned.rejected[0]?.analysisEligible).toBe(false);
      expect(partitioned.rejectedCountBySource.google_places_context).toBe(1);
      expect(filterEligibleFacilities([forgedPlacesFacility])).toHaveLength(0);

      const scoreResult = computeAccessibilityScore(origin, [
        forgedPlacesFacility,
        {
          ...forgedPlacesFacility,
          id: 'gp_forged_2',
          category: 'transit',
        },
      ]);
      expect(scoreResult.score).toBe(0);
      expect(scoreResult.deduplicatedFacilityCount).toBe(0);
      expect(scoreResult.rejectedFacilityCount).toBe(2);
      expect(scoreResult.rejectedCountBySource.google_places_context).toBe(2);

      const gridResult = computeBoundedGridOverlap(origin, 1000, [forgedPlacesFacility]);
      expect(gridResult.maxOverlapCount).toBe(0);
      expect(gridResult.cells.every((c) => c.accessibilityScore === 0)).toBe(true);

      const envResult = evaluateEnvironmentalLayer(origin, [
        {
          id: 'gp_env_1',
          sourceId: 'google_places_context',
          analysisEligible: true,
          name: 'Forged Industrial Place',
          lat: origin.lat,
          lng: origin.lng,
          programs: ['RCRAInfo'],
          activePermitsOrEmissions: true,
        },
      ]);
      expect(envResult).toHaveLength(0);
    });

    it('gates synthetic_demo when allowSyntheticDemo is false and keeps epa_frs out of positive amenity scoring', () => {
      const origin = { lat: 47.6062, lng: -122.3321 };
      const syntheticGrocery: ScorableFacilityInput = {
        id: 'syn_1',
        sourceId: 'synthetic_demo',
        analysisEligible: true,
        category: 'grocery',
        name: 'Synthetic Market',
        lat: origin.lat,
        lng: origin.lng,
      };

      const blockedSynthetic = computeAccessibilityScore(
        origin,
        [syntheticGrocery],
        undefined,
        { allowSyntheticDemo: false }
      );
      expect(blockedSynthetic.score).toBe(0);
      expect(blockedSynthetic.rejectedCountBySource.synthetic_demo).toBe(1);

      const epaFacilityInAmenityInput: ScorableFacilityInput = {
        id: 'epa_1',
        sourceId: 'epa_frs',
        analysisEligible: true,
        category: 'parks',
        name: 'EPA Registered Site',
        lat: origin.lat,
        lng: origin.lng,
      };
      const amenityWithEpa = computeAccessibilityScore(origin, [epaFacilityInAmenityInput]);
      expect(amenityWithEpa.score).toBe(0);
      expect(amenityWithEpa.rejectedCountBySource.epa_frs).toBe(1);

      // Bare industrial facility without documented EPA programs must be ignored as neutral
      const envRecords = evaluateEnvironmentalLayer(origin, [
        {
          id: 'bare_ind',
          sourceId: 'epa_frs',
          name: 'Neutral Data Center Tag',
          lat: origin.lat,
          lng: origin.lng,
          programs: [],
        },
        {
          id: 'documented_frs',
          registryId: '110000491234',
          sourceId: 'epa_frs',
          name: 'Regulated Air Permit Facility',
          lat: origin.lat + 0.002,
          lng: origin.lng,
          programs: ['ICIS-AIR', 'TRI'],
        },
      ]);
      expect(envRecords).toHaveLength(1);
      expect(envRecords[0]?.registryId).toBe('110000491234');
      expect(envRecords[0]?.isAutomaticHealthDetermination).toBe(false);
    });
  });

  describe('GEO-04, GEO-05, GEO-06, GEO-07, GEO-09: Order-Invariance, Deduplication, Edge Buffer & Unknown Handling', () => {
    it('produces bit-identical scores across 30 deterministic permutations of mixed/duplicate facilities', () => {
      const origin = { lat: 41.8781, lng: -87.6298 }; // Chicago, IL
      const fixture: ScorableFacilityInput[] = [
        // OSM node + way for the same supermarket ~18m apart
        {
          id: 'osm_node_101',
          externalId: 'node/101',
          sourceId: 'osm_overpass',
          category: 'grocery',
          name: "Trader Joe's",
          lat: 41.879,
          lng: -87.6298,
        },
        {
          id: 'osm_way_202',
          externalId: 'way/202',
          sourceId: 'osm_overpass',
          category: 'grocery',
          name: 'TRADER JOES!',
          lat: 41.87915,
          lng: -87.6298,
        },
        // Distinct second grocery store > 200m away
        {
          id: 'osm_node_103',
          externalId: 'node/103',
          sourceId: 'osm_overpass',
          category: 'grocery',
          name: 'Jewel-Osco',
          lat: 41.882,
          lng: -87.632,
        },
        // Exact duplicate sourceId + externalId
        {
          id: 'osm_node_103_dup',
          externalId: 'node/103',
          sourceId: 'osm_overpass',
          category: 'grocery',
          name: 'Jewel-Osco',
          lat: 41.882,
          lng: -87.632,
        },
        // Two unnamed transit stops ~5m apart (should merge) + one 80m away (should stay distinct)
        {
          id: 'bus_a',
          sourceId: 'osm_overpass',
          category: 'transit',
          name: '',
          lat: 41.8785,
          lng: -87.6298,
        },
        {
          id: 'bus_b',
          sourceId: 'osm_overpass',
          category: 'transit',
          name: '   ',
          lat: 41.87854,
          lng: -87.6298,
        },
        {
          id: 'bus_c',
          sourceId: 'osm_overpass',
          category: 'transit',
          name: '',
          lat: 41.8795,
          lng: -87.6298,
        },
        // Park, school, pharmacy, fast_food, and forged google_places_context
        {
          id: 'park_1',
          sourceId: 'osm_extract',
          category: 'parks',
          name: 'Grant Park',
          lat: 41.876,
          lng: -87.624,
        },
        {
          id: 'school_1',
          sourceId: 'osm_overpass',
          category: 'schools',
          name: 'Central Public Library',
          lat: 41.8762,
          lng: -87.628,
        },
        {
          id: 'health_1',
          sourceId: 'osm_overpass',
          category: 'healthcare',
          name: 'Downtown Clinic',
          lat: 41.881,
          lng: -87.626,
        },
        {
          id: 'ff_1',
          sourceId: 'osm_overpass',
          category: 'fast_food',
          name: 'Burger Chain',
          lat: origin.lat,
          lng: origin.lng,
        },
        {
          id: 'gp_injected',
          sourceId: 'google_places_context',
          analysisEligible: true,
          category: 'parks',
          name: 'Disallowed Google Place Park',
          lat: origin.lat,
          lng: origin.lng,
        },
      ];

      const baseline = computeAccessibilityScore(origin, fixture);
      expect(AccessibilityResultSchema.safeParse(baseline).success).toBe(true);
      expect(baseline.duplicatesMergedCount).toBe(3);
      expect(baseline.rejectedCountBySource.google_places_context).toBe(1);

      const rng = createSeededRng(20261114);
      for (let trial = 0; trial < 30; trial += 1) {
        const permuted =
          trial === 0 ? [...fixture].reverse() : shuffleDeterministic(fixture, rng);
        const current = computeAccessibilityScore(origin, permuted);

        expect(current.score).toBe(baseline.score);
        expect(current.deduplicatedFacilityCount).toBe(baseline.deduplicatedFacilityCount);
        expect(current.duplicatesMergedCount).toBe(baseline.duplicatesMergedCount);
        for (const cat of Object.keys(baseline.categoryBreakdown)) {
          expect(current.categoryBreakdown[cat]?.rawKernelSum).toBe(
            baseline.categoryBreakdown[cat]?.rawKernelSum
          );
          expect(current.categoryBreakdown[cat]?.intensity).toBe(
            baseline.categoryBreakdown[cat]?.intensity
          );
        }
      }
    });

    it('applies conservative deduplication thresholds without merging distinct categories at the same coordinate', () => {
      // 1 deg lat ~ 111,195 m => 0.0002 deg ~ 22.2 m (<= 35m), 0.0005 deg ~ 55.6 m (> 35m)
      const deduped = deduplicateFacilities([
        {
          id: 'g1',
          sourceId: 'osm_overpass',
          category: 'grocery',
          name: 'Corner Market',
          lat: 39.7392,
          lng: -104.9903,
        },
        {
          id: 'g2',
          sourceId: 'osm_overpass',
          category: 'grocery',
          name: 'Corner Market',
          lat: 39.7394, // ~22.2m away -> merged
          lng: -104.9903,
        },
        {
          id: 'g3',
          sourceId: 'osm_overpass',
          category: 'grocery',
          name: 'Corner Market',
          lat: 39.7398, // ~66.7m from g1 -> distinct
          lng: -104.9903,
        },
        {
          id: 'h1',
          sourceId: 'osm_overpass',
          category: 'healthcare', // Pharmacy inside same building as g1 -> distinct category!
          name: 'Corner Market',
          lat: 39.7392,
          lng: -104.9903,
        },
      ]);

      expect(deduped.facilities).toHaveLength(3);
      expect(deduped.duplicatesMergedCount).toBe(1);
    });

    it('retains influence-buffered facilities outside analysisArea.radiusMeters for perimeter properties', () => {
      const areaCenter = { lat: 35.7796, lng: -78.6382 }; // Raleigh, NC
      const areaRadiusMeters = 1600;
      const fetchRadius = computeInfluenceBufferRadiusMeters(areaRadiusMeters);
      expect(fetchRadius).toBe(4000); // 1600 + max default radius 2400 (healthcare)

      const metersPerDegLat = (WGS84_MEAN_EARTH_RADIUS_METERS * Math.PI) / 180;
      const perimeterHome = {
        lat: areaCenter.lat + 1500 / metersPerDegLat, // 1,500m north (inside 1,600m area)
        lng: areaCenter.lng,
      };
      const edgeGroceryOutsideArea = {
        id: 'edge_grocery_1',
        sourceId: 'osm_overpass' as const,
        category: 'grocery',
        name: 'Perimeter Supermarket',
        lat: areaCenter.lat + 1800 / metersPerDegLat, // 1,800m north (OUTSIDE 1,600m area, inside 4,000m fetch buffer!)
        lng: areaCenter.lng,
      };

      expect(computeGeodesicDistanceMeters(areaCenter, edgeGroceryOutsideArea)).toBeGreaterThan(
        areaRadiusMeters
      );

      const homeScore = computeAccessibilityScore(
        perimeterHome,
        [edgeGroceryOutsideArea],
        {
          weights: { grocery: 100, parks: 0, transit: 0, healthcare: 0, schools: 0, fast_food: 0 },
          radiiMeters: { grocery: 1600 },
          caps: { grocery: 1 },
        }
      );

      // 300m away with 1600m radius and cap=1 => k = 1 - 300/1600 = 0.8125 => score = 81.25
      expect(homeScore.categoryBreakdown.grocery?.facilityCount).toBe(1);
      expect(homeScore.score).toBeCloseTo(81.25, 2);
    });

    it('distinguishes healthy zero facilities (complete, 0) from failed/timed-out sources (partial/unknown, no renormalization)', () => {
      const point = { lat: 42.3601, lng: -71.0589 }; // Boston, MA
      const metersPerDegLat = (WGS84_MEAN_EARTH_RADIUS_METERS * Math.PI) / 180;
      // Place 2 groceries at 320m so each has k = 1 - 320/1600 = 0.8 => K = 1.6 => a_grocery = 1.6 / 2.0 = 0.8
      const facilities: ScorableFacilityInput[] = [
        {
          id: 'g_1',
          sourceId: 'osm_overpass',
          category: 'grocery',
          name: 'Market North',
          lat: point.lat + 320 / metersPerDegLat,
          lng: point.lng,
        },
        {
          id: 'g_2',
          sourceId: 'osm_overpass',
          category: 'grocery',
          name: 'Market South',
          lat: point.lat - 320 / metersPerDegLat,
          lng: point.lng,
        },
      ];

      const prefs = {
        weights: {
          grocery: 50,
          transit: 50,
          parks: 0,
          healthcare: 0,
          schools: 0,
          fast_food: 0,
        },
      };

      // Case A: Healthy Overpass response returned 0 transit stops
      const healthyZero = computeAccessibilityScore(point, facilities, prefs, {
        categorySourceStatuses: { grocery: 'ok', transit: 'ok' },
      });
      expect(healthyZero.completeness).toBe('complete');
      expect(healthyZero.categoryBreakdown.transit?.status).toBe('ok');
      expect(healthyZero.categoryBreakdown.transit?.intensity).toBe(0);
      expect(healthyZero.score).toBeCloseTo(40.0, 2);

      // Case B: Overpass timed out on weighted `transit` -> MUST NOT silently renormalize to 80.0!
      const partialTimeout = computeAccessibilityScore(point, facilities, prefs, {
        categorySourceStatuses: { grocery: 'ok', transit: 'timeout' },
      });
      expect(partialTimeout.completeness).toBe('partial');
      expect(partialTimeout.categoryBreakdown.transit?.status).toBe('unknown');
      expect(partialTimeout.categoryBreakdown.transit?.intensity).toBeNull();
      expect(partialTimeout.missingOrFailedCategories).toContain('transit');
      expect(partialTimeout.failedWeightedCategories).toEqual(['transit']);
      expect(partialTimeout.totalWeight).toBe(100);
      expect(partialTimeout.knownWeight).toBe(50);
      expect(partialTimeout.knownWeightFraction).toBe(0.5);
      expect(partialTimeout.score).toBeCloseTo(40.0, 2);

      // Case C: All weighted categories failed -> completeness: "unknown", score: 0
      const allFailed = computeAccessibilityScore(point, facilities, prefs, {
        categorySourceStatuses: { grocery: 'failed', transit: 'timeout' },
      });
      expect(allFailed.completeness).toBe('unknown');
      expect(allFailed.score).toBe(0);

      // Case D: Unweighted fast_food (weight = 0) fails while weighted categories succeed -> still "complete"
      const unweightedFailed = computeAccessibilityScore(point, facilities, prefs, {
        categorySourceStatuses: { grocery: 'ok', transit: 'ok', fast_food: 'timeout' },
      });
      expect(unweightedFailed.completeness).toBe('complete');
      expect(unweightedFailed.failedWeightedCategories).toEqual([]);
    });

    it('enforces fast_food default weight 0, handles W_total = 0, and rejects negative weights', () => {
      expect(DEFAULT_PREFERENCE_WEIGHTS.fast_food).toBe(0);
      expect(DEFAULT_CATEGORY_CONFIGS.fast_food.defaultWeight).toBe(0);
      expect(createDefaultPreferenceProfile().weights.fast_food).toBe(0);

      const point = { lat: 33.749, lng: -84.388 }; // Atlanta, GA
      const denseFastFood: ScorableFacilityInput[] = Array.from({ length: 6 }, (_, idx) => ({
        id: `ff_${idx}`,
        sourceId: 'osm_overpass',
        category: 'fast_food',
        name: `Fast Food #${idx}`,
        lat: point.lat + idx * 0.0005,
        lng: point.lng,
      }));

      // Default weights: fast_food = 0 -> score MUST be 0 despite saturated fast_food intensity
      const defaultScore = computeAccessibilityScore(point, denseFastFood);
      expect(defaultScore.categoryBreakdown.fast_food?.intensity).toBe(1);
      expect(defaultScore.score).toBe(0);

      // User explicitly opts into fast_food convenience weight
      const optedInScore = computeAccessibilityScore(point, denseFastFood, {
        weights: { grocery: 25, parks: 20, transit: 20, healthcare: 15, schools: 20, fast_food: 25 },
      });
      expect(optedInScore.score).toBeCloseTo((100 * 25) / 125, 4); // 20.0

      // All zero weights -> score = 0 (no NaN division by zero)
      const zeroWeightScore = computeAccessibilityScore(point, denseFastFood, {
        weights: { grocery: 0, parks: 0, transit: 0, healthcare: 0, schools: 0, fast_food: 0 },
      });
      expect(zeroWeightScore.score).toBe(0);

      // Negative weight rejected in both pure math and Zod schema
      expect(() =>
        computeAccessibilityScore(point, denseFastFood, {
          weights: { grocery: -5 },
        })
      ).toThrow(RangeError);
      expect(
        PreferenceProfileSchema.safeParse({
          weights: { ...DEFAULT_PREFERENCE_WEIGHTS, grocery: -1 },
          radiiMeters: DEFAULT_PREFERENCE_RADII_METERS,
        }).success
      ).toBe(false);

      // Optional preference composite never claims market dollars or modifies AVM
      const composite = computeOptionalUserPreferenceComposite(82.5, 10);
      expect(composite.preferenceCompositeScore).toBe(72.5);
      expect(composite.isMarketDollarEstimate).toBe(false);
      expect(composite.modifiesAvmEstimate).toBe(false);
    });

    it('computes bounded regular-grid Venn overlap conforming to BoundedGridOverlapResultSchema', () => {
      const center = { lat: 39.7392, lng: -104.9903 }; // Denver, CO
      const facilities: ScorableFacilityInput[] = [
        { id: 'g', sourceId: 'osm_overpass', category: 'grocery', name: 'Grocer', lat: center.lat, lng: center.lng },
        { id: 'p', sourceId: 'osm_overpass', category: 'parks', name: 'Park', lat: center.lat, lng: center.lng },
        { id: 't', sourceId: 'osm_overpass', category: 'transit', name: 'Station', lat: center.lat, lng: center.lng },
      ];

      const grid = computeBoundedGridOverlap(center, 1200, facilities, undefined, {
        gridResolution: 9,
      });
      expect(BoundedGridOverlapResultSchema.safeParse(grid).success).toBe(true);
      expect(grid.maxOverlapCount).toBe(3);
      expect(grid.sweetSpotCells.length).toBeGreaterThan(0);
      expect(grid.activeCategories).not.toContain('fast_food');
    });
  });

  describe('PROP-01 & PROP-02: Asking-vs-AVM Price-Gap & Confidence Range Classification', () => {
    it('computes gapPct = 100 * (AVM - askingPrice) / AVM using AVM as denominator', () => {
      // Canonical verification case: AVM = 500k, ask = 450k => +10.0% (NOT +11.11% from dividing by ask!)
      const belowRange = computePriceGap({
        askingPrice: 450_000,
        avmPrice: 500_000,
        avmLow: 460_000,
        avmHigh: 540_000,
      });
      expect(PriceGapResultSchema.safeParse(belowRange).success).toBe(true);
      expect(belowRange.gapPct).toBe(10);
      expect(belowRange.gapAmountUsd).toBe(50_000);
      expect(belowRange.rangePosition).toBe('below_estimate_range_candidate');
      expect(belowRange.isWithinEstimateRange).toBe(false);
      expect(belowRange.isProvenUndervaluation).toBe(false);

      // Above AVM and above range: AVM = 500k, ask = 550k => -10.0%
      const aboveRange = computePriceGap(550_000, 500_000, 460_000, 540_000);
      expect(PriceGapResultSchema.safeParse(aboveRange).success).toBe(true);
      expect(aboveRange.gapPct).toBe(-10);
      expect(aboveRange.gapAmountUsd).toBe(-50_000);
      expect(aboveRange.rangePosition).toBe('above_estimate_range_candidate');
      expect(aboveRange.isWithinEstimateRange).toBe(false);

      // Exact midpoint match: gapPct = 0
      const exactMatch = computePriceGap(500_000, 500_000, 460_000, 540_000);
      expect(exactMatch.gapPct).toBe(0);
      expect(exactMatch.gapAmountUsd).toBe(0);
      expect(exactMatch.rangePosition).toBe('in_range');
    });

    it('enforces mandatory guardrail: AVM=1,000,000, ask=900,000, range=[850,000, 1,150,000] => +10.0% AND in_range', () => {
      const res = computePriceGap({
        askingPrice: 900_000,
        avmPrice: 1_000_000,
        avmLow: 850_000,
        avmHigh: 1_150_000,
      });
      expect(PriceGapResultSchema.safeParse(res).success).toBe(true);
      expect(res.gapPct).toBe(10);
      expect(res.gapAmountUsd).toBe(100_000);
      expect(res.rangePosition).toBe('in_range');
      expect(res.isWithinEstimateRange).toBe(true);
      expect(res.isProvenUndervaluation).toBe(false);
      expect(res.interpretationNote.toLowerCase()).toContain('not proven undervaluation');

      // Inclusive boundary checks at avmLow and avmHigh
      expect(computePriceGap(850_000, 1_000_000, 850_000, 1_150_000).rangePosition).toBe('in_range');
      expect(computePriceGap(1_150_000, 1_000_000, 850_000, 1_150_000).rangePosition).toBe(
        'in_range'
      );
    });

    it('classifies missing/inverted range bounds as range_unknown and missing/non-positive prices as no_avm', () => {
      const invertedBounds = computePriceGap({
        askingPrice: 450_000,
        avmPrice: 500_000,
        avmLow: 550_000,
        avmHigh: 480_000,
      });
      expect(PriceGapResultSchema.safeParse(invertedBounds).success).toBe(true);
      expect(invertedBounds.gapPct).toBe(10);
      expect(invertedBounds.rangePosition).toBe('range_unknown');

      const missingBounds = computePriceGap(450_000, 500_000, null, null);
      expect(missingBounds.gapPct).toBe(10);
      expect(missingBounds.rangePosition).toBe('range_unknown');

      const noAvmInputs: Array<[number | null, number | null]> = [
        [450_000, null],
        [null, 500_000],
        [450_000, 0],
        [0, 500_000],
        [-450_000, 500_000],
        [450_000, -500_000],
        [Number.NaN, 500_000],
        [450_000, Number.POSITIVE_INFINITY],
      ];

      for (const [ask, avm] of noAvmInputs) {
        const out = computePriceGap(ask, avm, 400_000, 600_000);
        expect(PriceGapResultSchema.safeParse(out).success).toBe(true);
        expect(out.gapPct).toBeNull();
        expect(out.gapAmountUsd).toBeNull();
        expect(out.rangePosition).toBe('no_avm');
      }
    });
  });

  describe('PROP-08, UX-03 & SEC-06: Shared Zod Schemas, Budget Ceilings & US Multi-City Neutrality', () => {
    it('validates XOR region input, bounded area radii, search limit <= 25, and explicit session expansion', () => {
      // RegionResolveRequestSchema requires exactly one of `query` or `bounds`
      expect(RegionResolveRequestSchema.safeParse({}).success).toBe(false);
      expect(RegionResolveRequestSchema.safeParse({ query: '   ' }).success).toBe(false);
      expect(
        RegionResolveRequestSchema.safeParse({
          query: 'Seattle, WA',
          bounds: { centerLat: 47.6, centerLng: -122.3, radiusMeters: 1600 },
        }).success
      ).toBe(false);
      expect(RegionResolveRequestSchema.safeParse({ query: 'Seattle, WA' }).success).toBe(true);

      // Radius bounds [400, 5000]
      const validArea = {
        areaId: 'us-tx-austin',
        label: 'Austin, TX',
        centerLat: 30.2672,
        centerLng: -97.7431,
        radiusMeters: 1600,
        boundingBox: { minLat: 30.25, maxLat: 30.28, minLng: -97.76, maxLng: -97.72 },
        city: 'Austin',
        state: 'TX',
        zipCode: '78701',
        isUsLocation: true as const,
        isViewportApproximation: true as const,
      };
      expect(AnalysisAreaSchema.safeParse(validArea).success).toBe(true);
      expect(AnalysisAreaSchema.safeParse({ ...validArea, radiusMeters: 399 }).success).toBe(false);
      expect(AnalysisAreaSchema.safeParse({ ...validArea, radiusMeters: 5001 }).success).toBe(
        false
      );
      expect(AnalysisAreaSchema.safeParse({ ...validArea, isUsLocation: false }).success).toBe(
        false
      );

      // Search limit <= 25
      expect(
        PropertySearchRequestSchema.safeParse({ analysisArea: validArea, limit: 25 }).success
      ).toBe(true);
      expect(
        PropertySearchRequestSchema.safeParse({ analysisArea: validArea, limit: 26 }).success
      ).toBe(false);

      // Session expansion requires literal userConfirmed: true
      expect(SessionExpandRequestSchema.safeParse({ userConfirmed: false }).success).toBe(false);
      expect(SessionExpandRequestSchema.safeParse({}).success).toBe(false);
      expect(SessionExpandRequestSchema.safeParse({ userConfirmed: true }).success).toBe(true);

      // Explain evidence schema bars google_places_context
      expect(EligibleExplainEvidenceSourceSchema.safeParse('google_places_context').success).toBe(
        false
      );
      expect(
        ExplainEvidenceItemSchema.safeParse({
          evidenceId: 'ev_1',
          sourceId: 'google_places_context',
          label: 'Disallowed',
          detail: 'Disallowed',
        }).success
      ).toBe(false);
    });

    it('clamps RENTCAST_GLOBAL_MONTHLY_LIMIT strictly below 50 and avoids hardcoding Berkeley, CA', () => {
      const overLimitConfig = loadServerConfig({
        NODE_ENV: 'test',
        RENTCAST_GLOBAL_MONTHLY_LIMIT: '999',
        RENTCAST_INITIAL_SPENT_CALLS: '4',
      });
      expect(overLimitConfig.rentcastGlobalMonthlyLimit).toBe(49);
      expect(overLimitConfig.rentcastGlobalMonthlyLimit).toBeLessThan(
        RENTCAST_BUDGET_DEFAULTS.accountMonthlyFreeTier
      );
      expect(overLimitConfig.rentcastInitialSpentCalls).toBe(4);

      const defaultConfig = loadServerConfig({ NODE_ENV: 'test' });
      expect(defaultConfig.rentcastGlobalMonthlyLimit).toBe(35);
      expect(defaultConfig.host).toBe('0.0.0.0');
      expect(defaultConfig.port).toBe(8080);

      // Multi-city US example list never locks onto Berkeley, CA
      expect(EXAMPLE_US_LOCATIONS.length).toBeGreaterThanOrEqual(4);
      expect(EXAMPLE_US_LOCATIONS.some((loc) => loc.toLowerCase().includes('berkeley'))).toBe(
        false
      );
    });
  });

  describe('SEC-05 & SEC-07: Secret Redaction, Isolation & Express App Baseline', () => {
    const CANARY_RENTCAST = 'rk_live_canary_secret_987654321';
    const CANARY_GEMINI = 'AIzaSyCanaryGeminiSecret_123456789';
    const CANARY_PLACES = 'AIzaSyCanaryPlacesServerSecret_55555';
    const CANARY_MAPS_BROWSER = 'AIzaSyPublicRestrictedBrowserMapsKey_001';

    it('never exposes server secrets in GET /api/config, GET /api/health, JSON.stringify, error payloads, or .env.example', async () => {
      const config = loadServerConfig({
        NODE_ENV: 'test',
        RENTCAST_API_KEY: CANARY_RENTCAST,
        GEMINI_API_KEY: CANARY_GEMINI,
        GOOGLE_PLACES_SERVER_KEY: CANARY_PLACES,
        GOOGLE_MAPS_BROWSER_KEY: CANARY_MAPS_BROWSER,
      });

      // 1. Direct JSON.stringify protection on config.secrets
      const serializedConfig = JSON.stringify(config);
      expect(serializedConfig).not.toContain(CANARY_RENTCAST);
      expect(serializedConfig).not.toContain(CANARY_GEMINI);
      expect(serializedConfig).not.toContain(CANARY_PLACES);

      // 2. redactSecretsFromText scrubs all three server secrets
      const rawLog = `Request failed: X-Api-Key=${CANARY_RENTCAST} gemini=${CANARY_GEMINI} places=${CANARY_PLACES}`;
      const scrubbed = redactSecretsFromText(rawLog, config);
      expect(scrubbed).not.toContain(CANARY_RENTCAST);
      expect(scrubbed).not.toContain(CANARY_GEMINI);
      expect(scrubbed).not.toContain(CANARY_PLACES);
      expect(scrubbed).toContain('[REDACTED]');

      // 3. Mount a throwing route to verify central error handler never leaks secret values
      const throwingRouter = express.Router();
      throwingRouter.post('/boom', (_req, _res, next) => {
        next(new Error(`Upstream crash with key ${CANARY_RENTCAST} and ${CANARY_GEMINI}`));
      });

      const app = createApp({ config, apiRouter: throwingRouter });

      const healthRes = await invokeExpressApp(app, { method: 'GET', url: '/api/health' });
      expect(healthRes.status).toBe(200);
      expect(HealthResponseSchema.safeParse(healthRes.body).success).toBe(true);
      expect(healthRes.headers['cache-control']).toBe('no-store');
      expect(healthRes.headers['x-content-type-options']).toBe('nosniff');
      expect(JSON.stringify(healthRes.body)).not.toContain(CANARY_RENTCAST);
      expect(JSON.stringify(healthRes.body)).not.toContain(CANARY_GEMINI);
      expect(JSON.stringify(healthRes.body)).not.toContain(CANARY_PLACES);

      const configRes = await invokeExpressApp(app, { method: 'GET', url: '/api/config' });
      expect(configRes.status).toBe(200);
      expect(PublicRuntimeConfigSchema.safeParse(configRes.body).success).toBe(true);
      const configText = JSON.stringify(configRes.body);
      expect(configText).not.toContain(CANARY_RENTCAST);
      expect(configText).not.toContain(CANARY_GEMINI);
      expect(configText).not.toContain(CANARY_PLACES);
      // Restricted browser Maps JS key IS intentionally exposed solely as mapsBrowserKey
      expect(configRes.body.mapsBrowserKey).toBe(CANARY_MAPS_BROWSER);

      const boomRes = await invokeExpressApp(app, {
        method: 'POST',
        url: '/api/boom',
        body: { clientRequestSeq: 42 },
      });
      expect(boomRes.status).toBe(500);
      expect(ApiErrorResponseSchema.safeParse(boomRes.body).success).toBe(true);
      expect(boomRes.body.clientRequestSeq).toBe(42);
      const boomText = JSON.stringify(boomRes.body);
      expect(boomText).not.toContain(CANARY_RENTCAST);
      expect(boomText).not.toContain(CANARY_GEMINI);
      expect(boomText).not.toContain(CANARY_PLACES);

      // 4. Verify .env.example contains only variable names and empty secret values
      const envExample = fs.readFileSync(path.join(REPO_ROOT, '.env.example'), 'utf8');
      expect(envExample).toMatch(/^RENTCAST_API_KEY=\s*$/m);
      expect(envExample).toMatch(/^GEMINI_API_KEY=\s*$/m);
      expect(envExample).toMatch(/^GOOGLE_MAPS_BROWSER_KEY=\s*$/m);
      expect(envExample).toMatch(/^GOOGLE_PLACES_SERVER_KEY=\s*$/m);
    });

    it('starts cleanly with zero external API keys configured and handles 400, 404, and 413 safely', async () => {
      const unconfigured = loadServerConfig({
        NODE_ENV: 'test',
        ENABLE_SYNTHETIC_DEMO_MODE: 'false',
      });
      const publicCfg = buildPublicRuntimeConfig(unconfigured);
      expect(publicCfg.uiSetupState).toBe('setup_needed');
      expect(publicCfg.mapsBrowserKey).toBeNull();
      expect(publicCfg.missingSetupEnvVars.map((v) => v.envVarName)).toEqual([
        'RENTCAST_API_KEY',
        'GOOGLE_MAPS_BROWSER_KEY',
        'GEMINI_API_KEY',
      ]);

      const app = createApp({ config: unconfigured });

      // Unknown API endpoint -> 404 ApiErrorResponse
      const notFound = await invokeExpressApp(app, {
        method: 'POST',
        url: '/api/does-not-exist',
        body: { clientRequestSeq: 7 },
      });
      expect(notFound.status).toBe(404);
      expect(ApiErrorResponseSchema.safeParse(notFound.body).success).toBe(true);
      expect(notFound.body.error.code).toBe('NOT_FOUND');
      expect(notFound.body.clientRequestSeq).toBe(7);

      // Malformed JSON -> 400 VALIDATION_ERROR
      const badJson = await invokeExpressApp(app, {
        method: 'POST',
        url: '/api/does-not-exist',
        headers: { 'Content-Type': 'application/json' },
        rawBody: '{"unterminated": true',
      });
      expect(badJson.status).toBe(400);
      expect(ApiErrorResponseSchema.safeParse(badJson.body).success).toBe(true);
      expect(badJson.body.error.code).toBe('VALIDATION_ERROR');

      // Oversized payload (> 256kb) -> 413 VALIDATION_ERROR
      const hugeBody = JSON.stringify({ pad: 'x'.repeat(300 * 1024) });
      const tooLarge = await invokeExpressApp(app, {
        method: 'POST',
        url: '/api/does-not-exist',
        headers: { 'Content-Type': 'application/json' },
        rawBody: hugeBody,
      });
      expect(tooLarge.status).toBe(413);
      expect(ApiErrorResponseSchema.safeParse(tooLarge.body).success).toBe(true);
      expect(tooLarge.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('DOC-01: Stage 1 Documentation & Parameter Parity', () => {
    it('verifies Stage 1 docs exist and match shared constants & scoring defaults', () => {
      const requiredStage1Docs = [
        'README.md',
        'docs/SWARM-PLAN.md',
        'docs/PRD.md',
        'docs/ARCHITECTURE.md',
        'docs/API-CONTRACTS.md',
        'docs/DATA-SOURCES.md',
        'docs/decisions/ADR-001-rentcast.md',
        'docs/SCORING.md',
        'docs/TEST-PLAN.md',
      ];

      for (const relPath of requiredStage1Docs) {
        expect(fs.existsSync(path.join(REPO_ROOT, relPath)), `Missing ${relPath}`).toBe(true);
      }

      // Verify constants.ts and scoring.ts default tables match 1:1
      for (const category of Object.keys(DEFAULT_PREFERENCE_WEIGHTS) as Array<
        keyof typeof DEFAULT_PREFERENCE_WEIGHTS
      >) {
        expect(DEFAULT_CATEGORY_CONFIGS[category].defaultWeight).toBe(
          DEFAULT_PREFERENCE_WEIGHTS[category]
        );
        expect(DEFAULT_CATEGORY_CONFIGS[category].defaultRadiusMeters).toBe(
          DEFAULT_PREFERENCE_RADII_METERS[category]
        );
        expect(DEFAULT_CATEGORY_CONFIGS[category].defaultCap).toBe(
          DEFAULT_PREFERENCE_CAPS[category]
        );
      }

      expect(ANALYSIS_BOUNDS.maxListingsPerSearch).toBe(25);
      expect(RENTCAST_BUDGET_DEFAULTS.defaultSessionListingsLimit).toBe(1);
      expect(RENTCAST_BUDGET_DEFAULTS.defaultSessionAvmsLimit).toBe(5);
      expect(RENTCAST_BUDGET_DEFAULTS.expandedSessionAvmsLimit).toBe(10);
      expect(RENTCAST_BUDGET_DEFAULTS.defaultGlobalMonthlyLimit).toBe(35);
      expect(RENTCAST_BUDGET_DEFAULTS.maxConfigurableMonthlyLimit).toBe(49);
    });

    it('AUDIT-01: keeps uiSetupState="setup_needed" when RENTCAST_API_KEY is missing even if ENABLE_SYNTHETIC_DEMO_MODE=true', () => {
      const cfg = loadServerConfig({
        NODE_ENV: 'test',
        ENABLE_SYNTHETIC_DEMO_MODE: 'true',
      });
      const publicCfg = buildPublicRuntimeConfig(cfg);
      expect(PublicRuntimeConfigSchema.safeParse(publicCfg).success).toBe(true);
      expect(publicCfg.capabilities.syntheticDemoEnabled).toBe(true);
      expect(publicCfg.capabilities.rentcastConfigured).toBe(false);
      expect(publicCfg.uiSetupState).toBe('setup_needed');
      expect(publicCfg.missingSetupEnvVars.map((item) => item.envVarName)).toContain(
        'RENTCAST_API_KEY'
      );
    });

    it('AUDIT-02: startServer honors overrideConfig.port (including ephemeral port 0) and binds 0.0.0.0', async () => {
      const baseCfg = loadServerConfig({
        NODE_ENV: 'test',
        BUDGET_STORE_MODE: 'memory',
      });
      const server = startServer({
        ...baseCfg,
        host: '0.0.0.0',
        port: 0,
      });

      try {
        await new Promise<void>((resolve, reject) => {
          server.once('listening', () => resolve());
          server.once('error', reject);
        });
        const addr = server.address();
        expect(addr).not.toBeNull();
        expect(typeof addr).toBe('object');
        if (addr && typeof addr === 'object') {
          expect(addr.address).toBe('0.0.0.0');
          expect(addr.port).toBeGreaterThan(0);
          expect(addr.port).not.toBe(8080);
        }
      } finally {
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    });

    it('AUDIT-03: strips invalid/negative/float clientRequestSeq in 400, 404, and 500 ApiErrorResponse payloads', async () => {
      const cfg = loadServerConfig({
        NODE_ENV: 'test',
        BUDGET_STORE_MODE: 'memory',
      });
      const crashRouter = express.Router();
      crashRouter.post('/explode', (_req, _res, next) => {
        next(new Error('Simulated internal error'));
      });
      const app = createApp({ config: cfg, apiRouter: crashRouter });

      const invalidSeqs: unknown[] = [-5, 3.14159, 9_999_999_999, '42', null];
      for (const badSeq of invalidSeqs) {
        // 404 unknown route
        const res404 = await invokeExpressApp(app, {
          method: 'POST',
          url: '/api/unknown-route',
          body: { clientRequestSeq: badSeq },
        });
        expect(res404.status).toBe(404);
        expect(ApiErrorResponseSchema.safeParse(res404.body).success).toBe(true);
        expect(res404.body.clientRequestSeq).toBeUndefined();

        // 500 error route
        const res500 = await invokeExpressApp(app, {
          method: 'POST',
          url: '/api/explode',
          body: { clientRequestSeq: badSeq },
        });
        expect(res500.status).toBe(500);
        expect(ApiErrorResponseSchema.safeParse(res500.body).success).toBe(true);
        expect(res500.body.clientRequestSeq).toBeUndefined();

        // 400 validation route on /api/regions/resolve and /api/geospatial/analyze
        const resGeo400 = await invokeExpressApp(app, {
          method: 'POST',
          url: '/api/geospatial/analyze',
          body: { clientRequestSeq: badSeq },
        });
        expect(resGeo400.status).toBe(400);
        expect(ApiErrorResponseSchema.safeParse(resGeo400.body).success).toBe(true);
        expect(resGeo400.body.clientRequestSeq).toBeUndefined();

        const resProp400 = await invokeExpressApp(app, {
          method: 'POST',
          url: '/api/regions/resolve',
          body: { clientRequestSeq: badSeq },
        });
        expect(resProp400.status).toBe(400);
        expect(ApiErrorResponseSchema.safeParse(resProp400.body).success).toBe(true);
        expect(resProp400.body.clientRequestSeq).toBeUndefined();
      }
    });

    it('AUDIT-04: enforces memory BudgetStoreMode and bars google_places_context in Facility, Contribution, and Environmental schemas', () => {
      expect(BudgetStoreModeSchema.safeParse('memory').success).toBe(true);
      expect(BudgetStoreModeSchema.safeParse('sqlite').success).toBe(true);
      expect(BudgetStoreModeSchema.safeParse('firestore').success).toBe(true);

      expect(
        FacilityRecordSchema.safeParse({
          id: 'gp_1',
          sourceId: 'google_places_context',
          category: 'grocery',
          name: 'Forged Place',
          lat: 30.2672,
          lng: -97.7431,
          analysisEligible: true,
        }).success
      ).toBe(false);

      expect(
        EvaluatedFacilityContributionSchema.safeParse({
          id: 'gp_1',
          sourceId: 'google_places_context',
          category: 'grocery',
          name: 'Forged Place',
          lat: 30.2672,
          lng: -97.7431,
          distanceMeters: 100,
          kernelWeight: 0.9,
        }).success
      ).toBe(false);

      expect(
        EnvironmentalRecordSchema.safeParse({
          id: 'gp_env_1',
          registryId: 'REG-1',
          sourceId: 'google_places_context',
          name: 'Forged Place Env',
          lat: 30.2672,
          lng: -97.7431,
          distanceMeters: 250,
          programs: ['TRI'],
          activePermitsOrEmissions: true,
          status: 'Active',
          isAutomaticHealthDetermination: false,
        }).success
      ).toBe(false);
    });

    it('AUDIT-05 & AUDIT-06: guards NaN gridResolution, enforces default cache synthetic gating, and scrubs URL-encoded secrets', () => {
      const center = { lat: 39.7392, lng: -104.9903 };
      const grid = computeBoundedGridOverlap(
        center,
        1200,
        [{ id: 'g1', sourceId: 'osm_overpass', category: 'grocery', name: 'Market', lat: center.lat, lng: center.lng }],
        undefined,
        { gridResolution: Number.NaN }
      );
      expect(BoundedGridOverlapResultSchema.safeParse(grid).success).toBe(true);
      expect(grid.gridResolution).toBe(11);
      // 11x11 lattice clipped to circular geodesic disk contains 81 interior/boundary cells
      expect(grid.cells).toHaveLength(81);

      const cache = new AreaGeospatialCache();
      cache.put({
        areaId: 'us-co-denver',
        spatialKey: 'live:39.7392,-104.9903:r4000',
        analysisArea: {
          areaId: 'us-co-denver',
          label: 'Denver, CO',
          centerLat: center.lat,
          centerLng: center.lng,
          radiusMeters: 1600,
          boundingBox: { minLat: 39.72, maxLat: 39.75, minLng: -105.01, maxLng: -104.97 },
          city: 'Denver',
          state: 'CO',
          zipCode: '80202',
          isUsLocation: true,
          isViewportApproximation: true,
          approximationDisclaimer: 'Circular geodesic viewport approximation.',
        },
        isSyntheticDemo: false,
        dataMode: 'live_open_data',
        influenceFetchRadiusMeters: 4000,
        eligibleFacilityCandidates: [
          {
            id: 'syn_leak',
            sourceId: 'synthetic_demo',
            category: 'grocery',
            name: 'Unrequested Synthetic',
            lat: center.lat,
            lng: center.lng,
            analysisEligible: true,
          },
          {
            id: 'gp_leak',
            sourceId: 'google_places_context',
            category: 'grocery',
            name: 'Places Context',
            lat: center.lat,
            lng: center.lng,
            analysisEligible: true,
          },
        ],
        amenities: [],
        categorySourceStatuses: { grocery: 'ok' },
        environmentalLayer: { status: 'ok', records: [], disclaimer: 'Disclaimer' },
        displayOnlyPlacesContext: [],
        fetchedAt: new Date().toISOString(),
      });
      const cached = cache.getByAreaId('us-co-denver');
      expect(cached?.eligibleFacilityCandidates).toHaveLength(0);

      const specialSecret = 'rk_live_secret+with/special=chars&token';
      const encodedSecret = encodeURIComponent(specialSecret);
      const cfg = loadServerConfig({
        NODE_ENV: 'test',
        RENTCAST_API_KEY: specialSecret,
      });
      const scrubbed = redactSecretsFromText(
        `Failed URL https://api.example.test?apiKey=${encodedSecret} raw=${specialSecret}`,
        cfg
      );
      expect(scrubbed).not.toContain(specialSecret);
      expect(scrubbed).not.toContain(encodedSecret);
      expect(scrubbed).toContain('[REDACTED]');
    });
  });
});
