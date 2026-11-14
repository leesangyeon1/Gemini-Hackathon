/**
 * RentCast API v1 Server Client, Normalizer, PII Stripper & Contrary-Evidence Builder
 * (`src/server/property/rentcastClient.ts`)
 *
 * Verified Endpoints (2026-11-13 / 2026-11-14):
 * - `GET https://api.rentcast.io/v1/listings/sale`
 * - `GET https://api.rentcast.io/v1/avm/value`
 * - `GET https://api.rentcast.io/v1/properties`
 *
 * Security & Hygiene Invariants:
 * - `X-Api-Key` header is attached server-side only and never leaked in errors or logs.
 * - Owner PII (`owner`, `mailingAddress`, `ownerOccupied`) and agent/office contact details
 *   (`agent`, `office`, `broker`, `phone`, `email`) are stripped immediately upon ingestion.
 * - Keeps `askingPrice`, `listingLastSeenAt`, `avmPrice`, `avmLow`, `avmHigh`, `avmFetchedAt`,
 *   `lastSalePrice`, `lastSaleDate`, and `assessedValue` strictly distinct.
 * - Detects subject-property duplication in `comparables[]` (`subjectIncludedInComps`).
 */

import type {
  ApiErrorCode,
  ComparableListingRecord,
  ComparablesSummary,
  ContraryEvidenceItem,
  PropertyDetailRecord,
  PropertyListingSummary,
  UiState,
} from '../../shared/types';
import {
  computeGeodesicDistanceMeters,
  computePriceGap,
  isValidCoordinate,
} from '../geospatial/scoring';

export const RENTCAST_BASE_URL = 'https://api.rentcast.io/v1';
const METERS_PER_MILE = 1609.344;

const PII_FIELD_KEYS = new Set([
  'owner',
  'ownerOccupied',
  'ownerNames',
  'mailingAddress',
  'agent',
  'listingAgent',
  'office',
  'listingOffice',
  'broker',
  'mlsAgent',
  'phone',
  'email',
  'contact',
]);

export class RentCastClientError extends Error {
  public readonly code: ApiErrorCode;
  public readonly statusCode: number;
  public readonly uiState: UiState;
  public readonly retryable: boolean;
  public readonly missingEnvVarNames?: string[];

  constructor(options: {
    code: ApiErrorCode;
    message: string;
    statusCode: number;
    uiState: UiState;
    retryable: boolean;
    missingEnvVarNames?: string[];
  }) {
    super(options.message);
    this.name = 'RentCastClientError';
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.uiState = options.uiState;
    this.retryable = options.retryable;
    this.missingEnvVarNames = options.missingEnvVarNames;
  }
}

/**
 * Recursively strips owner and listing agent/broker PII fields from raw RentCast objects
 * before any server caching or client serialization.
 */
export function stripRentCastPii<T>(raw: T): T {
  if (raw === null || raw === undefined || typeof raw !== 'object') {
    return raw;
  }
  if (Array.isArray(raw)) {
    return raw.map((item) => stripRentCastPii(item)) as unknown as T;
  }
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (PII_FIELD_KEYS.has(key)) {
      continue;
    }
    cleaned[key] = stripRentCastPii(value);
  }
  return cleaned as T;
}

function toPositiveFiniteNumber(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
    return val;
  }
  if (typeof val === 'string' && val.trim().length > 0) {
    const parsed = Number(val);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return null;
}

function toNonNegativeFiniteNumber(val: unknown): number | null {
  if (typeof val === 'number' && Number.isFinite(val) && val >= 0) {
    return val;
  }
  if (typeof val === 'string' && val.trim().length > 0) {
    const parsed = Number(val);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return parsed;
    }
  }
  return null;
}

function toCleanIsoDate(val: unknown): string | null {
  if (typeof val !== 'string' || val.trim().length === 0) {
    return null;
  }
  const trimmed = val.trim();
  const parsedMs = Date.parse(trimmed);
  if (!Number.isFinite(parsedMs)) {
    return null;
  }
  return new Date(parsedMs).toISOString();
}

