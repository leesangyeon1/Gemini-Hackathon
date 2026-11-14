import { describe, expect, it } from 'vitest';
import {
  candidateToAnalysisArea,
  computeUncalibratedExternalityAdjustedIndex,
  computeUpperBoundScoreIfUnknownMaxed,
  formatCurrencyUsd,
  formatSignedPct,
} from '../../src/client/utils/formatters';
import {
  createSvgViewportProjection,
  projectLatLngToSvg,
  shiftCenterByMeters,
} from '../../src/client/utils/mapProjection';
import { SPRINGFIELD_CANDIDATES, makeAustinListing } from './fixtures';

describe('Client formatters and map projection utilities', () => {
  it('formats currency and signed percentages accurately', () => {
    expect(formatCurrencyUsd(900000)).toBe('$900,000');
    expect(formatCurrencyUsd(null)).toBe('Not available');
    expect(formatSignedPct(10)).toBe('+10.0%');
    expect(formatSignedPct(-4.25)).toBe('-4.3%');
    expect(formatSignedPct(null)).toBe('N/A');
  });

  it('computes upper bound for partial accessibility without silent renormalization', () => {
    const partialAccessibility = makeAustinListing().accessibility!;
    // score 78.5 with totalWeight 100 and knownWeight 80 => unknownWeight = 20 => +20 => 98.5
    expect(computeUpperBoundScoreIfUnknownMaxed(partialAccessibility)).toBe(98.5);
  });

  it('computes uncalibrated externality-adjusted preference index bounded to [0, 100]', () => {
    expect(computeUncalibratedExternalityAdjustedIndex(80, 2, 0)).toBe(80);
    expect(computeUncalibratedExternalityAdjustedIndex(80, 3, 15)).toBe(65);
    expect(computeUncalibratedExternalityAdjustedIndex(5, 3, 20)).toBe(0);
  });

  it('converts confirmed US RegionCandidate to AnalysisArea and rejects non-US', () => {
    const area = candidateToAnalysisArea(SPRINGFIELD_CANDIDATES[0], 2000);
    expect(area.isUsLocation).toBe(true);
    expect(area.isViewportApproximation).toBe(true);
    expect(area.radiusMeters).toBe(2000);
    expect(area.boundingBox.minLat).toBeLessThan(area.boundingBox.maxLat);

    expect(() =>
      candidateToAnalysisArea({ ...SPRINGFIELD_CANDIDATES[0], isUsLocation: false }, 1600)
    ).toThrow();
  });

  it('projects WGS84 center coordinates to SVG center and shifts coordinates deterministically', () => {
    const proj = createSvgViewportProjection(30.2672, -97.7431, 1600, 600, 400);
    const centerPx = projectLatLngToSvg({ lat: 30.2672, lng: -97.7431 }, proj);
    expect(centerPx.x).toBeCloseTo(300, 1);
    expect(centerPx.y).toBeCloseTo(200, 1);

    const north = shiftCenterByMeters(30.2672, -97.7431, 1000, 0);
    expect(north.lat).toBeGreaterThan(30.2672);
    expect(north.lng).toBeCloseTo(-97.7431, 5);
  });
});
