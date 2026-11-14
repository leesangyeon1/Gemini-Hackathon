import React, { useState } from 'react';
import type {
  AccessibilityResult,
  AmenityCategory,
  AnalysisArea,
  BoundedGridOverlapResult,
  CoordinatePoint,
  DisplayOnlyPlaceRecord,
  EnvironmentalRecord,
  FacilityRecord,
  PreferenceProfile,
  PropertyListingSummary,
} from '../../shared/types';
import { computeUpperBoundScoreIfUnknownMaxed } from '../utils/formatters';
import { GoogleMapsViewport } from './GoogleMapsViewport';
import { SvgGeospatialMap } from './SvgGeospatialMap';

export interface MapViewportProps {
  mapsBrowserKey: string | null;
  analysisArea: AnalysisArea | null;
  influenceFetchRadiusMeters: number | null;
  centerAccessibility: AccessibilityResult | null;
  preferences: PreferenceProfile;
  visibleCategories: Record<AmenityCategory, boolean>;
  showPlacesContext: boolean;
  amenities: FacilityRecord[];
  gridOverlap: BoundedGridOverlapResult | null;
  environmentalLayerStatus: 'ok' | 'unknown' | null;
  environmentalRecords: EnvironmentalRecord[];
  displayOnlyPlacesContext: DisplayOnlyPlaceRecord[];
  listings: PropertyListingSummary[];
  selectedPropertyId: string | null;
  onSelectProperty: (propertyId: string) => void;
  onAnalyzeViewportCenter: (center: CoordinatePoint, radiusMeters: number) => void;
}

export const MapViewport: React.FC<MapViewportProps> = ({
  mapsBrowserKey,
  analysisArea,
  influenceFetchRadiusMeters,
  centerAccessibility,
  preferences,
  visibleCategories,
  showPlacesContext,
  amenities,
  gridOverlap,
  environmentalLayerStatus,
  environmentalRecords,
  displayOnlyPlacesContext,
  listings,
  selectedPropertyId,
  onSelectProperty,
  onAnalyzeViewportCenter,
}) => {
  const [showGridOverlap, setShowGridOverlap] = useState(true);
  const [showFacilityCircles, setShowFacilityCircles] = useState(true);
  const [forceSvgFallback, setForceSvgFallback] = useState(false);
  const [mapsError, setMapsError] = useState<string | null>(null);

  const useGoogleMaps = Boolean(mapsBrowserKey) && !forceSvgFallback && !mapsError;

  const upperBound = centerAccessibility
    ? computeUpperBoundScoreIfUnknownMaxed(centerAccessibility)
    : null;

  return (
    <section className="card map-panel" aria-label="Interactive Geospatial Map">
      <div className="panel-header-row">
        <div>
          <h2 className="panel-title">
            Spatial Accessibility, Facility Circles &amp; Venn Overlap Map
          </h2>
          {centerAccessibility && (
            <div className="area-score-strip" data-testid="center-accessibility-summary">
              <span>
                Area Center Score: <strong>{centerAccessibility.score.toFixed(1)} / 100</strong>
              </span>
              <span className={`pill pill-${centerAccessibility.completeness}`}>
                Completeness: {centerAccessibility.completeness}
              </span>
              {centerAccessibility.missingOrFailedCategories.length > 0 && (
                <span className="muted-xs status-warn">
                  Unknown categories: {centerAccessibility.missingOrFailedCategories.join(', ')}
                  {upperBound !== null ? ` (upper bound if maxed: ${upperBound.toFixed(1)})` : ''}
                </span>
              )}
              {gridOverlap && (
                <span className="muted-xs">
                  Sweet-spot cells: {gridOverlap.sweetSpotCells.length} / {gridOverlap.cells.length}{' '}
                  (max overlap: {gridOverlap.maxOverlapCount}/{gridOverlap.activeCategories.length})
                </span>
              )}
            </div>
          )}
        </div>

        <div className="map-layer-toggles">
          <label className="checkbox-inline">
            <input
              type="checkbox"
              checked={showFacilityCircles}
              onChange={(e) => setShowFacilityCircles(e.target.checked)}
            />
            <span>Facility Radii</span>
          </label>
          <label className="checkbox-inline">
            <input
              type="checkbox"
              checked={showGridOverlap}
              onChange={(e) => setShowGridOverlap(e.target.checked)}
            />
            <span>Grid Overlap</span>
          </label>
          {mapsBrowserKey && !mapsError && (
            <button
              type="button"
              className="btn btn-ghost btn-xs"
              onClick={() => setForceSvgFallback((prev) => !prev)}
            >
              {forceSvgFallback ? 'Use Google Maps Basemap' : 'Switch to Vector Map'}
            </button>
          )}
        </div>
      </div>

      {mapsError && (
        <div className="banner banner-info" role="status">
          <span>
            Google Maps JS basemap fallback active ({mapsError}). Showing interactive WGS84 vector map.
          </span>
        </div>
      )}

      {environmentalLayerStatus === 'unknown' && (
        <div className="status-box status-partial" role="status">
          <strong>EPA FRS Layer Partial/Unavailable:</strong> US EPA Facility Registry Service did not
          respond for this request. Facility accessibility math remains unaffected.
        </div>
      )}

      {useGoogleMaps && mapsBrowserKey ? (
        <GoogleMapsViewport
          mapsBrowserKey={mapsBrowserKey}
          analysisArea={analysisArea}
          influenceFetchRadiusMeters={influenceFetchRadiusMeters}
          preferences={preferences}
          visibleCategories={visibleCategories}
          showGridOverlap={showGridOverlap}
          showFacilityCircles={showFacilityCircles}
          showPlacesContext={showPlacesContext}
          amenities={amenities}
          gridOverlap={gridOverlap}
          environmentalRecords={environmentalRecords}
          displayOnlyPlacesContext={displayOnlyPlacesContext}
          listings={listings}
          selectedPropertyId={selectedPropertyId}
          onSelectProperty={onSelectProperty}
          onAnalyzeViewportCenter={onAnalyzeViewportCenter}
          onMapsLoadFailure={(reason) => setMapsError(reason)}
        />
      ) : (
        <SvgGeospatialMap
          analysisArea={analysisArea}
          influenceFetchRadiusMeters={influenceFetchRadiusMeters}
          preferences={preferences}
          visibleCategories={visibleCategories}
          showGridOverlap={showGridOverlap}
          showFacilityCircles={showFacilityCircles}
          showPlacesContext={showPlacesContext}
          amenities={amenities}
          gridOverlap={gridOverlap}
          environmentalRecords={environmentalRecords}
          displayOnlyPlacesContext={displayOnlyPlacesContext}
          listings={listings}
          selectedPropertyId={selectedPropertyId}
          onSelectProperty={onSelectProperty}
          onAnalyzeViewportCenter={onAnalyzeViewportCenter}
        />
      )}
    </section>
  );
};
