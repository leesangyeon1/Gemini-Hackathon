import { describe, expect, it, vi } from 'vitest';
import { loadServerConfig } from '../../src/server/config';
import { createExplainService } from '../../src/server/explain/explainService';
import { createDefaultPreferenceProfile } from '../../src/shared/schemas';
import type { ExplainRequest, PropertyDetailRecord } from '../../src/shared/types';

describe('explain/explainService', () => {
  const baseProperty: PropertyDetailRecord = {
    id: 'prop_service_01',
    dataProvenance: 'rentcast_live',
    formattedAddress: '100 University Ave, Berkeley, CA 94720',
    city: 'Berkeley',
    state: 'CA',
    zipCode: '94720',
    latitude: 37.8719,
    longitude: -122.2585,
    propertyType: 'Condo',
    bedrooms: 2,
    bathrooms: 2,
    squareFootage: 1100,
    lotSize: null,
    yearBuilt: 2005,
    askingPrice: 750000,
    listingLastSeenAt: '2026-11-13T00:00:00.000Z',
    avmPrice: 800000,
    avmLow: 720000,
    avmHigh: 880000,
    avmFetchedAt: '2026-11-14T00:00:00.000Z',
    lastSalePrice: 620000,
    lastSaleDate: '2018-09-10',
    assessedValue: 710000,
    assessedYear: 2025,
    comparablesSummary: null,
    priceGap: {
      gapPct: 6.3,
      gapAmountUsd: 50000,
      rangePosition: 'in_range',
      askingPrice: 750000,
      avmPrice: 800000,
      avmLow: 720000,
      avmHigh: 880000,
      isWithinEstimateRange: true,
      isProvenUndervaluation: false,
      interpretationNote: 'In range',
    },
    accessibility: null,
    nearbyEnvironmentalCount: 0,
    contraryEvidence: [],
  };

  const sampleRequest: ExplainRequest = {
    sessionId: 'sess_test_123',
    propertyId: 'prop_service_01',
    preferences: createDefaultPreferenceProfile(),
    propertyContext: baseProperty,
  };

  it('gracefully degrades to deterministic summary when GEMINI_API_KEY is not configured', async () => {
    const config = loadServerConfig({
      NODE_ENV: 'test',
      GEMINI_API_KEY: '', // Missing key
    });

    const service = createExplainService(config);
    const result = await service.explainProperty(sampleRequest);

    expect(result).not.toBeNull();
    expect(result?.explanationAvailable).toBe(false);
    expect(result?.fallbackUsed).toBe(true);
    expect(result?.modelUsed).toBeNull();
    expect(result?.unavailableReason).toContain('GEMINI_API_KEY is not configured');
    expect(result?.summary).toContain('100 University Ave');
    expect(result?.summary).toContain('$750,000');
    expect(result?.evidenceCatalog.length).toBeGreaterThan(0);
    expect(result?.limitations.length).toBeGreaterThan(0);
  });

  it('invokes primary model with thinkingConfig and returns validated grounded explanation', async () => {
    const config = loadServerConfig({
      NODE_ENV: 'test',
      GEMINI_API_KEY: 'test-gemini-key',
      GEMINI_EXPLAIN_MODEL: 'gemini-4-hydrogen',
    });

    const mockAiClient = {
      models: {
        generateContent: vi.fn().mockResolvedValue({
          text: JSON.stringify({
            summary:
              '100 University Ave is listed at $750,000, which is 6.3% below the RentCast AVM midpoint of $800,000. The asking price is within the statistical confidence range ($720,000 to $880,000).',
            evidenceIds: ['ev_prop_pricing', 'ev_prop_range'],
            positiveFactors: ['Asking price is moderately below the point estimate.'],
            contraryAndUncertaintyFactors: [
              'Asking price falls inside the statistical range, indicating normal valuation dispersion.',
            ],
            limitations: ['AVM is an automated statistical model, not a physical appraisal.'],
          }),
        }),
      },
    };

    const service = createExplainService(config, { aiClient: mockAiClient });
    const result = await service.explainProperty(sampleRequest);

    expect(result?.explanationAvailable).toBe(true);
    expect(result?.fallbackUsed).toBe(false);
    expect(result?.modelUsed).toBe('gemini-4-hydrogen');
    expect(result?.summary).toContain('100 University Ave');
    expect(result?.evidenceIds).toEqual(['ev_prop_pricing', 'ev_prop_range']);

    expect(mockAiClient.models.generateContent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gemini-4-hydrogen',
        config: expect.objectContaining({
          responseMimeType: 'application/json',
          thinkingConfig: { thinkingBudget: 1024 },
        }),
      })
    );
  });

  it('falls back to secondary flash model when primary model rejects or fails', async () => {
    const config = loadServerConfig({
      NODE_ENV: 'test',
      GEMINI_API_KEY: 'test-gemini-key',
      GEMINI_EXPLAIN_MODEL: 'gemini-4-hydrogen',
      GEMINI_EXPLAIN_FALLBACK_MODEL: 'gemini-2.5-flash',
    });

    const mockAiClient = {
      models: {
        generateContent: vi
          .fn()
          .mockRejectedValueOnce(new Error('Model gemini-4-hydrogen not found or unsupported.'))
          .mockResolvedValueOnce({
            text: JSON.stringify({
              summary:
                '100 University Ave is listed at $750,000 vs AVM midpoint of $800,000 (6.3% gap). The asking price falls inside [$720,000, $880,000].',
              evidenceIds: ['ev_prop_pricing', 'ev_prop_range'],
              positiveFactors: [],
              contraryAndUncertaintyFactors: ['In range'],
              limitations: ['Not an appraisal'],
            }),
          }),
      },
    };

    const service = createExplainService(config, { aiClient: mockAiClient });
    const result = await service.explainProperty(sampleRequest);

    expect(result?.explanationAvailable).toBe(true);
    expect(result?.fallbackUsed).toBe(false);
    expect(result?.modelUsed).toBe('gemini-2.5-flash');

    // Called twice: first for primary, second for fallback
    expect(mockAiClient.models.generateContent).toHaveBeenCalledTimes(2);
  });

  it('degrades to deterministic fallback when LLM output fails validation', async () => {
    const config = loadServerConfig({
      NODE_ENV: 'test',
      GEMINI_API_KEY: 'test-gemini-key',
    });

    const mockAiClient = {
      models: {
        generateContent: vi.fn().mockResolvedValue({
          text: JSON.stringify({
            summary:
              '100 University Ave is listed at $750,000. Nearby McDonald’s causes property values to surge by 40%.',
            evidenceIds: ['ev_prop_pricing', 'ev_hallucinated_fake_id'],
            positiveFactors: [],
            contraryAndUncertaintyFactors: [],
            limitations: [],
          }),
        }),
      },
    };

    const service = createExplainService(config, { aiClient: mockAiClient });
    const result = await service.explainProperty(sampleRequest);

    expect(result?.explanationAvailable).toBe(false);
    expect(result?.fallbackUsed).toBe(true);
    expect(result?.unavailableReason).toContain('Grounded validation rejected LLM output');
    // Still returns high-quality deterministic summary so UI never breaks!
    expect(result?.summary).toContain('100 University Ave');
  });

  it('enforces strict server-resolved authority over forged client requests', async () => {
    const config = loadServerConfig({
      NODE_ENV: 'test',
      GEMINI_API_KEY: '',
    });

    const serverAuthoritativeProperty: PropertyDetailRecord = {
      ...baseProperty,
      askingPrice: 999999, // Authoritative server number
    };

    const resolvePropertyContext = vi.fn().mockResolvedValue({
      property: serverAuthoritativeProperty,
      accessibility: null,
      environmentalRecords: [],
      isSyntheticDemo: false,
    });

    const service = createExplainService(config, { resolvePropertyContext });

    // Client passes a forged askingPrice in request body
    const forgedRequest: ExplainRequest = {
      ...sampleRequest,
      propertyContext: {
        ...baseProperty,
        askingPrice: 100, // Forged low price
      },
    };

    const result = await service.explainProperty(forgedRequest);

    expect(resolvePropertyContext).toHaveBeenCalledWith(
      'sess_test_123',
      'prop_service_01',
      forgedRequest.preferences,
      undefined
    );

    // Summary should use server's 999,999, NOT forged 100!
    expect(result?.summary).toContain('$999,999');
    expect(result?.summary).not.toContain('$100');
  });
});
