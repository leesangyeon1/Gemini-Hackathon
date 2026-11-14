import React from 'react';
import {
  AMENITY_CATEGORIES,
  AMENITY_CATEGORY_METADATA,
  ANALYSIS_BOUNDS,
  DEFAULT_PREFERENCE_WEIGHTS,
} from '../../shared/constants';
import type { AmenityCategory, PreferenceProfile } from '../../shared/types';
import { CATEGORY_COLORS } from '../utils/formatters';

export interface PreferenceControlsProps {
  preferences: PreferenceProfile;
  visibleCategories: Record<AmenityCategory, boolean>;
  showPlacesContext: boolean;
  placesContextAvailable: boolean;
  hasAnalyzedArea: boolean;
  isReScoring: boolean;
  onChangePreferences: (next: PreferenceProfile) => void;
  onToggleCategoryLayer: (category: AmenityCategory) => void;
  onTogglePlacesContext: (visible: boolean) => void;
  onResetDefaults: () => void;
  onApplyAndRescore: () => void;
}

export const PreferenceControls: React.FC<PreferenceControlsProps> = ({
  preferences,
  visibleCategories,
  showPlacesContext,
  placesContextAvailable,
  hasAnalyzedArea,
  isReScoring,
  onChangePreferences,
  onToggleCategoryLayer,
  onTogglePlacesContext,
  onResetDefaults,
  onApplyAndRescore,
}) => {
  const handleWeightChange = (category: AmenityCategory, weight: number) => {
    const safeWeight = Math.max(0, Math.min(ANALYSIS_BOUNDS.maxCategoryWeight, weight));
    onChangePreferences({
      ...preferences,
      weights: {
        ...preferences.weights,
        [category]: safeWeight,
      },
    });
  };

  const handleRadiusChange = (category: AmenityCategory, radius: number) => {
    const safeRadius = Math.max(
      ANALYSIS_BOUNDS.minCategoryRadiusMeters,
      Math.min(ANALYSIS_BOUNDS.maxCategoryRadiusMeters, radius)
    );
    onChangePreferences({
      ...preferences,
      radiiMeters: {
        ...preferences.radiiMeters,
        [category]: safeRadius,
      },
    });
  };

  const totalWeight = AMENITY_CATEGORIES.reduce(
    (sum, cat) => sum + (preferences.weights[cat] ?? 0),
    0
  );

  const externalityWeight = preferences.optionalExternalityPenaltyWeight ?? 0;

  return (
    <section
      className="card preferences-panel"
      aria-label="Uncalibrated Accessibility Preferences and Map Layers"
      data-testid="preference-controls"
    >
      <div className="panel-header-row">
        <div>
          <h2 className="panel-title">Accessibility Preferences &amp; Map Layers</h2>
          <p className="muted-xs">
            Authored starting weights (total: <strong>{totalWeight}</strong>). Adjust convenience
            weights &amp; straight-line radii freely — never market dollars and never multiplies AVM.
          </p>
        </div>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onResetDefaults}>
          Reset Defaults
        </button>
      </div>

      <div className="category-controls-list">
        {AMENITY_CATEGORIES.map((category) => {
          const meta = AMENITY_CATEGORY_METADATA[category];
          const color = CATEGORY_COLORS[category];
          const weight = preferences.weights[category] ?? 0;
          const radius = preferences.radiiMeters[category];
          const isLayerVisible = visibleCategories[category];

          return (
            <div
              key={category}
              className={`category-row ${category === 'fast_food' ? 'category-row-optional' : ''}`}
            >
              <div className="category-row-top">
                <label className="checkbox-label">
                  <input
                    type="checkbox"
                    checked={isLayerVisible}
                    onChange={() => onToggleCategoryLayer(category)}
                    aria-label={`Show ${meta.label} layer and radius circles on map`}
                  />
                  <span
                    className="cat-dot"
                    style={{ backgroundColor: color.fill, borderColor: color.stroke }}
                    aria-hidden="true"
                  >
                    {color.symbol}
                  </span>
                  <span className="cat-name">{meta.label}</span>
                </label>

                <button
                  type="button"
                  className="btn-link-xs"
                  onClick={() =>
                    handleWeightChange(
                      category,
                      weight > 0 ? 0 : DEFAULT_PREFERENCE_WEIGHTS[category] || 10
                    )
                  }
                >
                  {weight > 0 ? 'Mute Weight (0)' : 'Enable Weight'}
                </button>
              </div>

              <div className="category-sliders">
                <div className="slider-control">
                  <label htmlFor={`weight-${category}`} className="slider-label">
                    Weight: <strong>{weight}</strong>
                  </label>
                  <input
                    id={`weight-${category}`}
                    type="range"
                    min={0}
                    max={ANALYSIS_BOUNDS.maxCategoryWeight}
                    step={5}
                    value={weight}
                    onChange={(e) => handleWeightChange(category, Number(e.target.value))}
                  />
                </div>

                <div className="slider-control">
                  <label htmlFor={`radius-${category}`} className="slider-label">
                    Radius: <strong>{radius.toLocaleString('en-US')} m</strong>
                  </label>
                  <input
                    id={`radius-${category}`}
                    type="range"
                    min={ANALYSIS_BOUNDS.minCategoryRadiusMeters}
                    max={ANALYSIS_BOUNDS.maxCategoryRadiusMeters}
                    step={100}
                    value={radius}
                    onChange={(e) => handleRadiusChange(category, Number(e.target.value))}
                  />
                </div>
              </div>

              {'nonCausalNotice' in meta && (
                <p className="non-causal-note" data-testid="fast-food-non-causal-note">
                  {meta.nonCausalNotice}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* Separate EPA FRS Environmental Due-Diligence Layer + Optional Uncalibrated Externality Preference */}
      <div className="env-controls-box">
        <h3 className="panel-title-sm">Separate Environmental &amp; Context Layers</h3>

        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={preferences.includeEnvironmentalDueDiligenceLayer ?? true}
            onChange={(e) =>
              onChangePreferences({
                ...preferences,
                includeEnvironmentalDueDiligenceLayer: e.target.checked,
              })
            }
          />
          <span>
            Show US EPA FRS Environmental Due-Diligence Layer (Permit/Registry Only — Not an
            Automatic Health Determination)
          </span>
        </label>

        <div className="externality-slider-box">
          <label htmlFor="externality-preference-slider" className="field-label">
            Uncalibrated User Preference — Not Market Dollars (Never Multiplies AVM):{' '}
            <strong>{externalityWeight}</strong>
          </label>
          <input
            id="externality-preference-slider"
            type="range"
            min={0}
            max={50}
            step={5}
            value={externalityWeight}
            onChange={(e) =>
              onChangePreferences({
                ...preferences,
                optionalExternalityPenaltyWeight: Number(e.target.value),
              })
            }
          />
          <span className="muted-xs">
            Optional exploratory penalty (0–50) subtracted from your personal preference readout when EPA
            FRS sites are nearby. Strictly non-monetary and independent of RentCast AVM.
          </span>
        </div>

        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={showPlacesContext}
            disabled={!placesContextAvailable}
            onChange={(e) => onTogglePlacesContext(e.target.checked)}
          />
          <span>
            Show Display-Only Google Places Context{' '}
            <span className="pill pill-excluded">Excluded from Scoring</span>
            {!placesContextAvailable && ' (No records in current area)'}
          </span>
        </label>
      </div>

      <div className="preferences-footer">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!hasAnalyzedArea || isReScoring}
          onClick={onApplyAndRescore}
          data-testid="rescore-preferences-button"
        >
          {isReScoring ? 'Re-Scoring Area…' : 'Apply Preferences & Re-Score (0 AVM Cost)'}
        </button>
      </div>
    </section>
  );
};
