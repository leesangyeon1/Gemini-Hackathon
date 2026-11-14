/**
 * Comprehensive Unit & Integration Tests for Property API, Region Resolution & Durable Budget
 * (`tests/property/property.test.ts`)
 */

import fs from 'node:fs';
import http from 'node:http';
import type { Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Duplex } from 'node:stream';
import type { Express } from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ApiErrorResponseSchema,
  PropertyAvmResponseSchema,
  PropertySearchResponseSchema,
  RegionResolveResponseSchema,
  SessionExpandResponseSchema,
} from '../../src/shared/schemas';
import type { AnalysisArea } from '../../src/shared/types';
import { createApp } from '../../src/server/app';
import { loadServerConfig } from '../../src/server/config';
import {
  BudgetStoreError,
  createBudgetStore,
  createPropertyModule,
  createRegionResolver,
  normalizeAvmResponse,
  normalizeSaleListingRecord,
  stripRentCastPii,
} from '../../src/server/property';

interface SimulatedHttpResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | number | undefined>;
  readonly text: string;
  readonly body: any;
}

/**
 * Invokes an Express `app` through Node's `http.IncomingMessage` / `http.ServerResponse`
 * over an in-memory Duplex stream so full Express middleware and routers run without TCP sockets.
 */
async function invokeExpressApp(
  app: Express,
  options: {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
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
            : Buffer.from(
                String(chunk),
                typeof encoding === 'string' ? encoding : 'utf8'
              )
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
      options.body !== undefined ? JSON.stringify(options.body) : undefined;
    const payloadBuffer =
      payloadString !== undefined
        ? Buffer.from(payloadString, 'utf8')
        : undefined;

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
      const text =
        headerSplitIdx >= 0 ? rawWire.slice(headerSplitIdx + 4) : rawWire;

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

const tempDirs: string[] = [];

function createTempSqlitePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'foreal-budget-test-'));
  tempDirs.push(dir);
  return path.join(dir, 'rentcast-budget.sqlite');
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir && fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});

const AUSTIN_AREA: AnalysisArea = {
  areaId: 'us-tx-austin',
  label: 'Austin, TX 78701',
  centerLat: 30.2672,
  centerLng: -97.7431,
  radiusMeters: 1600,
  boundingBox: {
    minLat: 30.2528,
    maxLat: 30.2816,
    minLng: -97.7598,
    maxLng: -97.7264,
  },
  city: 'Austin',
  state: 'TX',
  zipCode: '78701',
  isUsLocation: true,
  isViewportApproximation: true,
  approximationDisclaimer:
    'Circular geodesic viewport approximation — not an official municipal, school, or neighborhood boundary polygon.',
};