export function normalizeAddressForMatch(addr: string | null | undefined): string {
  if (typeof addr !== 'string') {
    return '';
  }
  return addr
    .toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\b(street|st)\b/g, 'st')
    .replace(/\b(avenue|ave)\b/g, 'ave')
    .replace(/\b(boulevard|blvd)\b/g, 'blvd')
    .replace(/\b(drive|dr)\b/g, 'dr')
    .replace(/\b(road|rd)\b/g, 'rd')
    .replace(/\b(lane|ln)\b/g, 'ln')
    .replace(/\b(court|ct)\b/g, 'ct')
    .replace(/\b(place|pl)\b/g, 'pl')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractLatestTaxAssessment(
  taxAssessments: unknown
): { assessedValue: number | null; assessedYear: number | null } {
  if (!taxAssessments || typeof taxAssessments !== 'object') {
    return { assessedValue: null, assessedYear: null };
  }

  let bestYear: number | null = null;
  let bestValue: number | null = null;

  for (const [yearKey, entry] of Object.entries(
    taxAssessments as Record<string, unknown>
  )) {
    if (!entry || typeof entry !== 'object') {
      continue;
    }
    const rec = entry as { year?: unknown; value?: unknown };
    const yearNum = Number.parseInt(String(rec.year ?? yearKey), 10);
    const valNum = toPositiveFiniteNumber(rec.value);
    if (
      Number.isInteger(yearNum) &&
      yearNum >= 1900 &&
      yearNum <= 2100 &&
      valNum !== null
    ) {
      if (bestYear === null || yearNum > bestYear) {
        bestYear = yearNum;
        bestValue = valNum;
      }
    }
  }

  return { assessedValue: bestValue, assessedYear: bestYear };
}

/**
 * Normalizes a single item from `GET /v1/listings/sale` into a `PropertyListingSummary`
 * (with `avmPrice: null` until on-demand `/avm` is called).
 */
export function normalizeSaleListingRecord(
  rawItem: Record<string, unknown>
): PropertyListingSummary | null {
  const sanitized = stripRentCastPii(rawItem);

  const lat = Number(sanitized.latitude);
  const lng = Number(sanitized.longitude);
  if (!isValidCoordinate(lat, lng)) {
    return null;
  }

  const rawAddressLine1 =
    typeof sanitized.addressLine1 === 'string' ? sanitized.addressLine1.trim() : '';
  const city =
    typeof sanitized.city === 'string' && sanitized.city.trim().length > 0
      ? sanitized.city.trim()
      : null;
  const state =
    typeof sanitized.state === 'string' && sanitized.state.trim().length > 0
      ? sanitized.state.trim()
      : null;
  const zipCode =
    typeof sanitized.zipCode === 'string' && sanitized.zipCode.trim().length > 0
      ? sanitized.zipCode.trim()
      : null;

  const formattedAddress =
    typeof sanitized.formattedAddress === 'string' &&
    sanitized.formattedAddress.trim().length > 0
      ? sanitized.formattedAddress.trim()
      : [rawAddressLine1, city, state, zipCode].filter(Boolean).join(', ');

  if (!formattedAddress) {
    return null;
  }

  const id =
    typeof sanitized.id === 'string' && sanitized.id.trim().length > 0
      ? sanitized.id.trim()
      : `rc-${formattedAddress
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')}`;

  const propertyType =
    typeof sanitized.propertyType === 'string' &&
    sanitized.propertyType.trim().length > 0
      ? sanitized.propertyType.trim()
      : 'Single Family';

  // Ensure whole-property sale askingPrice (never monthly rental or non-positive number)
  const askingPrice = toPositiveFiniteNumber(sanitized.price);
  const listingLastSeenAt =
    toCleanIsoDate(sanitized.lastSeenDate) ??
    toCleanIsoDate(sanitized.listedDate) ??
    toCleanIsoDate(sanitized.listingDate);

  const lastSalePrice = toPositiveFiniteNumber(sanitized.lastSalePrice);
  const lastSaleDate = toCleanIsoDate(sanitized.lastSaleDate);
  const { assessedValue, assessedYear } = extractLatestTaxAssessment(
    sanitized.taxAssessments
  );

  const yearBuiltRaw = toPositiveFiniteNumber(sanitized.yearBuilt);
  const yearBuilt =
    yearBuiltRaw !== null &&
    yearBuiltRaw >= 1600 &&
    yearBuiltRaw <= 2100
      ? Math.round(yearBuiltRaw)
      : null;

  const priceGap = computePriceGap({
    askingPrice,
    avmPrice: null,
    avmLow: null,
    avmHigh: null,
  });

  return {
    id,
    formattedAddress,
    city,
    state,
    zipCode,
    latitude: lat,
    longitude: lng,
    propertyType,
    bedrooms: toNonNegativeFiniteNumber(sanitized.bedrooms),
    bathrooms: toNonNegativeFiniteNumber(sanitized.bathrooms),
    squareFootage: toPositiveFiniteNumber(sanitized.squareFootage),
    lotSize: toPositiveFiniteNumber(sanitized.lotSize),
    yearBuilt,
    askingPrice,
    listingLastSeenAt,
    avmPrice: null,
    avmLow: null,
    avmHigh: null,
    avmFetchedAt: null,
    lastSalePrice,
    lastSaleDate,
    assessedValue,
    assessedYear,
    comparablesSummary: null,
    priceGap,
    accessibility: null,
    nearbyEnvironmentalCount: 0,
    dataProvenance: 'rentcast_live',
  };
}

