import React, { useMemo, useState } from 'react';
import type { PropertyListingSummary, UiState } from '../../shared/types';
import {
  RANGE_POSITION_META,
  computeUncalibratedExternalityAdjustedIndex,
  formatCurrencyUsd,
  formatIsoDate,
  formatSignedPct,
} from '../utils/formatters';

export interface PropertyListPanelProps {
  listings: PropertyListingSummary[];
  selectedPropertyId: string | null;
  uiState: UiState;
  errorMessage: string | null;
  retryable: boolean;
  isSyntheticDemo: boolean;
  externalityPenaltyWeight: number;
  onSelectProperty: (propertyId: string) => void;
  onRetrySearch: () => void;
}

type SortKey = 'default' | 'asking_asc' | 'asking_desc' | 'accessibility_desc' | 'gap_desc';

export const PropertyListPanel: React.FC<PropertyListPanelProps> = ({
  listings,
  selectedPropertyId,
  uiState,
  errorMessage,
  retryable,
  isSyntheticDemo,
  externalityPenaltyWeight,
  onSelectProperty,
  onRetrySearch,
}) => {
  const [sortBy, setSortBy] = useState<SortKey>('default');

  const sortedListings = useMemo(() => {
    const copy = [...listings];
    switch (sortBy) {
      case 'asking_asc':
        return copy.sort((a, b) => (a.askingPrice ?? Infinity) - (b.askingPrice ?? Infinity));
      case 'asking_desc':
        return copy.sort((a, b) => (b.askingPrice ?? -1) - (a.askingPrice ?? -1));
      case 'accessibility_desc':
        return copy.sort(
          (a, b) => (b.accessibility?.score ?? -1) - (a.accessibility?.score ?? -1)
        );
      case 'gap_desc':
        return copy.sort((a, b) => (b.priceGap.gapPct ?? -999) - (a.priceGap.gapPct ?? -999));
      default:
        return copy;
    }
  }, [listings, sortBy]);

  return (
    <section
      className="card listings-panel"
      aria-label="Active Residential Listings"
      data-testid="property-list-panel"
    >
      <div className="panel-header-row">
        <div>
          <h2 className="panel-title">
            Active Listings ({listings.length}/25)
            {isSyntheticDemo && <span className="pill pill-demo">SYNTHETIC DEMO</span>}
          </h2>
          <p className="muted-xs">
            Select any home to inspect details and optionally request its 1-call RentCast AVM.
          </p>
        </div>

        {listings.length > 1 && (
          <div className="sort-control">
            <label htmlFor="listings-sort-select" className="muted-xs">
              Sort:
            </label>
            <select
              id="listings-sort-select"
              className="select-input"
              value={sortBy}
              onChange={(e) => setSortBy(e.target.value as SortKey)}
            >
              <option value="default">Default Order</option>
              <option value="accessibility_desc">Accessibility Score (High → Low)</option>
              <option value="asking_asc">Asking Price (Low → High)</option>
              <option value="asking_desc">Asking Price (High → Low)</option>
              <option value="gap_desc">Midpoint Gap % (High → Low)</option>
            </select>
          </div>
        )}
      </div>

      {uiState === 'loading' && (
        <div className="status-box status-loading" aria-busy="true" role="status">
          Fetching active listings and geospatial accessibility layers…
        </div>
      )}

      {errorMessage && (
        <div className="status-box status-error" role="alert">
          <div>
            <strong>Listings Notice ({uiState}):</strong> {errorMessage}
          </div>
          {retryable && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onRetrySearch}>
              Retry Search
            </button>
          )}
        </div>
      )}

      {uiState !== 'loading' && !errorMessage && listings.length === 0 && (
        <div className="status-box status-empty" role="status" data-testid="empty-listings-state">
          {uiState === 'empty'
            ? '0 active residential listings found in this analysis radius. Try widening the radius (up to 5,000 m) or choosing a nearby US area.'
            : 'No listings loaded yet. Confirm a US area and click Analyze Area.'}
        </div>
      )}

      <ul className="listing-cards" aria-label="Property listings">
        {sortedListings.map((listing, idx) => {
          const isSelected = listing.id === selectedPropertyId;
          const gapMeta = RANGE_POSITION_META[listing.priceGap.rangePosition];
          const baseScore = listing.accessibility?.score ?? null;
          const adjustedPrefIndex =
            baseScore !== null && externalityPenaltyWeight > 0
              ? computeUncalibratedExternalityAdjustedIndex(
                  baseScore,
                  listing.nearbyEnvironmentalCount,
                  externalityPenaltyWeight
                )
              : null;

          return (
            <li key={listing.id}>
              <button
                type="button"
                className={`listing-card ${isSelected ? 'listing-card-selected' : ''}`}
                onClick={() => onSelectProperty(listing.id)}
                aria-pressed={isSelected}
                data-testid={`property-card-${listing.id}`}
              >
                <div className="listing-card-top">
                  <span className="listing-index">#{idx + 1}</span>
                  <span className="listing-address">{listing.formattedAddress}</span>
                  <span className={`range-badge ${gapMeta.badgeClass}`}>
                    {gapMeta.symbol} {gapMeta.shortLabel}
                  </span>
                </div>

                <div className="listing-card-metrics">
                  <div>
                    <span className="metric-label-inline">Asking:</span>{' '}
                    <strong>{formatCurrencyUsd(listing.askingPrice)}</strong>
                  </div>
                  {listing.avmPrice !== null && (
                    <div>
                      <span className="metric-label-inline">AVM:</span>{' '}
                      <strong>{formatCurrencyUsd(listing.avmPrice)}</strong>{' '}
                      <span className="muted-xs">({formatSignedPct(listing.priceGap.gapPct)})</span>
                    </div>
                  )}
                  <div>
                    <span className="metric-label-inline">Accessibility:</span>{' '}
                    <strong>
                      {baseScore !== null ? `${baseScore.toFixed(1)}/100` : 'Pending'}
                    </strong>
                    {adjustedPrefIndex !== null && (
                      <span className="muted-xs">
                        {' '}
                        · Pref w/ ext: {adjustedPrefIndex.toFixed(1)}
                      </span>
                    )}
                  </div>
                </div>

                <div className="listing-card-meta muted-xs">
                  <span>{listing.propertyType}</span>
                  {listing.bedrooms !== null && <span>{listing.bedrooms} bd</span>}
                  {listing.bathrooms !== null && <span>{listing.bathrooms} ba</span>}
                  {listing.squareFootage !== null && (
                    <span>{listing.squareFootage.toLocaleString('en-US')} sq ft</span>
                  )}
                  <span>Seen: {formatIsoDate(listing.listingLastSeenAt)}</span>
                  <span>EPA nearby: {listing.nearbyEnvironmentalCount}</span>
                </div>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
};
