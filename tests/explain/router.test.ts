import type { Router } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { loadServerConfig } from '../../src/server/config';
import { createExplainModule } from '../../src/server/explain';
import { createDefaultPreferenceProfile } from '../../src/shared/schemas';
import type { PropertyDetailRecord } from '../../src/shared/types';

describe('explain/router HTTP API', () => {
  const config = loadServerConfig({
    NODE_ENV: 'test',
    GEMINI_API_KEY: '', // Test deterministic fallback
  });

  const baseProperty: PropertyDetailRecord = {
    id: 'prop_http_01',
    dataProvenance: 'rentcast_live',
    formattedAddress: '500 Pine St, Seattle, WA 98101',
    city: 'Seattle',
    state: 'WA',
    zipCode: '98101',
    latitude: 47.6115,
    longitude: -122.337,
    propertyType: 'Condo',
    bedrooms: 1,
    bathrooms: 1,
    squareFootage: 750,
    lotSize: null,
    yearBuilt: 2012,
    askingPrice: 500000,
    listingLastSeenAt: '2026-11-13T00:00:00.000Z',
    avmPrice: 520000,
    avmLow: 470000,
    avmHigh: 570000,
    avmFetchedAt: '2026-11-14T00:00:00.000Z',
    lastSalePrice: 420000,
    lastSaleDate: '2017-04-10',
    assessedValue: 490000,
    assessedYear: 2025,
    comparablesSummary: null,
    priceGap: {
      gapPct: 3.8,
      gapAmountUsd: 20000,
      rangePosition: 'in_range',
      askingPrice: 500000,
      avmPrice: 520000,
      avmLow: 470000,
      avmHigh: 570000,
      isWithinEstimateRange: true,
      isProvenUndervaluation: false,
      interpretationNote: 'In range',
    },
    accessibility: null,
    nearbyEnvironmentalCount: 0,
    contraryEvidence: [],
  };

  /**
   * In-memory dispatcher testing the Express router without opening network sockets,
   * fully compatible with secure sandboxed environments.
   */
  function dispatchRequest(
    router: Router,
    method: string,
    url: string,
    body?: unknown
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve) => {
      let statusCode = 200;
      let responseBody: any = null;

      const req: any = {
        method,
        url,
        originalUrl: url,
        path: url,
        body,
        headers: { 'content-type': 'application/json' },
      };

      const res: any = {
        status(code: number) {
          statusCode = code;
          return res;
        },
        json(data: any) {
          responseBody = data;
          resolve({ status: statusCode, body: responseBody });
          return res;
        },
        setHeader() {
          return res;
        },
      };

      router(req, res, (err?: any) => {
        if (err) {
          resolve({ status: 500, body: { error: err.message } });
        } else {
          resolve({ status: 404, body: { notFound: true } });
        }
      });
    });
  }

  it('POST /api/explain returns 200 OK with valid ExplainResponse and preserved clientRequestSeq', async () => {
    const { explainRouter } = createExplainModule(config);

    const response = await dispatchRequest(explainRouter, 'POST', '/', {
      sessionId: 'sess_test_123',
      propertyId: 'prop_http_01',
      preferences: createDefaultPreferenceProfile(),
      propertyContext: baseProperty,
      clientRequestSeq: 42,
    });

    expect(response.status).toBe(200);
    expect(response.body.explanationAvailable).toBe(false);
    expect(response.body.fallbackUsed).toBe(true);
    expect(response.body.clientRequestSeq).toBe(42);
    expect(response.body.summary).toContain('500 Pine St');
    expect(Array.isArray(response.body.evidenceCatalog)).toBe(true);
  });

  it('POST /api/explain returns 400 Bad Request on malformed payload', async () => {
    const { explainRouter } = createExplainModule(config);

    const response = await dispatchRequest(explainRouter, 'POST', '/', {
      sessionId: '', // invalid empty session id
      propertyId: 'prop_http_01',
      clientRequestSeq: 101,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.clientRequestSeq).toBe(101);
  });

  it('POST /api/explain suppresses invalid negative/float clientRequestSeq on 400 error', async () => {
    const { explainRouter } = createExplainModule(config);

    const response = await dispatchRequest(explainRouter, 'POST', '/', {
      sessionId: '', // invalid empty session id
      propertyId: 'prop_http_01',
      clientRequestSeq: -5,
    });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
    expect(response.body.clientRequestSeq).toBeUndefined();
  });

  it('POST /api/explain returns 404 Not Found when server resolver cannot find property', async () => {
    const resolvePropertyContext = vi.fn().mockResolvedValue(null);
    const { explainRouter } = createExplainModule(config, { resolvePropertyContext });

    const response = await dispatchRequest(explainRouter, 'POST', '/', {
      sessionId: 'sess_test_123',
      propertyId: 'prop_nonexistent_999',
      preferences: createDefaultPreferenceProfile(),
      clientRequestSeq: 88,
    });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
    expect(response.body.error.message).toContain('prop_nonexistent_999');
    expect(response.body.clientRequestSeq).toBe(88);
  });
});