/**
 * Builds structured contrary evidence and uncertainty flags for a property detail record.
 */
export function buildContraryEvidence(params: {
  property: {
    propertyType: string;
    bedrooms: number | null;
    bathrooms: number | null;
    squareFootage: number | null;
    askingPrice: number | null;
    listingLastSeenAt: string | null;
    avmPrice: number | null;
    avmLow: number | null;
    avmHigh: number | null;
  };
  comparablesSummary: ComparablesSummary | null;
  priceGap: ReturnType<typeof computePriceGap>;
  now?: Date;
}): ContraryEvidenceItem[] {
  const items: ContraryEvidenceItem[] = [];
  const { property, comparablesSummary, priceGap } = params;
  const nowMs = (params.now ?? new Date()).getTime();

  // 1. Always surface AVM methodology limitation
  items.push({
    code: 'avm_methodology_limitation',
    severity: 'info',
    title: 'Comparable-Listing Statistical Model (Not an Appraisal)',
    detail:
      'RentCast AVM estimates are derived statistically from nearby comparable listings and do not account for interior renovations, structural defects, lot topography, or closed-sale appraisal adjustments.',
  });

  // 2. Asking price below midpoint but inside [avmLow, avmHigh]
  if (
    priceGap.rangePosition === 'in_range' &&
    priceGap.gapPct !== null &&
    priceGap.gapPct > 0 &&
    property.avmLow !== null &&
    property.avmHigh !== null
  ) {
    items.push({
      code: 'asking_inside_avm_range',
      severity: 'caution',
      title: 'Asking Price Lies Inside the AVM Confidence Interval',
      detail: `Although the asking price ($${property.askingPrice?.toLocaleString()}) is ${priceGap.gapPct.toFixed(
        1
      )}% below the AVM midpoint ($${property.avmPrice?.toLocaleString()}), it sits within the model uncertainty band ($${property.avmLow.toLocaleString()}–$${property.avmHigh.toLocaleString()}), which indicates normal statistical dispersion rather than proven undervaluation.`,
    });
  }

  // 3. Subject property duplicated inside comparables[] (circularity warning)
  if (comparablesSummary?.subjectIncludedInComps) {
    items.push({
      code: 'subject_included_in_comps',
      severity: 'warning',
      title: 'Subject Listing Appears in AVM Comparable Pool (Circularity)',
      detail:
        'The active subject property listing was detected inside the returned AVM comparables list, which can pull the AVM estimate toward the current asking price.',
    });
  }

  // 4. Wide AVM uncertainty band ((avmHigh - avmLow) / avmPrice >= 0.25)
  if (
    property.avmPrice !== null &&
    property.avmPrice > 0 &&
    property.avmLow !== null &&
    property.avmHigh !== null &&
    property.avmHigh >= property.avmLow
  ) {
    const spreadRatio = (property.avmHigh - property.avmLow) / property.avmPrice;
    if (spreadRatio >= 0.25) {
      items.push({
        code: 'wide_avm_uncertainty_band',
        severity: 'caution',
        title: `Wide Valuation Uncertainty Band (${Math.round(spreadRatio * 100)}% Spread)`,
        detail: `The AVM confidence range spans $${property.avmLow.toLocaleString()} to $${property.avmHigh.toLocaleString()} (${Math.round(
          spreadRatio * 100
        )}% of midpoint), indicating high local price heterogeneity.`,
      });
    }
  }

  // 5. Few comparables (< 4)
  if (comparablesSummary && comparablesSummary.compCount < 4) {
    items.push({
      code: 'few_comparables',
      severity: 'caution',
      title: `Limited Comparable Sample (${comparablesSummary.compCount} Comps)`,
      detail: `Only ${comparablesSummary.compCount} comparable listings were returned for this valuation, reducing statistical confidence.`,
    });
  }

  // 6. Distant comparables (> 1.5 miles)
  if (
    comparablesSummary?.maxDistanceMiles !== null &&
    comparablesSummary?.maxDistanceMiles !== undefined &&
    comparablesSummary.maxDistanceMiles > 1.5
  ) {
    items.push({
      code: 'distant_comparables',
      severity: 'caution',
      title: `Distant Comparables (Up to ${comparablesSummary.maxDistanceMiles.toFixed(2)} mi)`,
      detail: `At least one comparable listing is ${comparablesSummary.maxDistanceMiles.toFixed(
        2
      )} miles away and may reflect a different micro-neighborhood market.`,
    });
  }

  // 7. Stale listing timestamp (> 45 days old)
  if (property.listingLastSeenAt) {
    const seenMs = Date.parse(property.listingLastSeenAt);
    if (Number.isFinite(seenMs)) {
      const daysSinceSeen = (nowMs - seenMs) / (1000 * 60 * 60 * 24);
      if (daysSinceSeen > 45) {
        items.push({
          code: 'stale_listing_timestamp',
          severity: 'caution',
          title: `Listing Timestamp Over ${Math.round(daysSinceSeen)} Days Old`,
          detail: `Listing was last verified active on ${property.listingLastSeenAt.slice(
            0,
            10
          )}; current market status or price may have changed.`,
        });
      }
    }
  }

  // 8. Non-standard property type
  const normType = property.propertyType.toLowerCase();
  if (
    normType.includes('land') ||
    normType.includes('manufactured') ||
    normType.includes('multi')
  ) {
    items.push({
      code: 'non_standard_property_type',
      severity: 'caution',
      title: `Property Type Comparability (${property.propertyType})`,
      detail: `Automated valuations for ${property.propertyType} properties often exhibit higher variance than standard single-family residences or condos.`,
    });
  }

  // 9. Missing structural attributes
  if (
    property.squareFootage === null ||
    property.bedrooms === null ||
    property.bathrooms === null
  ) {
    items.push({
      code: 'missing_structural_attributes',
      severity: 'caution',
      title: 'Incomplete Subject Structural Attributes',
      detail:
        'One or more core structural attributes (square footage, bedrooms, or bathrooms) are missing from the listing record, which can reduce AVM accuracy.',
    });
  }

  return items;
}

