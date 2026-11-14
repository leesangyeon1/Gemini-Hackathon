import React from 'react';
import { AMENITY_CATEGORY_METADATA } from '../../shared/constants';
import type {
  AmenityCategory,
  EnvironmentalRecord,
  ExplainResponse,
  PropertyDetailRecord,
  PropertyListingSummary,
} from '../../shared/types';
import {
  RANGE_POSITION_META,
  computeUncalibratedExternalityAdjustedIndex,
  computeUpperBoundScoreIfUnknownMaxed,
  formatCurrencyUsd,
  formatDistanceMeters,
  formatIsoDate,
  formatIsoDateTime,
  formatSignedPct,
} from '../utils/formatters';

export interface PropertyDetailDrawerProps {
  property: PropertyDetailRecord | PropertyListingSummary | null;
  environmentalRecords: EnvironmentalRecord[];
  geospatialFetchedAt: string | null;
  externalityPenaltyWeight: number;
  isFetchingAvm: boolean;
  avmError: string | null;
  avmFromCache: boolean;
  avmDisclaimers: string[];
  explainResponse: ExplainResponse | null;
  isExplaining: boolean;
  explainError: string | null;
  isSyntheticDemo: boolean;
  onFetchAvm: (propertyId: string) => void;
  onGenerateExplain: (propertyId: string) => void;
}

function isDetailRecord(
  p: PropertyDetailRecord | PropertyListingSummary
): p is PropertyDetailRecord {
  return 'contraryEvidence' in p && Array.isArray(p.contraryEvidence);
}

