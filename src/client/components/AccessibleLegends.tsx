import React, { useRef, useState } from 'react';
import { PRICE_GAP_RANGE_POSITIONS } from '../../shared/constants';
import { RANGE_POSITION_META } from '../utils/formatters';

export interface LegendSourceDates {
  osmOverpass?: string | null;
  epaFrs?: string | null;
  googlePlaces?: string | null;
  rentCastAvm?: string | null;
}

export interface AccessibleLegendsProps {
  activeCategoryCount: number;
  maxObservedOverlap: number;
  sourceDates?: LegendSourceDates;
  defaultExpanded?: {
    accessibility?: boolean;
    priceGap?: boolean;
  };
}

type LegendSectionKey = 'accessibility' | 'priceGap';

interface SourceAttributionItem {
  id: string;
  sourceLabel: string;
  detail: string;
  dateText: string;
  pillStyle: React.CSSProperties;
}

function formatSourceDateLabel(rawDate?: string | null): string {
  const trimmed = typeof rawDate === 'string' ? rawDate.trim() : '';
  return trimmed.length > 0 ? `Date: ${trimmed}` : 'Date: Per active query';
}

const disclosureButtonBaseStyle: React.CSSProperties = {
  width: '100%',
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '0.75rem',
  backgroundColor: 'transparent',
  border: '1px solid transparent',
  borderRadius: '0.5rem',
  padding: '0.375rem 0.5rem',
  margin: '-0.375rem -0.5rem 0.5rem',
  textAlign: 'left',
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
};

const attributionListStyle: React.CSSProperties = {
  listStyle: 'none',
  margin: '0.75rem 0',
  padding: 0,
  display: 'flex',
  flexDirection: 'column',
  gap: '0.5rem',
};

const attributionRowStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  padding: '0.5rem 0.625rem',
  borderRadius: '0.5rem',
  border: '1px solid #e2e8f0',
  backgroundColor: '#f8fafc',
};

const attributionHeaderStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '0.375rem',
};

const dateBadgeStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '0.125rem 0.5rem',
  borderRadius: '9999px',
  fontSize: '0.75rem',
  fontWeight: 600,
  backgroundColor: '#e2e8f0',
  color: '#1e293b',
  whiteSpace: 'nowrap',
};

