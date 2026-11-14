import React from 'react';
import { PRICE_GAP_RANGE_POSITIONS } from '../../shared/constants';
import { RANGE_POSITION_META } from '../utils/formatters';

export interface AccessibleLegendsProps {
  activeCategoryCount: number;
  maxObservedOverlap: number;
}

export const AccessibleLegends: React.FC<AccessibleLegendsProps> = ({
  activeCategoryCount,
  maxObservedOverlap,
}) => {
  return (
    <section className="legends-grid" aria-label="Map and Valuation Legends">
      {/* Legend 1: Facility Accessibility & Overlap Legend */}
      <article
        className="legend-card"
        aria-labelledby="legend-accessibility-heading"
        data-testid="legend-accessibility"
      >
        <h3 id="legend-accessibility-heading" className="legend-title">
          1. Facility Accessibility &amp; Overlap Legend
        </h3>
        <p className="legend-note">
          Uncalibrated user convenience score (0–100) + bounded grid multi-category overlap count (
          {maxObservedOverlap}/{Math.max(1, activeCategoryCount)} active categories).
        </p>

        <ul className="legend-items" aria-label="Accessibility score and grid overlap scale">
          <li className="legend-item">
            <span className="swatch swatch-overlap-high" aria-hidden="true">
              ★
            </span>
            <div>
              <strong>High Overlap Sweet Spot (75–100 score / {Math.max(2, activeCategoryCount)}+ categories)</strong>
              <span className="muted-xs">Multiple active facility kernels ≥ 0.25 overlap threshold</span>
            </div>
          </li>
          <li className="legend-item">
            <span className="swatch swatch-overlap-mid" aria-hidden="true">
              ◈
            </span>
            <div>
              <strong>Moderate Overlap (40–74 score / 2+ categories)</strong>
              <span className="muted-xs">Partial multi-category proximity within user radii</span>
            </div>
          </li>
          <li className="legend-item">
            <span className="swatch swatch-overlap-low" aria-hidden="true">
              ▫
            </span>
            <div>
              <strong>Low / Single-Category (0–39 score)</strong>
              <span className="muted-xs">Limited active facilities within straight-line kernel radii</span>
            </div>
          </li>
          <li className="legend-item">
            <span className="swatch swatch-epa" aria-hidden="true">
              ⬡
            </span>
            <div>
              <strong>US EPA FRS Record (Separate Due-Diligence Layer)</strong>
              <span className="muted-xs">Permit/registry lookup only — never an automatic health determination</span>
            </div>
          </li>
          <li className="legend-item">
            <span className="swatch swatch-places" aria-hidden="true">
              ◇
            </span>
            <div>
              <strong>Google Places Context (Excluded from Scoring)</strong>
              <span className="muted-xs">Display-only reference pins; blocked from scoring &amp; AI evidence</span>
            </div>
          </li>
        </ul>

        <p className="legend-disclaimer">
          Straight-line WGS84 geodesic radii are not walking-time or transit isochrones. Scores never
          represent market dollars and never multiply AVM estimates.
        </p>
      </article>

      {/* Legend 2: Asking-vs-AVM Price Gap & Range Legend */}
      <article
        className="legend-card"
        aria-labelledby="legend-price-gap-heading"
        data-testid="legend-price-gap"
      >
        <h3 id="legend-price-gap-heading" className="legend-title">
          2. Asking-vs-AVM Price Gap &amp; Range Legend
        </h3>
        <p className="legend-note">
          Compares active asking price against RentCast AVM midpoint and confidence bounds{' '}
          <code>[avmLow, avmHigh]</code>.
        </p>

        <ul className="legend-items" aria-label="Asking vs AVM range classification">
          {PRICE_GAP_RANGE_POSITIONS.map((position) => {
            const meta = RANGE_POSITION_META[position];
            return (
              <li key={position} className="legend-item">
                <span className={`range-badge ${meta.badgeClass}`} aria-hidden="true">
                  {meta.symbol}
                </span>
                <div>
                  <strong>{meta.label}</strong>
                  <span className="muted-xs">{meta.description}</span>
                </div>
              </li>
            );
          })}
        </ul>

        <p className="legend-disclaimer">
          RentCast AVM is a comparable-listing statistical estimate, not a physical appraisal or
          proven undervaluation signal.
        </p>
      </article>
    </section>
  );
};