describe('Workstream 1: Durable Atomic RentCast Budget Store (budgetStore.ts)', () => {
  it('persists monthly and session spend across SQLite store restarts and enforces RENTCAST_INITIAL_SPENT_CALLS', async () => {
    const sqlitePath = createTempSqlitePath();
    const fixedDate = new Date('2026-11-14T08:00:00.000Z');

    // Instance 1: 10 initial spent calls, 35 global limit -> 25 remaining
    const store1 = createBudgetStore({
      mode: 'sqlite',
      sqlitePath,
      globalMonthlyLimit: 35,
      initialSpentCalls: 10,
      nowFn: () => fixedDate,
    });

    const initialSnap = await store1.getSnapshot('sess_persist_01');
    expect(initialSnap.billingMonth).toBe('2026-11');
    expect(initialSnap.globalMonthlyLimit).toBe(35);
    expect(initialSnap.initialSpentCalls).toBe(10);
    expect(initialSnap.runtimeSpentCalls).toBe(0);
    expect(initialSnap.totalSpentCalls).toBe(10);
    expect(initialSnap.globalRemaining).toBe(25);

    // Spend 1 listings call + 2 AVM calls on store1
    await store1.reserveListingsCall('sess_persist_01', 'client-a');
    await store1.reserveAvmCall('sess_persist_01', 'client-a');
    const afterThree = await store1.reserveAvmCall('sess_persist_01', 'client-a');

    expect(afterThree.runtimeSpentCalls).toBe(3);
    expect(afterThree.totalSpentCalls).toBe(13);
    expect(afterThree.globalRemaining).toBe(22);
    expect(afterThree.sessionListingsUsed).toBe(1);
    expect(afterThree.sessionAvmsUsed).toBe(2);
    store1.close();

    // Instance 2: Simulate container/process restart reading the same SQLite file
    const store2 = createBudgetStore({
      mode: 'sqlite',
      sqlitePath,
      globalMonthlyLimit: 35,
      initialSpentCalls: 10,
      nowFn: () => fixedDate,
    });

    const restartedSnap = await store2.getSnapshot('sess_persist_01');
    expect(restartedSnap.runtimeSpentCalls).toBe(3);
    expect(restartedSnap.totalSpentCalls).toBe(13);
    expect(restartedSnap.globalRemaining).toBe(22);
    expect(restartedSnap.sessionListingsUsed).toBe(1);
    expect(restartedSnap.sessionAvmsUsed).toBe(2);
    store2.close();
  });

  it('enforces bounded session caps (1 listings + 5 AVMs = 6 default; 10 AVMs + 1 property record = 12 expanded) and global <50 cap', async () => {
    const store = createBudgetStore({
      mode: 'memory',
      globalMonthlyLimit: 99, // Should clamp to 49 (< 50 free tier)
      initialSpentCalls: 0,
    });

    const snap0 = await store.getSnapshot('sess_caps_001');
    expect(snap0.globalMonthlyLimit).toBe(49);
    expect(snap0.sessionListingsLimit).toBe(1);
    expect(snap0.sessionAvmsLimit).toBe(5);
    expect(snap0.sessionPropertyRecordsLimit).toBe(0);

    // 1st listings call succeeds; 2nd listings call in same session is blocked
    await store.reserveListingsCall('sess_caps_001');
    await expect(store.reserveListingsCall('sess_caps_001')).rejects.toMatchObject({
      code: 'SESSION_CAP_REACHED',
      statusCode: 429,
    });

    // Property record lookup blocked before expansion
    await expect(
      store.reservePropertyRecordCall('sess_caps_001')
    ).rejects.toMatchObject({
      code: 'SESSION_CAP_REACHED',
      statusCode: 429,
    });

    // 5 AVM calls succeed; 6th AVM call blocked until explicit expansion
    for (let i = 0; i < 5; i += 1) {
      await store.reserveAvmCall('sess_caps_001');
    }
    await expect(store.reserveAvmCall('sess_caps_001')).rejects.toMatchObject({
      code: 'SESSION_CAP_REACHED',
      statusCode: 429,
      retryable: true,
    });

    // Explicit expansion requires userConfirmed === true
    await expect(store.expandSession('sess_caps_001', false)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      statusCode: 400,
    });

    const expandedSnap = await store.expandSession('sess_caps_001', true);
    expect(expandedSnap.sessionExpanded).toBe(true);
    expect(expandedSnap.sessionAvmsLimit).toBe(10);
    expect(expandedSnap.sessionPropertyRecordsLimit).toBe(1);

    // Now 5 more AVM calls (total 10) + 1 property record call succeed (= 12 total session calls)
    for (let i = 0; i < 5; i += 1) {
      await store.reserveAvmCall('sess_caps_001');
    }
    await expect(store.reserveAvmCall('sess_caps_001')).rejects.toMatchObject({
      code: 'SESSION_CAP_REACHED',
      statusCode: 429,
      retryable: false,
    });

    const afterPropRec = await store.reservePropertyRecordCall('sess_caps_001');
    expect(afterPropRec.sessionPropertyRecordsUsed).toBe(1);
    expect(afterPropRec.totalSpentCalls).toBe(12);

    await expect(
      store.reservePropertyRecordCall('sess_caps_001')
    ).rejects.toMatchObject({
      code: 'SESSION_CAP_REACHED',
      statusCode: 429,
    });

    store.close();
  });

  it('blocks calls when global monthly quota is exhausted or per-client rate limit is exceeded', async () => {
    const exhaustedStore = createBudgetStore({
      mode: 'memory',
      globalMonthlyLimit: 35,
      initialSpentCalls: 34,
    });

    // 35th call succeeds
    const lastCall = await exhaustedStore.reserveListingsCall('sess_exhaust_1');
    expect(lastCall.globalRemaining).toBe(0);
    expect(lastCall.quotaExhausted).toBe(true);

    // 36th call rejected with GLOBAL_QUOTA_EXHAUSTED
    await expect(
      exhaustedStore.reserveAvmCall('sess_exhaust_1')
    ).rejects.toMatchObject({
      code: 'GLOBAL_QUOTA_EXHAUSTED',
      statusCode: 429,
      retryable: false,
    });
    exhaustedStore.close();

    // Per-client rate limit check
    const rateStore = createBudgetStore({
      mode: 'memory',
      globalMonthlyLimit: 35,
      maxClientCallsPerWindow: 2,
      clientWindowMs: 60_000,
    });
    await rateStore.reserveAvmCall('sess_rate_1', 'ip-1.2.3.4');
    await rateStore.reserveAvmCall('sess_rate_1', 'ip-1.2.3.4');
    await expect(
      rateStore.reserveAvmCall('sess_rate_1', 'ip-1.2.3.4')
    ).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      statusCode: 429,
      retryable: true,
    });
    rateStore.close();
  });

  it('supports Cloud Firestore REST atomic transactions and fails closed when unavailable', async () => {
    // Missing GOOGLE_CLOUD_PROJECT fails closed
    const unconfiguredFirestore = createBudgetStore({
      mode: 'firestore',
      googleCloudProject: null,
    });
    await expect(
      unconfiguredFirestore.getSnapshot('sess_fs_1')
    ).rejects.toBeInstanceOf(BudgetStoreError);

    // Mock Firestore REST GET + atomic commit
    let storedRuntimeCalls = 4;
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith(':commit') && init?.method === 'POST') {
        storedRuntimeCalls += 1;
        return new Response(JSON.stringify({ writeResults: [{}] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          name: 'projects/demo-proj/databases/(default)/documents/rentcast_budget/2026-11',
          updateTime: '2026-11-14T07:00:00.000000Z',
          fields: {
            runtimeSpentCalls: { integerValue: String(storedRuntimeCalls) },
            sessions: { mapValue: { fields: {} } },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const firestoreStore = createBudgetStore({
      mode: 'firestore',
      googleCloudProject: 'demo-proj',
      firestoreAccessTokenProvider: async () => 'mock-oauth-token',
      fetchFn: mockFetch,
      globalMonthlyLimit: 35,
      initialSpentCalls: 5,
      nowFn: () => new Date('2026-11-14T08:00:00.000Z'),
    });

    const snap = await firestoreStore.reserveListingsCall('sess_fs_ok');
    expect(snap.durabilityMode).toBe('firestore');
    expect(snap.runtimeSpentCalls).toBe(5);
    expect(snap.totalSpentCalls).toBe(10);
    expect(snap.globalRemaining).toBe(25);
  });

  it('caches Cloud Run metadata-server OAuth tokens and retries optimistic concurrency conflicts (HTTP 409) in Firestore mode', async () => {
    let metadataTokenFetches = 0;
    let commitAttempts = 0;
    let docRuntimeCalls = 2;
    let docUpdateTime = '2026-11-14T08:00:00.000000Z';

    const mockCloudRunFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.includes('metadata.google.internal')) {
        metadataTokenFetches += 1;
        const headers = new Headers(init?.headers);
        expect(headers.get('Metadata-Flavor')).toBe('Google');
        return new Response(
          JSON.stringify({
            access_token: 'ya29.mock_cloud_run_sa_token',
            expires_in: 3600,
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.endsWith(':commit') && init?.method === 'POST') {
        commitAttempts += 1;
        // Simulate a concurrent Cloud Run instance winning the first write (409 ABORTED)
        if (commitAttempts === 1) {
          docRuntimeCalls = 3;
          docUpdateTime = '2026-11-14T08:00:01.000000Z';
          return new Response(
            JSON.stringify({
              error: { code: 409, status: 'ABORTED', message: 'Precondition failed' },
            }),
            { status: 409, headers: { 'Content-Type': 'application/json' } }
          );
        }
        docRuntimeCalls += 1;
        docUpdateTime = '2026-11-14T08:00:02.000000Z';
        return new Response(JSON.stringify({ writeResults: [{}] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(
        JSON.stringify({
          name: 'projects/cloudrun-proj/databases/(default)/documents/rentcast_budget/2026-11',
          updateTime: docUpdateTime,
          fields: {
            runtimeSpentCalls: { integerValue: String(docRuntimeCalls) },
            sessions: { mapValue: { fields: {} } },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };

    const cloudRunStore = createBudgetStore({
      mode: 'firestore',
      googleCloudProject: 'cloudrun-proj',
      fetchFn: mockCloudRunFetch,
      globalMonthlyLimit: 35,
      initialSpentCalls: 1,
      nowFn: () => new Date('2026-11-14T08:05:00.000Z'),
    });

    // First call triggers metadata token fetch + 1st commit (409 conflict) + re-read + 2nd commit (200 OK)
    const snap1 = await cloudRunStore.reserveAvmCall('sess_cr_1', 'client-cr');
    expect(commitAttempts).toBe(2);
    expect(metadataTokenFetches).toBe(1);
    expect(snap1.runtimeSpentCalls).toBe(4);
    expect(snap1.totalSpentCalls).toBe(5);

    // Second operation reuses cached Cloud Run metadata token without re-fetching metadata.google.internal
    const snap2 = await cloudRunStore.getSnapshot('sess_cr_1');
    expect(metadataTokenFetches).toBe(1);
    expect(snap2.runtimeSpentCalls).toBe(4);
  });
});

describe('Workstream 1: US Region Resolver & Disambiguation (regionResolver.ts)', () => {
  const resolver = createRegionResolver({ enableExternalGeocoders: false });

  it('resolves diverse US cities, neighborhoods, and 5-digit ZIP codes without hardcoding Berkeley', async () => {
    const austin = await resolver.resolveRegion({
      query: 'Austin, TX',
      clientRequestSeq: 11,
    });
    expect(austin.status).toBe('resolved');
    expect(austin.selectedArea?.city).toBe('Austin');
    expect(austin.selectedArea?.state).toBe('TX');
    expect(austin.selectedArea?.isViewportApproximation).toBe(true);
    expect(austin.clientRequestSeq).toBe(11);

    const ballard = await resolver.resolveRegion({
      query: 'Ballard, Seattle, WA',
      preferredRadiusMeters: 1800,
    });
    expect(ballard.status).toBe('resolved');
    expect(ballard.selectedArea?.city).toBe('Seattle');
    expect(ballard.selectedArea?.state).toBe('WA');
    expect(ballard.selectedArea?.radiusMeters).toBe(1800);

    const chicagoZip = await resolver.resolveRegion({
      query: '60614',
    });
    expect(chicagoZip.status).toBe('resolved');
    expect(chicagoZip.selectedArea?.state).toBe('IL');
    expect(chicagoZip.selectedArea?.zipCode).toBe('60614');
  });

  it('flags ambiguous multi-state US city queries ("Springfield", "Portland") for user confirmation', async () => {
    const springfield = await resolver.resolveRegion({ query: 'Springfield' });
    expect(springfield.status).toBe('ambiguous');
    expect(springfield.selectedArea).toBeNull();
    expect(springfield.candidates.length).toBeGreaterThanOrEqual(3);
    const states = new Set(springfield.candidates.map((c) => c.state));
    expect(states.has('IL')).toBe(true);
    expect(states.has('MO')).toBe(true);
    expect(states.has('MA')).toBe(true);

    // Specifying the state resolves the ambiguity
    const springfieldIl = await resolver.resolveRegion({
      query: 'Springfield, IL',
    });
    expect(springfieldIl.status).toBe('resolved');
    expect(springfieldIl.selectedArea?.state).toBe('IL');
  });

  it('rejects non-US queries and non-US coordinates with unsupported_area', async () => {
    const london = await resolver.resolveRegion({ query: 'London, UK' });
    expect(london.status).toBe('unsupported_area');
    expect(london.selectedArea).toBeNull();

    const torontoBounds = await resolver.resolveRegion({
      bounds: { centerLat: 43.6532, centerLng: -79.3832, radiusMeters: 1500 },
    });
    expect(torontoBounds.status).toBe('unsupported_area');
    expect(torontoBounds.selectedArea).toBeNull();

    const londonBounds = await resolver.resolveRegion({
      bounds: { centerLat: 51.5074, centerLng: -0.1278, radiusMeters: 1500 },
    });
    expect(londonBounds.status).toBe('unsupported_area');
  });
});

describe('Workstream 1: RentCast Schema Hygiene, PII Stripping & Subject-in-Comps Detection', () => {
  it('strips owner/agent/broker PII and preserves distinct askingPrice, avmPrice, lastSalePrice, and assessedValue', () => {
    const rawListing: Record<string, unknown> = {
      id: 'prop-austin-100',
      formattedAddress: '100 Congress Ave, Austin, TX 78701',
      city: 'Austin',
      state: 'TX',
      zipCode: '78701',
      latitude: 30.2638,
      longitude: -97.7434,
      propertyType: 'Single Family',
      bedrooms: 4,
      bathrooms: 3,
      squareFootage: 2450,
      lotSize: 6000,
      yearBuilt: 2014,
      price: 900_000,
      lastSeenDate: '2026-11-12T15:30:00.000Z',
      lastSalePrice: 710_000,
      lastSaleDate: '2020-05-19T00:00:00.000Z',
      taxAssessments: {
        '2023': { year: 2023, value: 780_000 },
        '2024': { year: 2024, value: 825_000 },
      },
      owner: {
        names: ['Jane Doe', 'John Doe'],
        mailingAddress: '999 Private Ln, Austin, TX 78701',
        ownerOccupied: true,
      },
      agent: {
        name: 'Agent Smith',
        phone: '512-555-0199',
        email: 'agent@example.com',
      },
    };

    const stripped = stripRentCastPii(rawListing);
    expect(stripped).not.toHaveProperty('owner');
    expect(stripped).not.toHaveProperty('agent');

    const listing = normalizeSaleListingRecord(rawListing);
    expect(listing).not.toBeNull();
    expect(listing!.askingPrice).toBe(900_000);
    expect(listing!.listingLastSeenAt).toBe('2026-11-12T15:30:00.000Z');
    expect(listing!.avmPrice).toBeNull();
    expect(listing!.lastSalePrice).toBe(710_000);
    expect(listing!.lastSaleDate).toBe('2020-05-19T00:00:00.000Z');
    expect(listing!.assessedValue).toBe(825_000);
    expect(listing!.assessedYear).toBe(2024);
    expect(listing!.priceGap.rangePosition).toBe('no_avm');

    // Now normalize AVM response with canonical 1M / 900k / [850k, 1.15M] AND subject duplicated in comps
    const detail = normalizeAvmResponse({
      subject: listing!,
      rawAvmPayload: {
        price: 1_000_000,
        priceRangeLow: 850_000,
        priceRangeHigh: 1_150_000,
        comparables: [
          {
            id: 'prop-austin-100',
            formattedAddress: '100 Congress Avenue, Austin, TX 78701',
            price: 900_000,
            status: 'Active',
            lastSeenDate: '2026-11-12T15:30:00.000Z',
            distance: 0.0,
            correlation: 1.0,
            daysOld: 2,
          },
          {
            id: 'comp-austin-200',
            formattedAddress: '204 Lavaca St, Austin, TX 78701',
            price: 1_020_000,
            status: 'Active',
            lastSeenDate: '2026-11-10T10:00:00.000Z',
            distance: 0.35,
            correlation: 0.94,
            daysOld: 12,
          },
        ],
      },
      fetchedAt: '2026-11-14T08:10:00.000Z',
    });

    expect(detail.askingPrice).toBe(900_000);
    expect(detail.avmPrice).toBe(1_000_000);
    expect(detail.avmLow).toBe(850_000);
    expect(detail.avmHigh).toBe(1_150_000);
    expect(detail.lastSalePrice).toBe(710_000);
    expect(detail.assessedValue).toBe(825_000);
    expect(detail.priceGap.gapPct).toBe(10);
    expect(detail.priceGap.rangePosition).toBe('in_range');
    expect(detail.priceGap.isProvenUndervaluation).toBe(false);
    expect(detail.comparablesSummary?.subjectIncludedInComps).toBe(true);

    const evidenceCodes = detail.contraryEvidence.map((e) => e.code);
    expect(evidenceCodes).toContain('asking_inside_avm_range');
    expect(evidenceCodes).toContain('subject_included_in_comps');
    expect(evidenceCodes).toContain('avm_methodology_limitation');
  });
});

describe('Workstream 1: Express Property, Region & Session Endpoints', () => {
  it('returns clean 503 SETUP_NEEDED when RENTCAST_API_KEY is missing and supports opt-in badged Synthetic Demo mode', async () => {
    const config = loadServerConfig({
      NODE_ENV: 'test',
      ENABLE_SYNTHETIC_DEMO_MODE: 'true',
      RENTCAST_GLOBAL_MONTHLY_LIMIT: '35',
    });
    const propModule = createPropertyModule(config, {
      budgetStoreOptions: { mode: 'memory' },
      regionResolverOptions: { enableExternalGeocoders: false },
    });
    const app = createApp({
      config,
      regionsRouter: propModule.regionsRouter,
      propertiesRouter: propModule.propertiesRouter,
      sessionsRouter: propModule.sessionsRouter,
    });

    // 1. Live search without RENTCAST_API_KEY returns 503 SETUP_NEEDED with missingEnvVarNames
    const liveRes = await invokeExpressApp(app, {
      method: 'POST',
      url: '/api/properties/search',
      body: {
        analysisArea: AUSTIN_AREA,
        useSyntheticDemo: false,
        clientRequestSeq: 3,
      },
    });
    expect(liveRes.status).toBe(503);
    const parsedErr = ApiErrorResponseSchema.parse(liveRes.body);
    expect(parsedErr.error.code).toBe('SETUP_NEEDED');
    expect(parsedErr.error.uiState).toBe('setup_needed');
    expect(parsedErr.error.missingEnvVarNames).toContain('RENTCAST_API_KEY');
    expect(parsedErr.clientRequestSeq).toBe(3);

    // 2. Opt-in Synthetic Demo search succeeds with badged listings anchored around Austin, TX
    const synSearchRes = await invokeExpressApp(app, {
      method: 'POST',
      url: '/api/properties/search',
      body: {
        analysisArea: AUSTIN_AREA,
        useSyntheticDemo: true,
        limit: 6,
        clientRequestSeq: 4,
      },
    });
    expect(synSearchRes.status).toBe(200);
    const parsedSearch = PropertySearchResponseSchema.parse(synSearchRes.body);
    expect(parsedSearch.uiState).toBe('synthetic_demo');
    expect(parsedSearch.isSyntheticDemo).toBe(true);
    expect(parsedSearch.listings.length).toBe(6);
    expect(parsedSearch.listings[0]!.city).toBe('Austin');
    expect(parsedSearch.listings[0]!.avmPrice).toBeNull();
    expect(parsedSearch.budget.runtimeSpentCalls).toBe(0);

    // 3. On-demand Synthetic Demo AVM populates valuation without spending live RentCast quota
    const targetId = parsedSearch.listings[1]!.id;
    const synAvmRes = await invokeExpressApp(app, {
      method: 'POST',
      url: `/api/properties/${encodeURIComponent(targetId)}/avm`,
      body: {
        sessionId: parsedSearch.sessionId,
        useSyntheticDemo: true,
        clientRequestSeq: 5,
      },
    });
    expect(synAvmRes.status).toBe(200);
    const parsedAvm = PropertyAvmResponseSchema.parse(synAvmRes.body);
    expect(parsedAvm.isSyntheticDemo).toBe(true);
    expect(parsedAvm.property.askingPrice).toBe(900_000);
    expect(parsedAvm.property.avmPrice).toBe(1_000_000);
    expect(parsedAvm.property.priceGap.gapPct).toBe(10);
    expect(parsedAvm.property.priceGap.rangePosition).toBe('in_range');
    expect(parsedAvm.budget.runtimeSpentCalls).toBe(0);
  });

  it('executes live RentCast search + on-demand AVM, caches repeat clicks, and sanitizes 401/429/timeout errors without leaking secrets', async () => {
    const fakeSecretKey = 'rc_live_SUPER_SECRET_KEY_9999';
    let upstreamMode: 'ok' | '401' | '429' | 'timeout' = 'ok';
    let upstreamCallCount = 0;

    const mockFetch: typeof fetch = async (input) => {
      upstreamCallCount += 1;
      const url = String(input);

      if (upstreamMode === '401') {
        return new Response(
          JSON.stringify({ message: `Unauthorized key ${fakeSecretKey}` }),
          { status: 401 }
        );
      }
      if (upstreamMode === '429') {
        return new Response(JSON.stringify({ message: 'Too Many Requests' }), {
          status: 429,
        });
      }
      if (upstreamMode === 'timeout') {
        const timeoutErr = new Error('The operation was aborted due to timeout');
        timeoutErr.name = 'TimeoutError';
        throw timeoutErr;
      }

      if (url.includes('/listings/sale')) {
        return new Response(
          JSON.stringify([
            {
              id: 'rc-austin-live-1',
              formattedAddress: '500 W 2nd St, Austin, TX 78701',
              city: 'Austin',
              state: 'TX',
              zipCode: '78701',
              latitude: 30.2655,
              longitude: -97.749,
              propertyType: 'Condo',
              bedrooms: 2,
              bathrooms: 2,
              squareFootage: 1450,
              yearBuilt: 2018,
              price: 450_000,
              lastSeenDate: '2026-11-13T10:00:00.000Z',
              owner: { names: ['Hidden Owner'] },
              agent: { phone: '512-000-0000' },
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      if (url.includes('/avm/value')) {
        return new Response(
          JSON.stringify({
            price: 500_000,
            priceRangeLow: 465_000,
            priceRangeHigh: 535_000,
            subjectProperty: {
              lastSalePrice: 390_000,
              lastSaleDate: '2021-03-10T00:00:00.000Z',
              taxAssessments: {
                '2025': { year: 2025, value: 430_000 },
              },
            },
            comparables: [
              {
                id: 'comp-1',
                formattedAddress: '502 W 2nd St, Austin, TX 78701',
                price: 498_000,
                status: 'Active',
                lastSeenDate: '2026-11-11T00:00:00.000Z',
                distance: 0.12,
                correlation: 0.97,
                daysOld: 8,
              },
            ],
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response('[]', { status: 200 });
    };

    const config = loadServerConfig({
      NODE_ENV: 'test',
      RENTCAST_API_KEY: fakeSecretKey,
      RENTCAST_GLOBAL_MONTHLY_LIMIT: '35',
      RENTCAST_INITIAL_SPENT_CALLS: '2',
    });
    const propModule = createPropertyModule(config, {
      fetchFn: mockFetch,
      budgetStoreOptions: { mode: 'memory' },
      regionResolverOptions: { enableExternalGeocoders: false },
    });
    const app = createApp({
      config,
      regionsRouter: propModule.regionsRouter,
      propertiesRouter: propModule.propertiesRouter,
      sessionsRouter: propModule.sessionsRouter,
    });

    // 1. Resolve region
    const resolveRes = await invokeExpressApp(app, {
      method: 'POST',
      url: '/api/regions/resolve',
      body: { query: 'Austin, TX', clientRequestSeq: 1 },
    });
    expect(resolveRes.status).toBe(200);
    const resolvedRegion = RegionResolveResponseSchema.parse(resolveRes.body);
    expect(resolvedRegion.status).toBe('resolved');

    // 2. Search properties (1 listings call -> runtimeSpentCalls = 1, totalSpentCalls = 3)
    const searchRes = await invokeExpressApp(app, {
      method: 'POST',
      url: '/api/properties/search',
      body: {
        analysisArea: resolvedRegion.selectedArea,
        limit: 10,
        clientRequestSeq: 2,
      },
    });
    expect(searchRes.status).toBe(200);
    const searchData = PropertySearchResponseSchema.parse(searchRes.body);
    expect(searchData.listings).toHaveLength(1);
    expect(searchData.listings[0]!.askingPrice).toBe(450_000);
    expect(searchData.listings[0]!.avmPrice).toBeNull();
    expect(searchData.budget.runtimeSpentCalls).toBe(1);
    expect(searchData.budget.totalSpentCalls).toBe(3);
    expect(JSON.stringify(searchRes.body)).not.toContain('Hidden Owner');
    expect(JSON.stringify(searchRes.body)).not.toContain(fakeSecretKey);

    // 3. On-demand AVM (1 AVM call -> runtimeSpentCalls = 2, totalSpentCalls = 4)
    const avmRes1 = await invokeExpressApp(app, {
      method: 'POST',
      url: '/api/properties/rc-austin-live-1/avm',
      body: {
        sessionId: searchData.sessionId,
        clientRequestSeq: 3,
      },
    });
    expect(avmRes1.status).toBe(200);
    const avmData1 = PropertyAvmResponseSchema.parse(avmRes1.body);
    expect(avmData1.fromCache).toBe(false);
    expect(avmData1.property.askingPrice).toBe(450_000);
    expect(avmData1.property.avmPrice).toBe(500_000);
    expect(avmData1.property.priceGap.gapPct).toBe(10);
    expect(avmData1.property.priceGap.rangePosition).toBe(
      'below_estimate_range_candidate'
    );
    expect(avmData1.property.lastSalePrice).toBe(390_000);
    expect(avmData1.property.assessedValue).toBe(430_000);
    expect(avmData1.budget.runtimeSpentCalls).toBe(2);

    // 4. Repeat click on same property returns fromCache: true with 0 additional calls!
    const callsBeforeRepeat = upstreamCallCount;
    const avmRes2 = await invokeExpressApp(app, {
      method: 'POST',
      url: '/api/properties/rc-austin-live-1/avm',
      body: {
        sessionId: searchData.sessionId,
        clientRequestSeq: 4,
      },
    });
    expect(avmRes2.status).toBe(200);
    expect(avmRes2.body.fromCache).toBe(true);
    expect(avmRes2.body.budget.runtimeSpentCalls).toBe(2);
    expect(upstreamCallCount).toBe(callsBeforeRepeat);

    // 5. Session expansion endpoint
    const expandRes = await invokeExpressApp(app, {
      method: 'POST',
      url: `/api/sessions/${searchData.sessionId}/expand`,
      body: { userConfirmed: true, clientRequestSeq: 5 },
    });
    expect(expandRes.status).toBe(200);
    const expandData = SessionExpandResponseSchema.parse(expandRes.body);
    expect(expandData.expanded).toBe(true);
    expect(expandData.budget.sessionAvmsLimit).toBe(10);

    // 6. Test 401, 429, and timeout handling on uncached property snapshots
    upstreamMode = '401';
    const err401 = await invokeExpressApp(app, {
      method: 'POST',
      url: '/api/properties/rc-austin-live-401/avm',
      body: {
        sessionId: searchData.sessionId,
        propertySnapshot: {
          formattedAddress: '401 Congress Ave, Austin, TX 78701',
          latitude: 30.265,
          longitude: -97.743,
          askingPrice: 500_000,
        },
      },
    });
    expect(err401.status).toBe(502);
    expect(err401.body.error.code).toBe('PROVIDER_ERROR');
    expect(JSON.stringify(err401.body)).not.toContain(fakeSecretKey);

    upstreamMode = '429';
    const err429 = await invokeExpressApp(app, {
      method: 'POST',
      url: '/api/properties/rc-austin-live-429/avm',
      body: {
        sessionId: searchData.sessionId,
        propertySnapshot: {
          formattedAddress: '429 Congress Ave, Austin, TX 78701',
          latitude: 30.265,
          longitude: -97.743,
          askingPrice: 500_000,
        },
      },
    });
    expect(err429.status).toBe(429);
    expect(err429.body.error.code).toBe('RATE_LIMITED');

    upstreamMode = 'timeout';
    const errTimeout = await invokeExpressApp(app, {
      method: 'POST',
      url: '/api/properties/rc-austin-live-timeout/avm',
      body: {
        sessionId: searchData.sessionId,
        propertySnapshot: {
          formattedAddress: '504 Congress Ave, Austin, TX 78701',
          latitude: 30.265,
          longitude: -97.743,
          askingPrice: 500_000,
        },
      },
    });
    expect(errTimeout.status).toBe(504);
    expect(errTimeout.body.error.code).toBe('UPSTREAM_TIMEOUT');
  });
});