export const AccessibleLegends: React.FC<AccessibleLegendsProps> = ({
  activeCategoryCount,
  maxObservedOverlap,
  sourceDates,
  defaultExpanded,
}) => {
  const [expanded, setExpanded] = useState<Record<LegendSectionKey, boolean>>({
    accessibility: defaultExpanded?.accessibility ?? true,
    priceGap: defaultExpanded?.priceGap ?? true,
  });

  const accessibilityButtonRef = useRef<HTMLButtonElement | null>(null);
  const priceGapButtonRef = useRef<HTMLButtonElement | null>(null);

  const safeActiveCount = Number.isFinite(activeCategoryCount)
    ? Math.max(0, activeCategoryCount)
    : 0;
  const safeMaxOverlap = Number.isFinite(maxObservedOverlap)
    ? Math.max(0, maxObservedOverlap)
    : 0;

  const toggleSection = (section: LegendSectionKey) => {
    setExpanded((prev) => ({
      ...prev,
      [section]: !prev[section],
    }));
  };

  const handleDisclosureKeyDown = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    current: LegendSectionKey
  ) => {
    if (
      event.key === 'ArrowDown' ||
      event.key === 'ArrowRight' ||
      event.key === 'ArrowUp' ||
      event.key === 'ArrowLeft'
    ) {
      event.preventDefault();
      const targetRef =
        current === 'accessibility' ? priceGapButtonRef : accessibilityButtonRef;
      targetRef.current?.focus();
    } else if (event.key === 'Home') {
      event.preventDefault();
      accessibilityButtonRef.current?.focus();
    } else if (event.key === 'End') {
      event.preventDefault();
      priceGapButtonRef.current?.focus();
    }
  };

  const accessibilityAttributions: SourceAttributionItem[] = [
    {
      id: 'osm-overpass',
      sourceLabel: 'OpenStreetMap & Overpass API (ODbL 1.0)',
      detail: 'Linear geodesic amenity kernels.',
      dateText: formatSourceDateLabel(sourceDates?.osmOverpass),
      pillStyle: {
        backgroundColor: '#ccfbf1',
        color: '#115e59',
        border: '1px solid #99f6e4',
      },
    },
    {
      id: 'epa-frs',
      sourceLabel: 'US EPA FRS / Envirofacts',
      detail: 'Neutral regulatory records due-diligence layer (NOT an automatic health determination).',
      dateText: formatSourceDateLabel(sourceDates?.epaFrs),
      pillStyle: {
        backgroundColor: '#fef3c7',
        color: '#92400e',
        border: '1px solid #fde68a',
      },
    },
    {
      id: 'google-places',
      sourceLabel: 'Google Places Context (Excluded from Scoring & AI evidence)',
      detail: 'Display-only reference pins.',
      dateText: formatSourceDateLabel(sourceDates?.googlePlaces),
      pillStyle: {
        backgroundColor: '#e2e8f0',
        color: '#334155',
        border: '1px solid #cbd5e1',
      },
    },
  ];

  const priceGapAttributions: SourceAttributionItem[] = [
    {
      id: 'rentcast-avm',
      sourceLabel: 'RentCast AVM',
      detail:
        'Statistical comparable-listing estimate (NOT a physical appraisal or proven undervaluation).',
      dateText: formatSourceDateLabel(sourceDates?.rentCastAvm),
      pillStyle: {
        backgroundColor: '#e0e7ff',
        color: '#3730a3',
        border: '1px solid #c7d2fe',
      },
    },
  ];

  return (
    <section className="legends-grid" aria-label="Map and Valuation Legends">
      {/* Legend 1: Facility Accessibility & Overlap Legend */}
      <article
        className="legend-card"
        aria-labelledby="legend-accessibility-heading"
        data-testid="legend-accessibility"
        style={{
          borderTop: '4px solid #0f766e',
          borderLeft: '4px solid #0f766e',
        }}
      >
        <h3 id="legend-accessibility-heading" className="legend-title" style={{ margin: 0 }}>
          <button
            ref={accessibilityButtonRef}
            type="button"
            className="legend-disclosure-btn"
            aria-expanded={expanded.accessibility}
            aria-controls="legend-accessibility-panel"
            onClick={() => toggleSection('accessibility')}
            onKeyDown={(e) => handleDisclosureKeyDown(e, 'accessibility')}
            style={disclosureButtonBaseStyle}
          >
            <span style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem' }}>
                <span>1. Facility Accessibility &amp; Overlap Legend</span>
                <span
                  className="pill"
                  style={{
                    backgroundColor: '#ccfbf1',
                    color: '#115e59',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                  }}
                >
                  0–100 Score · Non-Monetary
                </span>
              </span>
              <span className="muted-xs" style={{ fontWeight: 400 }}>
                Overlap count: {safeMaxOverlap}/{Math.max(1, safeActiveCount)} active categories ·
                Sweet spot: {Math.max(2, safeActiveCount)}+ categories
              </span>
            </span>
            <span
              aria-hidden="true"
              style={{
                flexShrink: 0,
                fontSize: '0.8125rem',
                fontWeight: 600,
                color: '#0f766e',
                paddingTop: '0.125rem',
              }}
            >
              {expanded.accessibility ? '▾ Hide' : '▸ Show'}
            </span>
          </button>
        </h3>

        <div
          id="legend-accessibility-panel"
          role="region"
          aria-labelledby="legend-accessibility-heading"
          hidden={!expanded.accessibility}
          style={{ display: expanded.accessibility ? undefined : 'none' }}
        >
          <p className="legend-note">
            Uncalibrated user convenience score (0–100) + bounded grid multi-category overlap count (
            {safeMaxOverlap}/{Math.max(1, safeActiveCount)} active categories).
          </p>

          <ul className="legend-items" aria-label="Accessibility score and grid overlap scale">
            <li className="legend-item">
              <span className="swatch swatch-overlap-high" aria-hidden="true">
                ★
              </span>
              <div>
                <strong>
                  High Overlap Sweet Spot (75–100 score / {Math.max(2, safeActiveCount)}+ categories)
                </strong>
                <span className="muted-xs">
                  Multiple active facility kernels ≥ 0.25 overlap threshold
                </span>
              </div>
            </li>
            <li className="legend-item">
              <span className="swatch swatch-overlap-mid" aria-hidden="true">
                ◈
              </span>
              <div>
                <strong>Moderate Overlap (40–74 score / 2+ categories)</strong>
                <span className="muted-xs">
                  Partial multi-category proximity within user radii
                </span>
              </div>
            </li>
            <li className="legend-item">
              <span className="swatch swatch-overlap-low" aria-hidden="true">
                ▫
              </span>
              <div>
                <strong>Low / Single-Category (0–39 score)</strong>
                <span className="muted-xs">
                  Limited active facilities within straight-line kernel radii
                </span>
              </div>
            </li>
            <li className="legend-item">
              <span className="swatch swatch-epa" aria-hidden="true">
                ⬡
              </span>
              <div>
                <strong>US EPA FRS Record (Separate Due-Diligence Layer)</strong>
                <span className="muted-xs">
                  Permit/registry lookup only — never an automatic health determination
                </span>
              </div>
            </li>
            <li className="legend-item">
              <span className="swatch swatch-places" aria-hidden="true">
                ◇
              </span>
              <div>
                <strong>Google Places Context (Excluded from Scoring)</strong>
                <span className="muted-xs">
                  Display-only reference pins; blocked from scoring &amp; AI evidence
                </span>
              </div>
            </li>
          </ul>

          <div aria-label="Accessibility layer data sources and dates">
            <ul style={attributionListStyle}>
              {accessibilityAttributions.map((item) => (
                <li
                  key={item.id}
                  data-testid={`source-badge-${item.id}`}
                  style={attributionRowStyle}
                >
                  <div style={attributionHeaderStyle}>
                    <span className="pill" style={item.pillStyle}>
                      {item.sourceLabel}
                    </span>
                    <span style={dateBadgeStyle}>{item.dateText}</span>
                  </div>
                  <span className="muted-xs">{item.detail}</span>
                </li>
              ))}
            </ul>
          </div>

          <p className="legend-disclaimer">
            Straight-line WGS84 geodesic radii are not walking-time or transit isochrones. Scores
            never represent market dollars and never multiply AVM estimates.
          </p>
        </div>
      </article>

      {/* Legend 2: Asking-vs-AVM Price Gap & Range Legend */}
      <article
        className="legend-card"
        aria-labelledby="legend-price-gap-heading"
        data-testid="legend-price-gap"
        style={{
          borderTop: '4px solid #4338ca',
          borderLeft: '4px solid #4338ca',
        }}
      >
        <h3 id="legend-price-gap-heading" className="legend-title" style={{ margin: 0 }}>
          <button
            ref={priceGapButtonRef}
            type="button"
            className="legend-disclosure-btn"
            aria-expanded={expanded.priceGap}
            aria-controls="legend-price-gap-panel"
            onClick={() => toggleSection('priceGap')}
            onKeyDown={(e) => handleDisclosureKeyDown(e, 'priceGap')}
            style={disclosureButtonBaseStyle}
          >
            <span style={{ display: 'flex', flexDirection: 'column', gap: '0.25rem' }}>
              <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '0.5rem' }}>
                <span>2. Asking-vs-AVM Price Gap &amp; Range Legend</span>
                <span
                  className="pill"
                  style={{
                    backgroundColor: '#e0e7ff',
                    color: '#3730a3',
                    fontSize: '0.75rem',
                    fontWeight: 600,
                  }}
                >
                  Asking vs. [avmLow, avmHigh]
                </span>
              </span>
              <span className="muted-xs" style={{ fontWeight: 400 }}>
                Confidence range classification using <code>avmLow</code> and <code>avmHigh</code>
              </span>
            </span>
            <span
              aria-hidden="true"
              style={{
                flexShrink: 0,
                fontSize: '0.8125rem',
                fontWeight: 600,
                color: '#4338ca',
                paddingTop: '0.125rem',
              }}
            >
              {expanded.priceGap ? '▾ Hide' : '▸ Show'}
            </span>
          </button>
        </h3>

        <div
          id="legend-price-gap-panel"
          role="region"
          aria-labelledby="legend-price-gap-heading"
          hidden={!expanded.priceGap}
          style={{ display: expanded.priceGap ? undefined : 'none' }}
        >
          <p className="legend-note">
            Compares active asking price against RentCast AVM midpoint and confidence bounds{' '}
            <code>avmLow</code> to <code>avmHigh</code> (<code>[avmLow, avmHigh]</code>).
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

          <div aria-label="Valuation data source and date">
            <ul style={attributionListStyle}>
              {priceGapAttributions.map((item) => (
                <li
                  key={item.id}
                  data-testid={`source-badge-${item.id}`}
                  style={attributionRowStyle}
                >
                  <div style={attributionHeaderStyle}>
                    <span className="pill" style={item.pillStyle}>
                      {item.sourceLabel}
                    </span>
                    <span style={dateBadgeStyle}>{item.dateText}</span>
                  </div>
                  <span className="muted-xs">{item.detail}</span>
                </li>
              ))}
            </ul>
          </div>

          <p className="legend-disclaimer">
            RentCast AVM is a comparable-listing statistical estimate, not a physical appraisal or
            proven undervaluation signal.
          </p>
        </div>
      </article>
    </section>
  );
};