/**
 * Merges a raw `/v1/avm/value` response (and optional `/v1/properties` record) onto
 * a base `PropertyListingSummary`, returning a normalized `PropertyDetailRecord`.
 */
export function normalizeAvmResponse(params: {
  subject: PropertyListingSummary;
  rawAvmPayload: Record<string, unknown>;
  rawPropertyRecordPayload?: Record<string, unknown> | null;
  fetchedAt?: string;
}): PropertyDetailRecord {
  const { subject } = params;
  const sanitizedAvm = stripRentCastPii(params.rawAvmPayload);
  const sanitizedPropRec = params.rawPropertyRecordPayload
    ? stripRentCastPii(params.rawPropertyRecordPayload)
    : null;
  const fetchedAt = params.fetchedAt ?? new Date().toISOString();

  const avmPrice = toPositiveFiniteNumber(sanitizedAvm.price);
  const rawLow = toPositiveFiniteNumber(sanitizedAvm.priceRangeLow);
  const rawHigh = toPositiveFiniteNumber(sanitizedAvm.priceRangeHigh);

  // If bounds are inverted, treat range bounds as null so computePriceGap classifies `range_unknown`
  const hasValidRange =
    rawLow !== null && rawHigh !== null && rawLow <= rawHigh;
  const avmLow = hasValidRange ? rawLow : null;
  const avmHigh = hasValidRange ? rawHigh : null;

  const subjectPropObj =
    sanitizedAvm.subjectProperty &&
    typeof sanitizedAvm.subjectProperty === 'object'
      ? (sanitizedAvm.subjectProperty as Record<string, unknown>)
      : null;

  // Keep lastSalePrice, lastSaleDate, and assessedValue strictly distinct from askingPrice and avmPrice
  const lastSalePrice =
    toPositiveFiniteNumber(sanitizedPropRec?.lastSalePrice) ??
    toPositiveFiniteNumber(subjectPropObj?.lastSalePrice) ??
    subject.lastSalePrice;

  const lastSaleDate =
    toCleanIsoDate(sanitizedPropRec?.lastSaleDate) ??
    toCleanIsoDate(subjectPropObj?.lastSaleDate) ??
    subject.lastSaleDate;

  const propTax = extractLatestTaxAssessment(
    sanitizedPropRec?.taxAssessments ?? subjectPropObj?.taxAssessments
  );
  const assessedValue = propTax.assessedValue ?? subject.assessedValue;
  const assessedYear = propTax.assessedYear ?? subject.assessedYear ?? null;

  // Parse comparables[] and check for subject duplication
  const rawComps = Array.isArray(sanitizedAvm.comparables)
    ? (sanitizedAvm.comparables as Array<Record<string, unknown>>)
    : [];

  const normSubjectAddr = normalizeAddressForMatch(subject.formattedAddress);
  const comparables: ComparableListingRecord[] = [];
  let subjectIncludedInComps = false;

  for (let i = 0; i < rawComps.length; i += 1) {
    const rawComp = stripRentCastPii(rawComps[i] ?? {});
    const compId =
      typeof rawComp.id === 'string' && rawComp.id.trim().length > 0
        ? rawComp.id.trim()
        : `comp_${i + 1}`;
    const compAddr =
      typeof rawComp.formattedAddress === 'string' &&
      rawComp.formattedAddress.trim().length > 0
        ? rawComp.formattedAddress.trim()
        : `Comparable #${i + 1}`;
    const normCompAddr = normalizeAddressForMatch(compAddr);
    const compPrice = toPositiveFiniteNumber(rawComp.price);

    const compLat = Number(rawComp.latitude);
    const compLng = Number(rawComp.longitude);
    let geodesicMetersToSubject: number | null = null;
    if (isValidCoordinate(compLat, compLng)) {
      geodesicMetersToSubject = computeGeodesicDistanceMeters(
        subject.latitude,
        subject.longitude,
        compLat,
        compLng
      );
    }

    const distanceMiles = toNonNegativeFiniteNumber(rawComp.distance);
    const isSameId = compId.toLowerCase() === subject.id.toLowerCase();
    const isSameAddress =
      normSubjectAddr.length > 0 &&
      normCompAddr.length > 0 &&
      normSubjectAddr === normCompAddr;
    const isCoincidentWithSamePrice =
      (geodesicMetersToSubject !== null &&
        geodesicMetersToSubject < 15 &&
        compPrice !== null &&
        subject.askingPrice !== null &&
        Math.abs(compPrice - subject.askingPrice) < 1) ||
      (distanceMiles !== null &&
        distanceMiles < 0.01 &&
        compPrice !== null &&
        subject.askingPrice !== null &&
        Math.abs(compPrice - subject.askingPrice) < 1);

    const isSubjectDuplicate =
      isSameId || isSameAddress || isCoincidentWithSamePrice;
    if (isSubjectDuplicate) {
      subjectIncludedInComps = true;
    }

    const rawCorrelation = toNonNegativeFiniteNumber(rawComp.correlation);
    const correlation =
      rawCorrelation !== null && rawCorrelation <= 1 ? rawCorrelation : null;

    comparables.push({
      id: compId,
      formattedAddress: compAddr,
      propertyType:
        typeof rawComp.propertyType === 'string' ? rawComp.propertyType : null,
      bedrooms: toNonNegativeFiniteNumber(rawComp.bedrooms),
      bathrooms: toNonNegativeFiniteNumber(rawComp.bathrooms),
      squareFootage: toPositiveFiniteNumber(rawComp.squareFootage),
      price: compPrice,
      status: typeof rawComp.status === 'string' ? rawComp.status : null,
      lastSeenAt:
        toCleanIsoDate(rawComp.lastSeenDate) ??
        toCleanIsoDate(rawComp.listedDate),
      distanceMiles,
      correlation,
      daysOld: toNonNegativeFiniteNumber(rawComp.daysOld),
      isSubjectDuplicate,
    });
  }

  const validCompPrices = comparables
    .map((c) => c.price)
    .filter((p): p is number => p !== null && p > 0)
    .sort((a, b) => a - b);

  let medianCompPrice: number | null = null;
  if (validCompPrices.length > 0) {
    const mid = Math.floor(validCompPrices.length / 2);
    medianCompPrice =
      validCompPrices.length % 2 === 1
        ? validCompPrices[mid]!
        : Math.round((validCompPrices[mid - 1]! + validCompPrices[mid]!) / 2);
  }

  const validDistances = comparables
    .map((c) => c.distanceMiles)
    .filter((d): d is number => d !== null && d >= 0);

  const validCorrelations = comparables
    .map((c) => c.correlation)
    .filter((c): c is number => c !== null && c >= 0 && c <= 1);

  const comparablesSummary: ComparablesSummary = {
    compCount: comparables.length,
    medianCompPrice,
    minDistanceMiles:
      validDistances.length > 0 ? Math.min(...validDistances) : null,
    maxDistanceMiles:
      validDistances.length > 0 ? Math.max(...validDistances) : null,
    meanCorrelation:
      validCorrelations.length > 0
        ? Math.round(
            (validCorrelations.reduce((acc, v) => acc + v, 0) /
              validCorrelations.length) *
              1000
          ) / 1000
        : null,
    subjectIncludedInComps,
    comparables,
  };

  const priceGap = computePriceGap({
    askingPrice: subject.askingPrice,
    avmPrice,
    avmLow,
    avmHigh,
  });

  const updatedBase: PropertyListingSummary = {
    ...subject,
    avmPrice,
    avmLow,
    avmHigh,
    avmFetchedAt: fetchedAt,
    lastSalePrice,
    lastSaleDate,
    assessedValue,
    assessedYear,
    comparablesSummary,
    priceGap,
  };

  const contraryEvidence = buildContraryEvidence({
    property: updatedBase,
    comparablesSummary,
    priceGap,
  });

  return {
    ...updatedBase,
    contraryEvidence,
  };
}

