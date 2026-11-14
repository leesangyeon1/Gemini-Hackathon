import {
  AMENITY_CATEGORIES,
  DEFAULT_PREFERENCE_CAPS,
  DEFAULT_PREFERENCE_RADII_METERS,
  DEFAULT_PREFERENCE_WEIGHTS,
  VIEWPORT_APPROXIMATION_DISCLAIMER,
} from '../../shared/constants';
import type {
  AccessibilityResult,
  AmenityCategory,
  AnalysisArea,
  PreferenceProfile,
  PriceGapRangePosition,
  RegionCandidate,
} from '../../shared/types';

export function formatCurrencyUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'Not available';
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatSignedPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return 'N/A';
  }
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

export function formatDistanceMeters(meters: number | null | undefined): string {
  if (meters === null || meters === undefined || !Number.isFinite(meters)) {
    return 'N/A';
  }
  if (meters >= 1000) {
    const miles = meters / 1609.344;
    return `${Math.round(meters).toLocaleString('en-US')} m (${miles.toFixed(2)} mi)`;
  }
  return `${Math.round(meters).toLocaleString('en-US')} m`;
}

export function formatIsoDate(isoString: string | null | undefined): string {
  if (!isoString) {
    return 'Not reported';
  }
  const parsed = new Date(isoString);
  if (Number.isNaN(parsed.getTime())) {
    return isoString;
  }
  return parsed.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

export function formatIsoDateTime(isoString: string | null | undefined): string {
  if (!isoString) {
    return 'Not reported';
  }
  const parsed = new Date(isoString);
  if (Number.isNaN(parsed.getTime())) {
    return isoString;
  }
  return `${parsed.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

export interface RangePositionDisplayMeta {
  position: PriceGapRangePosition;
  label: string;
  shortLabel: string;
  symbol: string;
  badgeClass: string;
  description: string;
}

export const RANGE_POSITION_META: Record<PriceGapRangePosition, RangePositionDisplayMeta> = {
  below_estimate_range_candidate: {
    position: 'below_estimate_range_candidate',
    label: 'Below Estimate Range (Candidate)',
    shortLabel: 'Below Range',
    symbol: '▼',
    badgeClass: 'badge-below-range',
    description:
      'Asking price is below RentCast AVM low bound (avmLow). Candidate signal for human due diligence — never proven undervaluation.',
  },
  in_range: {
    position: 'in_range',
    label: 'Inside AVM Range',
    shortLabel: 'In Range',
    symbol: '●',
    badgeClass: 'badge-in-range',
    description:
      'Asking price sits inside [avmLow, avmHigh]. Even a positive midpoint gap (e.g., +10%) inside the range reflects normal statistical dispersion.',
  },
  above_estimate_range_candidate: {
    position: 'above_estimate_range_candidate',
    label: 'Above Estimate Range (Candidate)',
    shortLabel: 'Above Range',
    symbol: '▲',
    badgeClass: 'badge-above-range',
    description:
      'Asking price is above RentCast AVM high bound (avmHigh). May reflect renovations, lot factors, or seller pricing expectations.',
  },
  range_unknown: {
    position: 'range_unknown',
    label: 'Range Unknown',
    shortLabel: 'Range Unknown',
    symbol: '◆',
    badgeClass: 'badge-range-unknown',
    description:
      'AVM midpoint is present, but confidence bounds [avmLow, avmHigh] are missing or invalid.',
  },
  no_avm: {
    position: 'no_avm',
    label: 'No AVM Fetched',
    shortLabel: 'No AVM',
    symbol: '○',
    badgeClass: 'badge-no-avm',
    description:
      'AVM has not been fetched yet for this listing. Select the home and click Fetch RentCast AVM (1 API Call).',
  },
};

export const CATEGORY_COLORS: Record<AmenityCategory, { fill: string; stroke: string; symbol: string }> = {
  grocery: { fill: '#0f766e', stroke: '#115e59', symbol: 'G' },
  parks: { fill: '#15803d', stroke: '#166534', symbol: 'P' },
  transit: { fill: '#1d4ed8', stroke: '#1e40af', symbol: 'T' },
  healthcare: { fill: '#be123c', stroke: '#9f1239', symbol: 'H' },
  schools: { fill: '#7e22ce', stroke: '#6b21a8', symbol: 'S' },
  fast_food: { fill: '#b45309', stroke: '#92400e', symbol: 'C' },
};

export function createClientDefaultPreferences(): PreferenceProfile {
  return {
    weights: { ...DEFAULT_PREFERENCE_WEIGHTS },
    radiiMeters: { ...DEFAULT_PREFERENCE_RADII_METERS },
    caps: { ...DEFAULT_PREFERENCE_CAPS },
    includeEnvironmentalDueDiligenceLayer: true,
    optionalExternalityPenaltyWeight: 0,
  };
}

export function clonePreferences(prefs: PreferenceProfile): PreferenceProfile {
  return {
    weights: { ...prefs.weights },
    radiiMeters: { ...prefs.radiiMeters },
    caps: prefs.caps ? { ...prefs.caps } : { ...DEFAULT_PREFERENCE_CAPS },
    includeEnvironmentalDueDiligenceLayer: prefs.includeEnvironmentalDueDiligenceLayer ?? true,
    optionalExternalityPenaltyWeight: prefs.optionalExternalityPenaltyWeight ?? 0,
  };
}

export function getActiveCategories(prefs: PreferenceProfile): AmenityCategory[] {
  return AMENITY_CATEGORIES.filter((cat) => (prefs.weights[cat] ?? 0) > 0);
}

/**
 * Computes the theoretical upper bound score if every `unknown` weighted category achieved 1.0 intensity.
 */
export function computeUpperBoundScoreIfUnknownMaxed(result: AccessibilityResult): number | null {
  if (result.completeness === 'complete' || result.totalWeight <= 0) {
    return null;
  }
  const unknownWeight = Math.max(0, result.totalWeight - result.knownWeight);
  const maxPossible = result.score + (100 * unknownWeight) / result.totalWeight;
  return Math.min(100, Math.round(maxPossible * 10) / 10);
}

/**
 * Computes an optional, explicitly uncalibrated externality preference display index
 * (`0..100`) strictly for user exploration. Never market dollars, never multiplies AVM.
 */
export function computeUncalibratedExternalityAdjustedIndex(
  baseAccessibilityScore: number,
  nearbyEnvironmentalCount: number,
  externalityPenaltyWeight: number
): number {
  if (externalityPenaltyWeight <= 0 || nearbyEnvironmentalCount <= 0) {
    return Math.round(baseAccessibilityScore * 10) / 10;
  }
  const penaltyPoints = Math.min(externalityPenaltyWeight, nearbyEnvironmentalCount * (externalityPenaltyWeight / 3));
  return Math.max(0, Math.round((baseAccessibilityScore - penaltyPoints) * 10) / 10);
}

/**
 * Converts a confirmed US RegionCandidate into an AnalysisArea with a chosen radius.
 */
export function candidateToAnalysisArea(
  candidate: RegionCandidate,
  radiusMeters?: number
): AnalysisArea {
  if (!candidate.isUsLocation) {
    throw new Error('Cannot convert non-US candidate into AnalysisArea.');
  }
  const chosenRadius = Math.max(
    400,
    Math.min(5000, radiusMeters ?? candidate.suggestedRadiusMeters ?? 1600)
  );
  const latDelta = chosenRadius / 111_320;
  const cosLat = Math.max(0.15, Math.cos((candidate.centerLat * Math.PI) / 180));
  const lngDelta = chosenRadius / (111_320 * cosLat);

  return {
    areaId: candidate.candidateId,
    label: candidate.displayName,
    centerLat: candidate.centerLat,
    centerLng: candidate.centerLng,
    radiusMeters: chosenRadius,
    boundingBox: {
      minLat: Number((candidate.centerLat - latDelta).toFixed(6)),
      maxLat: Number((candidate.centerLat + latDelta).toFixed(6)),
      minLng: Number((candidate.centerLng - lngDelta).toFixed(6)),
      maxLng: Number((candidate.centerLng + lngDelta).toFixed(6)),
    },
    city: candidate.city,
    state: candidate.state,
    zipCode: candidate.zipCode,
    isUsLocation: true,
    isViewportApproximation: true,
    approximationDisclaimer: VIEWPORT_APPROXIMATION_DISCLAIMER,
  };
}
