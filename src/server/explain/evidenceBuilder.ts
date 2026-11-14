/**
 * Explain Evidence Catalog Builder (`src/server/explain/evidenceBuilder.ts`)
 *
 * Compiles authoritative, server-resolved property valuation metrics,
 * deterministic OpenStreetMap accessibility kernel breakdowns, and separate
 * EPA Facility Registry Service (FRS) due-diligence records into an allowlisted,
 * ID-indexed evidence catalog.
 *
 * CRITICAL SECURITY INVARIANT:
 * `google_places_context` is unconditionally barred from evidence catalog entry
 * and prompt generation pursuant to `src/server/geospatial/sourcePolicy.ts`.
 */

import type {
  AccessibilityResult,
  EnvironmentalRecord,
  ExplainDataAsOf,
  ExplainEvidenceItem,
  PreferenceProfile,
  PriceGapRangePosition,
  PropertyDetailRecord,
} from '../../shared/types';
import { isSourceEnvironmentalEligible } from '../geospatial/sourcePolicy';

export interface DeterministicFacts {
  readonly formattedAddress: string;
  readonly askingPrice: number | null;
  readonly avmPrice: number | null;
  readonly avmLow: number | null;
  readonly avmHigh: number | null;
  readonly gapPct: number | null;
  readonly gapAmountUsd: number | null;
  readonly rangePosition: PriceGapRangePosition;
  readonly assessedValue: number | null;
  readonly lastSalePrice: number | null;
  readonly accessibilityScore: number | null;
  readonly allowedNumbers: ReadonlySet<number>;
  readonly positiveFactors: readonly string[];
  readonly contraryAndUncertaintyFactors: readonly string[];
  readonly limitations: readonly string[];
}

export interface BuildEvidenceCatalogResult {
  readonly evidenceCatalog: ExplainEvidenceItem[];
  readonly evidenceMap: ReadonlyMap<string, ExplainEvidenceItem>;
  readonly dataAsOf: ExplainDataAsOf;
  readonly facts: DeterministicFacts;
}

export interface BuildEvidenceCatalogOptions {
  readonly property: PropertyDetailRecord;
  readonly accessibility: AccessibilityResult | null;
  readonly environmentalRecords?: readonly EnvironmentalRecord[];
  readonly preferences?: PreferenceProfile;
  readonly isSyntheticDemo?: boolean;
  readonly geospatialFetchedAt?: string | null;
}

function formatUsd(amount: number | null | undefined): string {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) {
    return 'N/A';
  }
  return `$${Math.round(amount).toLocaleString('en-US')}`;
}

function formatPercent(pct: number | null | undefined): string {
  if (typeof pct !== 'number' || !Number.isFinite(pct)) {
    return 'N/A';
  }
  const sign = pct > 0 ? '+' : '';
  return `${sign}${pct.toFixed(1)}%`;
}

