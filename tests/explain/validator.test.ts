import { describe, expect, it } from 'vitest';
import { buildEvidenceCatalog } from '../../src/server/explain/evidenceBuilder';
import { validateGeminiExplainPayload } from '../../src/server/explain/validator';
import type { PropertyDetailRecord } from '../../src/shared/types';

describe('explain/validator', () => {
  const property: PropertyDetailRecord = {
    id: 'prop_val_01',
    dataProvenance: 'rentcast_live',
    formattedAddress: '742 Evergreen Terrace, Springfield, OR 97477',
    city: 'Springfield',
    state: 'OR',
    zipCode: '97477',
    latitude: 44.0462,
    longitude: -123.022,
    propertyType: 'Single Family',
    bedrooms: 4,
    bathrooms: 2.5,
    squareFootage: 2200,
    lotSize: 7500,
    yearBuilt: 1989,
    askingPrice: 450000,
    listingLastSeenAt: '2026-11-12T00:00:00.000Z',
    avmPrice: 500000,
    avmLow: 425000,
    avmHigh: 575000,
    avmFetchedAt: '2026-11-14T00:00:00.000Z',
    lastSalePrice: 310000,
    lastSaleDate: '2016-08-20',
    assessedValue: 390000,
    assessedYear: 2025,
    comparablesSummary: null,
    priceGap: {
      gapPct: 10.0,
      gapAmountUsd: 50000,
      rangePosition: 'in_range',
      askingPrice: 450000,
      avmPrice: 500000,
      avmLow: 425000,
      avmHigh: 575000,
      isWithinEstimateRange: true,
      isProvenUndervaluation: false,
      interpretationNote: 'In range',
    },
    accessibility: null,
    nearbyEnvironmentalCount: 0,
    contraryEvidence: [],
  };

  const { evidenceCatalog, facts } = buildEvidenceCatalog({
    property,
    accessibility: null,
  });

  it('accepts a valid grounded explanation payload', () => {
    const validRawJson = JSON.stringify({
      summary:
        '742 Evergreen Terrace is listed at $450,000, which is 10.0% below the RentCast AVM midpoint ($500,000). The asking price falls inside the statistical confidence interval ($425,000–$575,000), reflecting normal valuation dispersion within the model range.',
      evidenceIds: ['ev_prop_pricing', 'ev_prop_range'],
      positiveFactors: [
        'Active asking price ($450,000) is moderately below the point midpoint estimate ($500,000).',
      ],
      contraryAndUncertaintyFactors: [
        'Asking price is within the AVM range ($425,000 to $575,000).',
        'AVM is a statistical model, not a physical appraisal.',
      ],
      limitations: [
        'Automated estimates do not evaluate interior fixtures or unrecorded renovations.',
      ],
    });

    const result = validateGeminiExplainPayload(validRawJson, evidenceCatalog, facts);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.payload.evidenceIds).toEqual(['ev_prop_pricing', 'ev_prop_range']);
    }
  });

  it('unwraps markdown code fences cleanly', () => {
    const fencedJson =
      '```json\n{"summary":"742 Evergreen Terrace is listed at $450,000 vs AVM $500,000 (10.0% gap).","evidenceIds":["ev_prop_pricing"],"positiveFactors":[],"contraryAndUncertaintyFactors":[],"limitations":[]}\n```';

    const result = validateGeminiExplainPayload(fencedJson, evidenceCatalog, facts);
    expect(result.valid).toBe(true);
  });

  it('rejects hallucinated evidenceId not present in server catalog', () => {
    const hallucinatedIdJson = JSON.stringify({
      summary: '742 Evergreen Terrace is listed at $450,000.',
      evidenceIds: ['ev_prop_pricing', 'ev_fabricated_super_deal_999'],
      positiveFactors: [],
      contraryAndUncertaintyFactors: [],
      limitations: [],
    });

    const result = validateGeminiExplainPayload(hallucinatedIdJson, evidenceCatalog, facts);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorType).toBe('HALLUCINATED_EVIDENCE_ID');
      expect(result.reason).toContain('ev_fabricated_super_deal_999');
    }
  });

  it('rejects hallucinated valuation figures not present in server records', () => {
    const hallucinatedDollarJson = JSON.stringify({
      summary:
        '742 Evergreen Terrace is listed at $450,000, but our proprietary appraisal values it at $850,000, generating massive equity.',
      evidenceIds: ['ev_prop_pricing'],
      positiveFactors: [],
      contraryAndUncertaintyFactors: [],
      limitations: [],
    });

    const result = validateGeminiExplainPayload(hallucinatedDollarJson, evidenceCatalog, facts);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorType).toBe('NUMERICAL_HALLUCINATION');
      expect(result.reason).toContain('850,000');
    }
  });

  it('rejects contradictory percentage claims', () => {
    const hallucinatedPercentJson = JSON.stringify({
      summary:
        '742 Evergreen Terrace is listed at $450,000 vs AVM $500,000, representing a 35.0% price gap discount.',
      evidenceIds: ['ev_prop_pricing'],
      positiveFactors: [],
      contraryAndUncertaintyFactors: [],
      limitations: [],
    });

    const result = validateGeminiExplainPayload(hallucinatedPercentJson, evidenceCatalog, facts);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorType).toBe('NUMERICAL_HALLUCINATION');
      expect(result.reason).toContain('35.0%');
    }
  });

  it('rejects prohibited causal claims linking fast food to property appreciation', () => {
    const prohibitedClaimJson = JSON.stringify({
      summary:
        '742 Evergreen Terrace is listed at $450,000. The nearby McDonald’s causes property price appreciation in this submarket.',
      evidenceIds: ['ev_prop_pricing'],
      positiveFactors: ['Fast food drives capital growth.'],
      contraryAndUncertaintyFactors: [],
      limitations: [],
    });

    const result = validateGeminiExplainPayload(prohibitedClaimJson, evidenceCatalog, facts);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorType).toBe('PROHIBITED_CLAIM');
      expect(result.reason).toContain('fast-food');
    }
  });

  it('rejects prohibited demographic or protected-class claims', () => {
    const demographicClaimJson = JSON.stringify({
      summary:
        '742 Evergreen Terrace is listed at $450,000 in a safe neighborhood with predominantly white upper-class demographics.',
      evidenceIds: ['ev_prop_pricing'],
      positiveFactors: [],
      contraryAndUncertaintyFactors: [],
      limitations: [],
    });

    const result = validateGeminiExplainPayload(demographicClaimJson, evidenceCatalog, facts);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorType).toBe('PROHIBITED_CLAIM');
      expect(result.reason).toContain('demographic');
    }
  });

  it('rejects prohibited guaranteed profit or proven undervaluation claims', () => {
    const profitClaimJson = JSON.stringify({
      summary:
        '742 Evergreen Terrace is listed at $450,000 and represents a proven undervaluation with guaranteed profit upon purchase.',
      evidenceIds: ['ev_prop_pricing'],
      positiveFactors: [],
      contraryAndUncertaintyFactors: [],
      limitations: [],
    });

    const result = validateGeminiExplainPayload(profitClaimJson, evidenceCatalog, facts);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorType).toBe('PROHIBITED_CLAIM');
      expect(result.reason).toContain('guaranteed profit');
    }
  });

  it('rejects malformed or unparseable JSON', () => {
    const invalidJson = 'Not a JSON document at all.';
    const result = validateGeminiExplainPayload(invalidJson, evidenceCatalog, facts);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.errorType).toBe('JSON_PARSE_ERROR');
    }
  });
});