export interface RentCastClientOptions {
  readonly apiKey: string | null;
  readonly baseUrl?: string;
  readonly fetchFn?: typeof fetch;
  readonly timeoutMs?: number;
}

export interface FetchSaleListingsParams {
  readonly centerLat: number;
  readonly centerLng: number;
  readonly radiusMeters: number;
  readonly limit?: number;
  readonly propertyType?: string;
}

export interface FetchPropertyAvmParams {
  readonly subject: PropertyListingSummary;
  readonly compCount?: number;
}

export interface RentCastClient {
  fetchSaleListings(params: FetchSaleListingsParams): Promise<PropertyListingSummary[]>;
  fetchPropertyAvm(
    params: FetchPropertyAvmParams
  ): Promise<Record<string, unknown>>;
  fetchPropertyRecord(
    formattedAddress: string
  ): Promise<Record<string, unknown> | null>;
}

export function createRentCastClient(
  options: RentCastClientOptions
): RentCastClient {
  const baseUrl = (options.baseUrl ?? RENTCAST_BASE_URL).replace(/\/$/, '');
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 8_000;

  function requireApiKey(): string {
    const key = options.apiKey?.trim();
    if (!key) {
      throw new RentCastClientError({
        code: 'SETUP_NEEDED',
        message:
          'Live property and AVM data requires RENTCAST_API_KEY to be configured on the server.',
        statusCode: 503,
        uiState: 'setup_needed',
        retryable: false,
        missingEnvVarNames: ['RENTCAST_API_KEY'],
      });
    }
    return key;
  }

  async function requestJson(url: string, apiKey: string): Promise<unknown> {
    let resp: Response;
    try {
      resp = await fetchFn(url, {
        method: 'GET',
        headers: {
          'X-Api-Key': apiKey,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const isAbort =
        err instanceof Error &&
        (err.name === 'AbortError' ||
          err.name === 'TimeoutError' ||
          err.message.toLowerCase().includes('timeout') ||
          err.message.toLowerCase().includes('aborted'));

      if (isAbort) {
        throw new RentCastClientError({
          code: 'UPSTREAM_TIMEOUT',
          message: `RentCast API request timed out after ${timeoutMs}ms.`,
          statusCode: 504,
          uiState: 'timeout',
          retryable: true,
        });
      }

      throw new RentCastClientError({
        code: 'PROVIDER_ERROR',
        message: 'Failed to reach upstream RentCast API service.',
        statusCode: 502,
        uiState: 'recovery',
        retryable: true,
      });
    }

    if (resp.status === 401 || resp.status === 403) {
      throw new RentCastClientError({
        code: 'PROVIDER_ERROR',
        message:
          'RentCast API rejected server authentication (HTTP 401/403). Verify RENTCAST_API_KEY configuration.',
        statusCode: 502,
        uiState: 'setup_needed',
        retryable: false,
      });
    }

    if (resp.status === 429) {
      throw new RentCastClientError({
        code: 'RATE_LIMITED',
        message:
          'Upstream RentCast API returned HTTP 429 (rate or quota limit reached).',
        statusCode: 429,
        uiState: 'recovery',
        retryable: true,
      });
    }

    if (resp.status === 404) {
      throw new RentCastClientError({
        code: 'NOT_FOUND',
        message: 'No matching property or valuation record found in RentCast API.',
        statusCode: 404,
        uiState: 'empty',
        retryable: false,
      });
    }

    if (!resp.ok) {
      throw new RentCastClientError({
        code: 'PROVIDER_ERROR',
        message: `Upstream RentCast API returned HTTP ${resp.status}.`,
        statusCode: 502,
        uiState: 'recovery',
        retryable: resp.status >= 500,
      });
    }

    try {
      return await resp.json();
    } catch {
      throw new RentCastClientError({
        code: 'PROVIDER_ERROR',
        message: 'Upstream RentCast API returned malformed JSON.',
        statusCode: 502,
        uiState: 'recovery',
        retryable: true,
      });
    }
  }

  return {
    async fetchSaleListings(
      params: FetchSaleListingsParams
    ): Promise<PropertyListingSummary[]> {
      const apiKey = requireApiKey();
      const safeLimit = Math.max(1, Math.min(25, Math.floor(params.limit ?? 25)));
      const radiusMiles = Math.max(
        0.25,
        Math.round((params.radiusMeters / METERS_PER_MILE) * 100) / 100
      );

      const query = new URLSearchParams({
        latitude: String(params.centerLat),
        longitude: String(params.centerLng),
        radius: String(radiusMiles),
        status: 'Active',
        limit: String(safeLimit),
      });

      if (params.propertyType && params.propertyType !== 'Other') {
        query.set('propertyType', params.propertyType);
      }

      const payload = await requestJson(
        `${baseUrl}/listings/sale?${query.toString()}`,
        apiKey
      );

      if (!Array.isArray(payload)) {
        return [];
      }

      const normalized: PropertyListingSummary[] = [];
      for (const rawItem of payload) {
        if (rawItem && typeof rawItem === 'object') {
          const item = normalizeSaleListingRecord(
            rawItem as Record<string, unknown>
          );
          if (item) {
            normalized.push(item);
          }
        }
        if (normalized.length >= safeLimit) {
          break;
        }
      }

      return normalized;
    },

    async fetchPropertyAvm(
      params: FetchPropertyAvmParams
    ): Promise<Record<string, unknown>> {
      const apiKey = requireApiKey();
      const { subject } = params;

      const query = new URLSearchParams({
        address: subject.formattedAddress,
        latitude: String(subject.latitude),
        longitude: String(subject.longitude),
        compCount: String(Math.max(5, Math.min(25, params.compCount ?? 10))),
        lookupSubjectAttributes: 'true',
      });

      if (subject.propertyType) {
        query.set('propertyType', subject.propertyType);
      }
      if (subject.bedrooms !== null) {
        query.set('bedrooms', String(subject.bedrooms));
      }
      if (subject.bathrooms !== null) {
        query.set('bathrooms', String(subject.bathrooms));
      }
      if (subject.squareFootage !== null) {
        query.set('squareFootage', String(subject.squareFootage));
      }

      const payload = await requestJson(
        `${baseUrl}/avm/value?${query.toString()}`,
        apiKey
      );

      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new RentCastClientError({
          code: 'PROVIDER_ERROR',
          message: 'Upstream RentCast AVM response did not contain a valuation object.',
          statusCode: 502,
          uiState: 'recovery',
          retryable: true,
        });
      }

      return stripRentCastPii(payload as Record<string, unknown>);
    },

    async fetchPropertyRecord(
      formattedAddress: string
    ): Promise<Record<string, unknown> | null> {
      const apiKey = requireApiKey();
      const query = new URLSearchParams({
        address: formattedAddress,
      });

      const payload = await requestJson(
        `${baseUrl}/properties?${query.toString()}`,
        apiKey
      );

      if (Array.isArray(payload) && payload.length > 0 && typeof payload[0] === 'object') {
        return stripRentCastPii(payload[0] as Record<string, unknown>);
      }
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
        return stripRentCastPii(payload as Record<string, unknown>);
      }
      return null;
    },
  };
}