export const PropertyDetailDrawer: React.FC<PropertyDetailDrawerProps> = ({
  property,
  environmentalRecords,
  geospatialFetchedAt,
  externalityPenaltyWeight,
  isFetchingAvm,
  avmError,
  avmFromCache,
  avmDisclaimers,
  explainResponse,
  isExplaining,
  explainError,
  isSyntheticDemo,
  onFetchAvm,
  onGenerateExplain,
}) => {
  if (!property) {
    return (
      <section
        className="card detail-panel"
        aria-label="Selected Home Comparison and Explanation"
        data-testid="property-detail-empty"
      >
        <h2 className="panel-title">Selected Home · On-Demand AVM &amp; Due Diligence</h2>
        <p className="muted-sm">
          Select a listing from the map or property list to inspect asking price, listing timestamp,
          category-by-category accessibility breakdown, nearby EPA FRS records, and optionally fetch
          its RentCast AVM estimate.
        </p>
      </section>
    );
  }

  const gapMeta = RANGE_POSITION_META[property.priceGap.rangePosition];
  const hasAvm = property.avmPrice !== null;
  const hasRange =
    property.avmLow !== null &&
    property.avmHigh !== null &&
    property.avmLow > 0 &&
    property.avmHigh >= property.avmLow;

  // Compute normalized positions on the [avmLow..avmHigh] visual comparison bar
  let barMin = 0;
  let barMax = 1;
  if (hasRange && property.avmLow !== null && property.avmHigh !== null) {
    const candidates = [property.avmLow, property.avmHigh];
    if (property.askingPrice !== null) candidates.push(property.askingPrice);
    if (property.avmPrice !== null) candidates.push(property.avmPrice);
    const minV = Math.min(...candidates);
    const maxV = Math.max(...candidates);
    const pad = Math.max(10_000, (maxV - minV) * 0.12);
    barMin = Math.max(0, minV - pad);
    barMax = maxV + pad;
  }
  const toPct = (val: number) => {
    const span = Math.max(1, barMax - barMin);
    return Math.max(0, Math.min(100, ((val - barMin) / span) * 100));
  };

  const contraryItems = isDetailRecord(property) ? property.contraryEvidence : [];
  const accessibility = property.accessibility;
  const upperBound = accessibility ? computeUpperBoundScoreIfUnknownMaxed(accessibility) : null;

  const isPositiveGapInsideRange =
    property.priceGap.gapPct !== null &&
    property.priceGap.gapPct > 0 &&
    property.priceGap.rangePosition === 'in_range';

  const evidenceById = new Map(
    (explainResponse?.evidenceCatalog ?? []).map((item) => [item.evidenceId, item])
  );

  const sortedEnvRecords = [...environmentalRecords]
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, 6);

  return (
    <section
      className="card detail-panel"
      aria-label={`Selected Home Details for ${property.formattedAddress}`}
      data-testid="property-detail-drawer"
    >
      <div className="detail-header">
        <div>
          <div className="detail-title-row">
            <h2 className="panel-title">{property.formattedAddress}</h2>
            {(isSyntheticDemo || property.dataProvenance === 'synthetic_demo') && (
              <span className="pill pill-demo">SYNTHETIC DEMO FIXTURE</span>
            )}
          </div>
          <p className="muted-xs">
            {property.propertyType}
            {property.bedrooms !== null ? ` · ${property.bedrooms} bd` : ''}
            {property.bathrooms !== null ? ` · ${property.bathrooms} ba` : ''}
            {property.squareFootage !== null
              ? ` · ${property.squareFootage.toLocaleString('en-US')} sq ft`
              : ''}
            {property.yearBuilt !== null ? ` · Built ${property.yearBuilt}` : ''}
          </p>
        </div>

        <span className={`range-badge ${gapMeta.badgeClass}`} data-testid="detail-range-badge">
          {gapMeta.symbol} {gapMeta.label}
        </span>
      </div>

      {/* Distinct Price & Valuation Facts Grid */}
      <div className="facts-grid" aria-label="Distinct property pricing and valuation fields">
        <div className="fact-card">
          <span className="fact-label">Active Asking Price</span>
          <strong className="fact-value" data-testid="detail-asking-price">
            {formatCurrencyUsd(property.askingPrice)}
          </strong>
          <span className="muted-xs">
            Listing last seen: {formatIsoDateTime(property.listingLastSeenAt)}
          </span>
        </div>

        <div className="fact-card">
          <span className="fact-label">
            RentCast AVM Midpoint {avmFromCache ? '(Cached)' : ''}
          </span>
          <strong className="fact-value" data-testid="detail-avm-price">
            {formatCurrencyUsd(property.avmPrice)}
          </strong>
          <span className="muted-xs">
            AVM fetched: {formatIsoDateTime(property.avmFetchedAt)}
          </span>
        </div>

        <div className="fact-card">
          <span className="fact-label">AVM Confidence Range</span>
          <strong className="fact-value" data-testid="detail-avm-range">
            {hasRange
              ? `${formatCurrencyUsd(property.avmLow)} – ${formatCurrencyUsd(property.avmHigh)}`
              : 'Not available'}
          </strong>
          <span className="muted-xs">
            Midpoint gap:{' '}
            <strong>{formatSignedPct(property.priceGap.gapPct)}</strong>
            {property.priceGap.gapAmountUsd !== null
              ? ` (${formatCurrencyUsd(property.priceGap.gapAmountUsd)})`
              : ''}
          </span>
        </div>

        <div className="fact-card">
          <span className="fact-label">Historical Last Sale &amp; Assessed</span>
          <strong className="fact-value">
            {formatCurrencyUsd(property.lastSalePrice)}
          </strong>
          <span className="muted-xs">
            Last sale date: {formatIsoDate(property.lastSaleDate)} · Assessed:{' '}
            {formatCurrencyUsd(property.assessedValue)}
            {property.assessedYear ? ` (${property.assessedYear})` : ''}
          </span>
        </div>
      </div>

      {/* On-Demand AVM Fetch Button */}
      <div className="avm-action-bar">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => onFetchAvm(property.id)}
          disabled={isFetchingAvm}
          data-testid="fetch-avm-button"
        >
          {isFetchingAvm
            ? 'Fetching RentCast AVM…'
            : hasAvm
              ? 'Refresh / Re-Check RentCast AVM (Cached = 0 Calls)'
              : 'Fetch RentCast AVM for This Home (1 API Call)'}
        </button>

        {avmError && (
          <div className="status-box status-error" role="alert">
            {avmError}
          </div>
        )}
      </div>

      {/* Visual [avmLow, avmHigh] Range Comparison vs Asking Price */}
      {hasAvm && hasRange && property.avmLow !== null && property.avmHigh !== null && (
        <div className="range-visual-box" data-testid="avm-range-visual">
          <div className="range-visual-header">
            <strong>Asking Price vs. [avmLow, avmHigh] Statistical Band</strong>
            <span className="muted-xs">{property.priceGap.interpretationNote}</span>
          </div>

          <div
            className="range-bar-track"
            role="img"
            aria-label={`AVM confidence range from ${formatCurrencyUsd(property.avmLow)} to ${formatCurrencyUsd(property.avmHigh)}, midpoint ${formatCurrencyUsd(property.avmPrice)}, asking price ${formatCurrencyUsd(property.askingPrice)}`}
          >
            <div
              className="range-bar-band"
              style={{
                left: `${toPct(property.avmLow)}%`,
                width: `${Math.max(4, toPct(property.avmHigh) - toPct(property.avmLow))}%`,
              }}
            />
            {property.avmPrice !== null && (
              <div
                className="range-marker-avm"
                style={{ left: `${toPct(property.avmPrice)}%` }}
                title={`AVM Midpoint: ${formatCurrencyUsd(property.avmPrice)}`}
              />
            )}
            {property.askingPrice !== null && (
              <div
                className="range-marker-asking"
                style={{ left: `${toPct(property.askingPrice)}%` }}
                title={`Asking Price: ${formatCurrencyUsd(property.askingPrice)}`}
              />
            )}
          </div>

          <div className="range-bar-legend muted-xs">
            <span>Low: {formatCurrencyUsd(property.avmLow)}</span>
            <span>Midpoint: {formatCurrencyUsd(property.avmPrice)}</span>
            <span>High: {formatCurrencyUsd(property.avmHigh)}</span>
            <span>Asking: {formatCurrencyUsd(property.askingPrice)}</span>
          </div>
        </div>
      )}

      {/* Accessibility Breakdown for this Property */}
      {accessibility && (
        <div className="detail-section">
          <h3 className="panel-title-sm">
            Property Accessibility Breakdown: {accessibility.score.toFixed(1)} / 100 (
            {accessibility.completeness})
          </h3>
          {externalityPenaltyWeight > 0 && (
            <p className="muted-xs">
              Uncalibrated User Preference w/ EPA Context (Not Market Dollars):{' '}
              <strong>
                {computeUncalibratedExternalityAdjustedIndex(
                  accessibility.score,
                  property.nearbyEnvironmentalCount,
                  externalityPenaltyWeight
                ).toFixed(1)}{' '}
                / 100
              </strong>
            </p>
          )}
          <div className="cat-breakdown-grid">
            {accessibility.categories.map((cat) => {
              const key = cat.category as AmenityCategory;
              const label =
                key in AMENITY_CATEGORY_METADATA
                  ? AMENITY_CATEGORY_METADATA[key].shortLabel
                  : cat.label;
              return (
                <div key={cat.category} className="cat-chip-stat">
                  <span>{label} (w={cat.weight})</span>
                  <strong>
                    {cat.status === 'unknown'
                      ? 'Unknown'
                      : `${((cat.intensity ?? 0) * 100).toFixed(0)}% · ${cat.facilityCount} nearby`}
                  </strong>
                  <span className="muted-xs">
                    Nearest: {formatDistanceMeters(cat.nearestDistanceMeters)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Contrary Evidence & Uncertainty Cards */}
      <div className="detail-section" data-testid="contrary-evidence-section">
        <h3 className="panel-title-sm">Contrary Evidence &amp; Uncertainty</h3>
        <div className="contrary-cards">
          {isPositiveGapInsideRange && (
            <article className="contrary-card contrary-caution">
              <strong>
                Positive Midpoint Gap ({formatSignedPct(property.priceGap.gapPct)}) Still Inside
                AVM Range
              </strong>
              <p>
                Asking price ({formatCurrencyUsd(property.askingPrice)}) is below the AVM midpoint (
                {formatCurrencyUsd(property.avmPrice)}), yet sits within [
                {formatCurrencyUsd(property.avmLow)}, {formatCurrencyUsd(property.avmHigh)}]. This
                reflects normal statistical dispersion — not proven undervaluation.
              </p>
            </article>
          )}

          {property.comparablesSummary?.subjectIncludedInComps && (
            <article className="contrary-card contrary-warning">
              <strong>Subject-in-Comps Circularity Warning</strong>
              <p>
                RentCast&apos;s comparable set includes this active subject listing itself. Treat the
                AVM midpoint and range with extra caution due to potential circularity.
              </p>
            </article>
          )}

          {accessibility && accessibility.missingOrFailedCategories.length > 0 && (
            <article className="contrary-card contrary-caution">
              <strong>
                Incomplete Geospatial Coverage ({accessibility.completeness})
              </strong>
              <p>
                Missing/unknown weighted categories:{' '}
                <code>{accessibility.missingOrFailedCategories.join(', ')}</code>. Weights are held
                in the denominator (no silent renormalization).
                {upperBound !== null
                  ? ` Theoretical upper bound if unknown categories maxed: ${upperBound.toFixed(1)}/100.`
                  : ''}
              </p>
            </article>
          )}

          {contraryItems.map((item, i) => (
            <article
              key={`${item.code}-${i}`}
              className={`contrary-card contrary-${item.severity}`}
            >
              <strong>{item.title}</strong>
              <p>{item.detail}</p>
            </article>
          ))}

          {sortedEnvRecords.length > 0 && (
            <article className="contrary-card contrary-info">
              <strong>
                Nearby US EPA FRS Registry Records ({sortedEnvRecords.length} in area)
              </strong>
              <p className="muted-xs">
                Permit/program due-diligence records only — never an automatic environmental hazard
                or health determination.
              </p>
              <ul className="epa-mini-list">
                {sortedEnvRecords.map((rec) => (
                  <li key={rec.id}>
                    <strong>{rec.name}</strong> ({rec.registryId}) —{' '}
                    {formatDistanceMeters(rec.distanceMeters)} · Programs:{' '}
                    {rec.programs.join(', ') || 'Registered'}
                  </li>
                ))}
              </ul>
            </article>
          )}

          {!hasAvm && contraryItems.length === 0 && (
            <p className="muted-xs">
              Fetch the on-demand RentCast AVM above to run range-dispersion, comparable-circularity,
              and stale-data checks.
            </p>
          )}
        </div>

        {property.comparablesSummary && (
          <div className="comps-summary-strip muted-xs">
            <span>Comps: {property.comparablesSummary.compCount}</span>
            <span>
              Median Comp: {formatCurrencyUsd(property.comparablesSummary.medianCompPrice)}
            </span>
            <span>
              Subject in Comps:{' '}
              <strong>{property.comparablesSummary.subjectIncludedInComps ? 'YES' : 'No'}</strong>
            </span>
          </div>
        )}
      </div>

      {/* Grounded Gemini Explanation */}
      <div className="detail-section" data-testid="explain-section">
        <div className="panel-header-row">
          <div>
            <h3 className="panel-title-sm">Grounded AI Explanation (`/api/explain`)</h3>
            <p className="muted-xs">
              Server validates every cited evidence ID and number against deterministic backend data.
            </p>
          </div>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => onGenerateExplain(property.id)}
            disabled={isExplaining}
            data-testid="generate-explain-button"
          >
            {isExplaining ? 'Generating Explanation…' : 'Generate Grounded Gemini Explanation'}
          </button>
        </div>

        {explainError && (
          <div className="status-box status-error" role="alert">
            {explainError}
          </div>
        )}

        {explainResponse && (
          <div className="explain-card" data-testid="explain-result">
            {!explainResponse.explanationAvailable && (
              <div className="status-box status-partial" role="status">
                <strong>Gemini Narrative Unavailable — Deterministic Fallback Active:</strong>{' '}
                {explainResponse.unavailableReason ??
                  'Runtime Gemini explanation was unavailable; displaying server-verified deterministic summary.'}
              </div>
            )}

            <div className="explain-meta muted-xs">
              <span>
                Status:{' '}
                <strong>
                  {explainResponse.explanationAvailable ? 'Grounded Gemini' : 'Deterministic Fallback'}
                </strong>
              </span>
              {explainResponse.modelUsed && (
                <span>
                  Model: <code>{explainResponse.modelUsed}</code>
                </span>
              )}
              {explainResponse.isSyntheticDemo && (
                <span className="pill pill-demo">SYNTHETIC DEMO</span>
              )}
            </div>

            <p className="explain-summary">{explainResponse.summary}</p>

            <div className="explain-columns">
              <div>
                <h4>Positive Location &amp; Data Factors</h4>
                <ul>
                  {explainResponse.positiveFactors.map((factor, i) => (
                    <li key={i}>{factor}</li>
                  ))}
                </ul>
              </div>
              <div>
                <h4>Contrary &amp; Uncertainty Factors</h4>
                <ul>
                  {explainResponse.contraryAndUncertaintyFactors.map((factor, i) => (
                    <li key={i}>{factor}</li>
                  ))}
                </ul>
              </div>
            </div>

            <div className="explain-limitations">
              <h4>Methodology Limitations</h4>
              <ul>
                {explainResponse.limitations.map((lim, i) => (
                  <li key={i}>{lim}</li>
                ))}
              </ul>
            </div>

            <div className="evidence-catalog-box">
              <h4>Cited Grounded Evidence ({explainResponse.evidenceIds.length})</h4>
              <ul className="evidence-list">
                {explainResponse.evidenceIds.map((id) => {
                  const item = evidenceById.get(id);
                  return (
                    <li key={id} className="evidence-item">
                      <code>{id}</code>
                      {item ? (
                        <>
                          {' '}
                          <span className="pill pill-source">{item.sourceId}</span>{' '}
                          <strong>{item.label}:</strong> {item.detail}
                        </>
                      ) : (
                        ' (Evidence item metadata not returned)'
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="data-as-of muted-xs">
              Data as of — Listing:{' '}
              {formatIsoDateTime(explainResponse.dataAsOf.listingLastSeenAt)} · AVM:{' '}
              {formatIsoDateTime(explainResponse.dataAsOf.avmFetchedAt)} · Geospatial:{' '}
              {formatIsoDateTime(explainResponse.dataAsOf.geospatialFetchedAt ?? geospatialFetchedAt)}
            </div>
          </div>
        )}
      </div>

      {avmDisclaimers.length > 0 && (
        <ul className="muted-xs disclaimer-list">
          {avmDisclaimers.map((d, i) => (
            <li key={i}>{d}</li>
          ))}
        </ul>
      )}
    </section>
  );
};
