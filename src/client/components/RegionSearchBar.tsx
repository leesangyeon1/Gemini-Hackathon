import React, { useState } from 'react';
import {
  ANALYSIS_BOUNDS,
  EXAMPLE_US_LOCATIONS,
  VIEWPORT_APPROXIMATION_DISCLAIMER,
} from '../../shared/constants';
import type {
  AnalysisArea,
  RegionCandidate,
  RegionResolveRequest,
  RegionResolveStatus,
} from '../../shared/types';

export interface RegionSearchBarProps {
  query: string;
  radiusMeters: number;
  resolveStatus: RegionResolveStatus | null;
  resolveMessage: string | null;
  candidates: RegionCandidate[];
  confirmedArea: AnalysisArea | null;
  isResolving: boolean;
  isAnalyzing: boolean;
  useSyntheticDemo: boolean;
  onQueryChange: (value: string) => void;
  onRadiusChange: (radiusMeters: number) => void;
  onResolve: (request: Omit<RegionResolveRequest, 'clientRequestSeq' | 'useSyntheticDemo'>) => void;
  onSelectCandidate: (candidate: RegionCandidate) => void;
  onAnalyzeArea: () => void;
}

export const RegionSearchBar: React.FC<RegionSearchBarProps> = ({
  query,
  radiusMeters,
  resolveStatus,
  resolveMessage,
  candidates,
  confirmedArea,
  isResolving,
  isAnalyzing,
  useSyntheticDemo,
  onQueryChange,
  onRadiusChange,
  onResolve,
  onSelectCandidate,
  onAnalyzeArea,
}) => {
  const [showCustomBounds, setShowCustomBounds] = useState(false);
  const [customLat, setCustomLat] = useState('30.2672');
  const [customLng, setCustomLng] = useState('-97.7431');
  const [boundsError, setBoundsError] = useState<string | null>(null);

  const handleSearchSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!query.trim()) {
      return;
    }
    setBoundsError(null);
    onResolve({
      query: query.trim(),
      preferredRadiusMeters: radiusMeters,
    });
  };

  const handleBoundsSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const lat = Number(customLat);
    const lng = Number(customLng);
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      setBoundsError('Latitude must be a finite number between -90 and 90.');
      return;
    }
    if (!Number.isFinite(lng) || lng < -180 || lng > 180) {
      setBoundsError('Longitude must be a finite number between -180 and 180.');
      return;
    }
    setBoundsError(null);
    onResolve({
      bounds: {
        centerLat: lat,
        centerLng: lng,
        radiusMeters,
      },
    });
  };

  return (
    <section className="card region-panel" aria-label="US Location Search and Confirmation">
      <div className="region-header">
        <div>
          <h2 className="panel-title">1. Select Any US Location</h2>
          <p className="muted-sm">
            Enter a US city/state, neighborhood, 5-digit ZIP code, or custom coordinates. Upstream listing
            fetches execute only after you explicitly click <strong>Analyze Area</strong>.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setShowCustomBounds((prev) => !prev)}
          aria-expanded={showCustomBounds}
        >
          {showCustomBounds ? 'Hide Custom Lat/Lng' : 'Custom Lat/Lng Bounds'}
        </button>
      </div>

      <form className="region-form" onSubmit={handleSearchSubmit}>
        <div className="input-group grow">
          <label htmlFor="region-query-input" className="field-label">
            US City, Neighborhood, or ZIP
          </label>
          <input
            id="region-query-input"
            type="text"
            className="text-input"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Austin, TX · 60614 · Ballard, Seattle, WA"
            aria-describedby="region-query-help"
          />
          <span id="region-query-help" className="muted-xs">
            Any US region supported. Non-US queries are rejected before calling property APIs.
          </span>
        </div>

        <div className="input-group radius-input-group">
          <label htmlFor="area-radius-slider" className="field-label">
            Analysis Radius: <strong>{radiusMeters.toLocaleString('en-US')} m</strong>
          </label>
          <input
            id="area-radius-slider"
            type="range"
            min={ANALYSIS_BOUNDS.minAreaRadiusMeters}
            max={ANALYSIS_BOUNDS.maxAreaRadiusMeters}
            step={100}
            value={radiusMeters}
            onChange={(e) => onRadiusChange(Number(e.target.value))}
          />
          <span className="muted-xs">
            {ANALYSIS_BOUNDS.minAreaRadiusMeters}m – {ANALYSIS_BOUNDS.maxAreaRadiusMeters}m
          </span>
        </div>

        <div className="form-submit-wrap">
          <button
            type="submit"
            className="btn btn-secondary"
            disabled={!query.trim()}
          >
            Resolve Location
          </button>
          {isResolving && (
            <span className="muted-xs" aria-live="polite">
              Resolving…
            </span>
          )}
        </div>
      </form>

      <div className="quick-chips" aria-label="Example US cities">
        <span className="muted-xs">Examples:</span>
        {EXAMPLE_US_LOCATIONS.map((example) => (
          <button
            key={example}
            type="button"
            className="chip-btn"
            onClick={() => {
              onQueryChange(example);
              onResolve({
                query: example,
                preferredRadiusMeters: radiusMeters,
              });
            }}
          >
            {example}
          </button>
        ))}
      </div>

      {showCustomBounds && (
        <form className="bounds-form" onSubmit={handleBoundsSubmit}>
          <div className="input-group">
            <label htmlFor="custom-lat-input" className="field-label">
              Center Latitude
            </label>
            <input
              id="custom-lat-input"
              type="number"
              step="0.0001"
              className="text-input"
              value={customLat}
              onChange={(e) => setCustomLat(e.target.value)}
            />
          </div>
          <div className="input-group">
            <label htmlFor="custom-lng-input" className="field-label">
              Center Longitude
            </label>
            <input
              id="custom-lng-input"
              type="number"
              step="0.0001"
              className="text-input"
              value={customLng}
              onChange={(e) => setCustomLng(e.target.value)}
            />
          </div>
          <div className="form-submit-wrap">
            <button type="submit" className="btn btn-secondary btn-sm" disabled={isResolving}>
              Resolve Custom Bounds
            </button>
          </div>
          {boundsError && (
            <p className="error-text" role="alert">
              {boundsError}
            </p>
          )}
        </form>
      )}

      {/* Unsupported Area State */}
      {resolveStatus === 'unsupported_area' && (
        <div className="status-box status-unsupported" role="alert" data-testid="unsupported-area-alert">
          <strong>Unsupported Area (US-Only Coverage):</strong>{' '}
          {resolveMessage ??
            'Foreal-Estate covers United States residential listings and US EPA FRS records only. Please choose a US city, neighborhood, ZIP, or US coordinates.'}
        </div>
      )}

      {/* Ambiguous Candidates Picker */}
      {resolveStatus === 'ambiguous' && candidates.length > 0 && (
        <div
          className="status-box status-ambiguous"
          role="region"
          aria-label="Disambiguate US Location"
          data-testid="ambiguous-candidates"
        >
          <p className="ambiguous-heading">
            <strong>Confirm Intended US Location:</strong>{' '}
            {resolveMessage ?? 'Multiple US places matched your search. Select one candidate:'}
          </p>
          <ul className="candidate-list">
            {candidates.map((candidate) => (
              <li key={candidate.candidateId}>
                <button
                  type="button"
                  className="candidate-btn"
                  onClick={() => onSelectCandidate(candidate)}
                >
                  <span className="candidate-name">{candidate.displayName}</span>
                  <span className="candidate-meta">
                    {candidate.placeKind.toUpperCase()} · ({candidate.centerLat.toFixed(4)},{' '}
                    {candidate.centerLng.toFixed(4)}) · {candidate.source}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Confirmed / Pending Area Summary + Explicit Analyze Area Action */}
      {confirmedArea && (
        <div className="confirmed-area-box" data-testid="confirmed-area-box">
          <div className="confirmed-area-info">
            <div className="confirmed-area-title">
              <strong>Selected Analysis Area:</strong> {confirmedArea.label}
              {useSyntheticDemo && <span className="pill pill-demo">DEMO FIXTURE</span>}
            </div>
            <div className="area-coords-grid">
              <span>
                Center: <code>{confirmedArea.centerLat.toFixed(5)}, {confirmedArea.centerLng.toFixed(5)}</code>
              </span>
              <span>
                Radius: <code>{confirmedArea.radiusMeters.toLocaleString('en-US')} m</code>
              </span>
              <span>
                Bounding Box:{' '}
                <code>
                  [{confirmedArea.boundingBox.minLat.toFixed(4)},{' '}
                  {confirmedArea.boundingBox.maxLat.toFixed(4)}] × [
                  {confirmedArea.boundingBox.minLng.toFixed(4)},{' '}
                  {confirmedArea.boundingBox.maxLng.toFixed(4)}]
                </code>
              </span>
            </div>
            <p className="muted-xs disclaimer-inline">
              {confirmedArea.approximationDisclaimer || VIEWPORT_APPROXIMATION_DISCLAIMER}
            </p>
          </div>

          <div className="confirmed-area-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={onAnalyzeArea}
              disabled={isAnalyzing}
              data-testid="analyze-area-button"
            >
              {isAnalyzing ? 'Analyzing Area…' : 'Analyze Area'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
};