function whitelistServerEvidenceNumbers(text: string, allowedNumbers: Set<number>): void {
  const dollarRegex = /\$([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)/g;
  let dollarMatch: RegExpExecArray | null;
  while ((dollarMatch = dollarRegex.exec(text)) !== null) {
    const parsed = Number.parseFloat(dollarMatch[1].replace(/,/g, ''));
    if (Number.isFinite(parsed)) {
      allowedNumbers.add(parsed);
      allowedNumbers.add(Math.round(parsed));
    }
  }

  const percentRegex = /([-+]?[0-9]+(?:\.[0-9]+)?)\s*%/g;
  let percentMatch: RegExpExecArray | null;
  while ((percentMatch = percentRegex.exec(text)) !== null) {
    const parsed = Number.parseFloat(percentMatch[1]);
    if (Number.isFinite(parsed)) {
      allowedNumbers.add(parsed);
      allowedNumbers.add(Math.round(parsed));
      allowedNumbers.add(Number(parsed.toFixed(1)));
      allowedNumbers.add(Math.abs(parsed));
      allowedNumbers.add(Math.abs(Number(parsed.toFixed(1))));
    }
  }
}

/**
 * Builds the authoritative, immutable evidence catalog and extracted deterministic facts.
 */
export function buildEvidenceCatalog(
  options: BuildEvidenceCatalogOptions
): BuildEvidenceCatalogResult {
  const {
    property,
    accessibility,
    environmentalRecords = [],
    isSyntheticDemo = false,
    geospatialFetchedAt = null,
  } = options;

  const catalog: ExplainEvidenceItem[] = [];
  const allowedNumbers = new Set<number>();

  const primaryPropertySource: 'rentcast' | 'synthetic_demo' = isSyntheticDemo
    ? 'synthetic_demo'
    : 'rentcast';

  const defaultGeoSource: 'osm_overpass' | 'synthetic_demo' = isSyntheticDemo
    ? 'synthetic_demo'
    : 'osm_overpass';

  // --------------------------------------------------------------------------
  // 1. Valuation & Financial Evidence
  // --------------------------------------------------------------------------
  const askingPrice = property.askingPrice;
  const avmPrice = property.avmPrice;
  const avmLow = property.avmLow;
  const avmHigh = property.avmHigh;
  const gapPct = property.priceGap?.gapPct ?? null;
  const gapAmountUsd = property.priceGap?.gapAmountUsd ?? null;
  const rangePosition = property.priceGap?.rangePosition ?? 'no_avm';

  if (typeof askingPrice === 'number' && Number.isFinite(askingPrice)) {
    allowedNumbers.add(askingPrice);
    allowedNumbers.add(Math.round(askingPrice));
  }
  if (typeof avmPrice === 'number' && Number.isFinite(avmPrice)) {
    allowedNumbers.add(avmPrice);
    allowedNumbers.add(Math.round(avmPrice));
  }
  if (typeof avmLow === 'number' && Number.isFinite(avmLow)) {
    allowedNumbers.add(avmLow);
    allowedNumbers.add(Math.round(avmLow));
  }
  if (typeof avmHigh === 'number' && Number.isFinite(avmHigh)) {
    allowedNumbers.add(avmHigh);
    allowedNumbers.add(Math.round(avmHigh));
  }
  if (typeof gapPct === 'number' && Number.isFinite(gapPct)) {
    allowedNumbers.add(gapPct);
    allowedNumbers.add(Number(gapPct.toFixed(1)));
    allowedNumbers.add(Math.abs(gapPct));
    allowedNumbers.add(Math.abs(Number(gapPct.toFixed(1))));
  }
  if (typeof gapAmountUsd === 'number' && Number.isFinite(gapAmountUsd)) {
    allowedNumbers.add(gapAmountUsd);
    allowedNumbers.add(Math.round(gapAmountUsd));
    allowedNumbers.add(Math.abs(gapAmountUsd));
    allowedNumbers.add(Math.abs(Math.round(gapAmountUsd)));
  }
  if (
    typeof avmPrice === 'number' &&
    Number.isFinite(avmPrice) &&
    avmPrice > 0 &&
    typeof avmLow === 'number' &&
    Number.isFinite(avmLow) &&
    typeof avmHigh === 'number' &&
    Number.isFinite(avmHigh) &&
    avmHigh >= avmLow
  ) {
    const avmSpreadUsd = avmHigh - avmLow;
    const avmSpreadPct = (avmSpreadUsd / avmPrice) * 100;
    allowedNumbers.add(avmSpreadUsd);
    allowedNumbers.add(Math.round(avmSpreadUsd));
    allowedNumbers.add(avmSpreadPct);
    allowedNumbers.add(Math.round(avmSpreadPct));
    allowedNumbers.add(Number(avmSpreadPct.toFixed(1)));
  }

  // Active Asking Price vs AVM Midpoint
  catalog.push({
    evidenceId: 'ev_prop_pricing',
    sourceId: primaryPropertySource,
    label: 'Active Asking Price vs. RentCast AVM Midpoint',
    detail: `Active asking price is ${formatUsd(askingPrice)} compared to RentCast AVM midpoint estimate of ${formatUsd(avmPrice)} (point gap: ${formatPercent(gapPct)}).`,
  });

  // AVM Confidence Interval Range
  catalog.push({
    evidenceId: 'ev_prop_range',
    sourceId: primaryPropertySource,
    label: 'RentCast AVM Confidence Interval Range',
    detail: `Statistical valuation range is [${formatUsd(avmLow)}, ${formatUsd(avmHigh)}] (range position classification: ${rangePosition}).`,
  });

  // Tax Assessment if available
  if (typeof property.assessedValue === 'number' && Number.isFinite(property.assessedValue)) {
    allowedNumbers.add(property.assessedValue);
    allowedNumbers.add(Math.round(property.assessedValue));
    catalog.push({
      evidenceId: 'ev_prop_assessed',
      sourceId: primaryPropertySource,
      label: 'County Tax Assessor Valuation',
      detail: `Assessed value is ${formatUsd(property.assessedValue)}${property.assessedYear ? ` for tax year ${property.assessedYear}` : ''}.`,
    });
  }

  // Prior Recorded Sale if available
  if (typeof property.lastSalePrice === 'number' && Number.isFinite(property.lastSalePrice)) {
    allowedNumbers.add(property.lastSalePrice);
    allowedNumbers.add(Math.round(property.lastSalePrice));
    catalog.push({
      evidenceId: 'ev_prop_last_sale',
      sourceId: primaryPropertySource,
      label: 'Prior Recorded Deed Sale',
      detail: `Most recent deed sale was recorded at ${formatUsd(property.lastSalePrice)}${property.lastSaleDate ? ` on ${property.lastSaleDate}` : ''}. Note: Historical closed sale, never substituted for active asking or AVM.`,
    });
  }

  // Comparables Summary if available
  if (property.comparablesSummary && property.comparablesSummary.compCount > 0) {
    const comp = property.comparablesSummary;
    allowedNumbers.add(comp.compCount);
    if (typeof comp.medianCompPrice === 'number' && Number.isFinite(comp.medianCompPrice)) {
      allowedNumbers.add(comp.medianCompPrice);
      allowedNumbers.add(Math.round(comp.medianCompPrice));
    }
    catalog.push({
      evidenceId: 'ev_prop_comparables',
      sourceId: primaryPropertySource,
      label: 'AVM Comparable Listings Summary',
      detail: `${comp.compCount} comparable listings analyzed (median comp price: ${formatUsd(comp.medianCompPrice)}). Circularity note: subject listing ${comp.subjectIncludedInComps ? 'IS included in comparables (circularity caution)' : 'is NOT included in comparables'}.`,
    });
  }

  // --------------------------------------------------------------------------
  // 2. Geospatial Amenity & Accessibility Evidence
  // --------------------------------------------------------------------------
  const accessibilityScore = accessibility?.score ?? null;
  if (typeof accessibilityScore === 'number' && Number.isFinite(accessibilityScore)) {
    allowedNumbers.add(accessibilityScore);
    allowedNumbers.add(Math.round(accessibilityScore));
    allowedNumbers.add(Number(accessibilityScore.toFixed(1)));
  }

  if (accessibility) {
    catalog.push({
      evidenceId: 'ev_acc_overall',
      sourceId: defaultGeoSource,
      label: 'Deterministic Amenity Accessibility Score',
      detail: `Composite accessibility score is ${accessibility.score.toFixed(1)}/100 (completeness: ${accessibility.completeness}, active weight: ${accessibility.knownWeight}/${accessibility.totalWeight}). User convenience preference index, not market dollars.`,
    });

    for (const cat of accessibility.categories ?? []) {
      const intensity = cat.intensity;
      if (typeof intensity === 'number' && Number.isFinite(intensity)) {
        allowedNumbers.add(Number(intensity.toFixed(2)));
        allowedNumbers.add(Number((intensity * 100).toFixed(0)));
      }
      allowedNumbers.add(cat.facilityCount);

      catalog.push({
        evidenceId: `ev_cat_${cat.category}`,
        sourceId: defaultGeoSource,
        label: `${cat.label} Convenience`,
        detail: `${cat.label}: intensity ${intensity !== null ? intensity.toFixed(2) : 'unknown'} (${cat.facilityCount} facilities within ${cat.radiusMeters}m straight-line buffer, user weight: ${cat.weight}).`,
      });
    }
  }

  // --------------------------------------------------------------------------
  // 3. Environmental Due-Diligence Layer (EPA FRS)
  // --------------------------------------------------------------------------
  // SECURITY: Unconditionally filter out any record where sourceId === 'google_places_context'
  // and ensure source is eligible for the environmental due-diligence layer.
  const eligibleEnvRecords = environmentalRecords.filter((rec) => {
    if (rec.sourceId === ('google_places_context' as string)) {
      return false;
    }
    return isSourceEnvironmentalEligible(rec.sourceId, { allowSyntheticDemo: isSyntheticDemo });
  });

  // Limit catalog addition to at most 6 nearby EPA records to keep context concise
  for (let i = 0; i < Math.min(eligibleEnvRecords.length, 6); i++) {
    const rec = eligibleEnvRecords[i];
    allowedNumbers.add(Math.round(rec.distanceMeters));
    const programsStr = rec.programs && rec.programs.length > 0 ? rec.programs.join(', ') : 'Registered Facility';
    const envSource: 'epa_frs' | 'synthetic_demo' = isSyntheticDemo ? 'synthetic_demo' : 'epa_frs';

    catalog.push({
      evidenceId: `ev_env_${rec.id}`,
      sourceId: envSource,
      label: `EPA FRS Record: ${rec.name}`,
      detail: `${rec.name} located ${Math.round(rec.distanceMeters)}m away (Registry ID: ${rec.registryId}, Programs: ${programsStr}). Disclaimer: Regulatory registration/permit record for user due diligence; not an automatic health hazard or environmental determination.`,
    });
  }

  // --------------------------------------------------------------------------
  // 4. Contrary Evidence & Uncertainty Signals
  // --------------------------------------------------------------------------
  for (const item of property.contraryEvidence ?? []) {
    whitelistServerEvidenceNumbers(`${item.title} ${item.detail}`, allowedNumbers);
    catalog.push({
      evidenceId: `ev_contrary_${item.code}`,
      sourceId: primaryPropertySource,
      label: `Contrary Signal: ${item.title}`,
      detail: `${item.title}: ${item.detail}`,
    });
  }

  // --------------------------------------------------------------------------
  // 5. Pre-compile Deterministic Factual Lists
  // --------------------------------------------------------------------------
  const positiveFactors: string[] = [];
  const contraryFactors: string[] = [];
  const limitations: string[] = [
    'RentCast AVM is an automated statistical comparable estimate; it is not a licensed physical appraisal or interior property inspection.',
    'Accessibility scores (0–100) measure user amenity convenience based on OpenStreetMap data, never market dollar value or appreciation.',
    'Distances are measured as straight-line WGS84 geodesic buffers, not walking-time or driving-time network isochrones.',
  ];

  if (rangePosition === 'in_range') {
    contraryFactors.push(
      `Asking price (${formatUsd(askingPrice)}) sits within the RentCast AVM confidence range [${formatUsd(avmLow)}, ${formatUsd(avmHigh)}], indicating expected valuation dispersion rather than proven undervaluation.`
    );
  } else if (rangePosition === 'below_estimate_range_candidate') {
    positiveFactors.push(
      `Asking price (${formatUsd(askingPrice)}) is below the RentCast AVM lower confidence bound (${formatUsd(avmLow)}), warranting focused human due diligence on condition and listing notes.`
    );
    contraryFactors.push(
      'Below-estimate range positioning is a due-diligence candidate signal, not a guaranteed discount or proven undervaluation.'
    );
  } else if (rangePosition === 'above_estimate_range_candidate') {
    contraryFactors.push(
      `Asking price (${formatUsd(askingPrice)}) exceeds the RentCast AVM upper confidence bound (${formatUsd(avmHigh)}), which may reflect uncaptured recent renovations, premium lot features, or seller optimism.`
    );
  }

  if (accessibility) {
    const strongCategories = (accessibility.categories ?? [])
      .filter((c) => (c.intensity ?? 0) >= 0.7 && c.weight > 0)
      .map((c) => `${c.label.toLowerCase()} (intensity ${(c.intensity ?? 0).toFixed(2)})`);

    if (strongCategories.length > 0) {
      positiveFactors.push(
        `High amenity accessibility observed for: ${strongCategories.join(', ')} under current user preferences.`
      );
    }

    const weakCategories = (accessibility.categories ?? [])
      .filter((c) => (c.intensity ?? 0) < 0.3 && c.weight > 0)
      .map((c) => `${c.label.toLowerCase()} (intensity ${(c.intensity ?? 0).toFixed(2)})`);

    if (weakCategories.length > 0) {
      contraryFactors.push(
        `Limited convenience accessibility for: ${weakCategories.join(', ')}.`
      );
    }
  }

  if (eligibleEnvRecords.length > 0) {
    contraryFactors.push(
      `${eligibleEnvRecords.length} EPA-registered regulatory facilities identified within the search radius; requires buyer review of permit types.`
    );
  }

  if (property.comparablesSummary?.subjectIncludedInComps) {
    contraryFactors.push(
      'Subject listing appears in its own RentCast AVM comparables set, which may introduce circular pricing bias.'
    );
  }

  const evidenceMap = new Map<string, ExplainEvidenceItem>();
  for (const item of catalog) {
    evidenceMap.set(item.evidenceId, item);
  }

  const facts: DeterministicFacts = Object.freeze({
    formattedAddress: property.formattedAddress,
    askingPrice,
    avmPrice,
    avmLow,
    avmHigh,
    gapPct,
    gapAmountUsd,
    rangePosition,
    assessedValue: property.assessedValue ?? null,
    lastSalePrice: property.lastSalePrice ?? null,
    accessibilityScore,
    allowedNumbers: Object.freeze(allowedNumbers),
    positiveFactors: Object.freeze(positiveFactors),
    contraryAndUncertaintyFactors: Object.freeze(contraryFactors),
    limitations: Object.freeze(limitations),
  });

  const dataAsOf: ExplainDataAsOf = {
    listingLastSeenAt: property.listingLastSeenAt ?? null,
    avmFetchedAt: property.avmFetchedAt ?? null,
    geospatialFetchedAt: geospatialFetchedAt ?? (accessibility ? new Date().toISOString() : null),
  };

  return {
    evidenceCatalog: catalog,
    evidenceMap,
    dataAsOf,
    facts,
  };
}
