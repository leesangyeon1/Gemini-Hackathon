import React, { useMemo, useState } from 'react';
import { AMENITY_CATEGORY_METADATA } from '../../shared/constants';
import type {
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
import {
  CATEGORY_COLORS,
  RANGE_POSITION_META,
  formatCurrencyUsd,
  formatSignedPct,
} from '../utils/formatters';
import {
  createSvgViewportProjection,
  metersToSvgPixels,
  projectLatLngToSvg,
  shiftCenterByMeters,
} from '../utils/mapProjection';

export interface SvgGeospatialMapProps {
  analysisArea: AnalysisArea | null;
  influenceFetchRadiusMeters: number | null;
  preferences: PreferenceProfile;
  visibleCategories: Record<AmenityCategory, boolean>;
  showGridOverlap: boolean;
  showFacilityCircles: boolean;
  showPlacesContext: boolean;
  amenities: FacilityRecord[];
  gridOverlap: BoundedGridOverlapResult | null;
  environmentalRecords: EnvironmentalRecord[];
  displayOnlyPlacesContext: DisplayOnlyPlaceRecord[];
  listings: PropertyListingSummary[];
  selectedPropertyId: string | null;
  onSelectProperty: (propertyId: string) => void;
  onAnalyzeViewportCenter: (center: CoordinatePoint, radiusMeters: number) => void;
}

export const SvgGeospatialMap: React.FC<SvgGeospatialMapProps> = ({
  analysisArea,
  influenceFetchRadiusMeters,
  preferences,
  visibleCategories,
  showGridOverlap,
  showFacilityCircles,
  showPlacesContext,
  amenities,
  gridOverlap,
  environmentalRecords,
  displayOnlyPlacesContext,
  listings,
  selectedPropertyId,
  onSelectProperty,
  onAnalyzeViewportCenter,
}) => {
  const baseLat = analysisArea?.centerLat ?? 39.8283;
  const baseLng = analysisArea?.centerLng ?? -98.5795;
  const baseRadius = analysisArea?.radiusMeters ?? 1600;

  const [panOffset, setPanOffset] = useState<{
    baseAreaId: string | null;
    center: CoordinatePoint;
  } | null>(null);
  const [zoomFactor, setZoomFactor] = useState(1);

  const activeCenter: CoordinatePoint =
    panOffset && panOffset.baseAreaId === (analysisArea?.areaId ?? null)
      ? panOffset.center
      : { lat: baseLat, lng: baseLng };

  const hasPanned =
    Boolean(analysisArea) &&
    (Math.abs(activeCenter.lat - baseLat) > 0.0002 ||
      Math.abs(activeCenter.lng - baseLng) > 0.0002);

  const spanRadius = Math.max(400, (influenceFetchRadiusMeters ?? baseRadius * 1.4) / zoomFactor);

  const projection = useMemo(
    () => createSvgViewportProjection(activeCenter.lat, activeCenter.lng, spanRadius, 680, 460),
    [activeCenter.lat, activeCenter.lng, spanRadius]
  );

  const handlePan = (northMeters: number, eastMeters: number) => {
    const next = shiftCenterByMeters(activeCenter.lat, activeCenter.lng, northMeters, eastMeters);
    setPanOffset({
      baseAreaId: analysisArea?.areaId ?? null,
      center: next,
    });
  };

  const resetPan = () => {
    setPanOffset(null);
    setZoomFactor(1);
  };

  const areaCenterSvg = analysisArea
    ? projectLatLngToSvg({ lat: analysisArea.centerLat, lng: analysisArea.centerLng }, projection)
    : null;

  const filteredAmenities = amenities.filter((f) => {
    const cat = f.category as AmenityCategory;
    return cat in visibleCategories ? visibleCategories[cat] : true;
  });

  const cellPixelRadius = gridOverlap
    ? Math.max(
        6,
        metersToSvgPixels(
          (gridOverlap.radiusMeters / Math.max(4, gridOverlap.gridResolution)) * 0.9,
          projection
        )
      )
    : 10;

  return (
    <div className="svg-map-shell" data-testid="svg-geospatial-map">
      <div className="map-toolbar">
        <div className="map-pan-controls" role="group" aria-label="Map pan and zoom controls">
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => handlePan(baseRadius * 0.35, 0)}
            aria-label="Pan map north"
          >
            ↑ N
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => handlePan(-baseRadius * 0.35, 0)}
            aria-label="Pan map south"
          >
            ↓ S
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => handlePan(0, -baseRadius * 0.35)}
            aria-label="Pan map west"
          >
            ← W
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => handlePan(0, baseRadius * 0.35)}
            aria-label="Pan map east"
          >
            → E
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => setZoomFactor((z) => Math.min(2.5, Number((z + 0.25).toFixed(2))))}
            aria-label="Zoom in"
          >
            + Zoom
          </button>
          <button
            type="button"
            className="btn btn-ghost btn-xs"
            onClick={() => setZoomFactor((z) => Math.max(0.5, Number((z - 0.25).toFixed(2))))}
            aria-label="Zoom out"
          >
            − Zoom
          </button>
          {(hasPanned || zoomFactor !== 1) && (
            <button type="button" className="btn btn-ghost btn-xs" onClick={resetPan}>
              Recenter
            </button>
          )}
        </div>

        {hasPanned && (
          <button
            type="button"
            className="btn btn-primary btn-xs"
            onClick={() => onAnalyzeViewportCenter(activeCenter, baseRadius)}
            data-testid="analyze-current-viewport-btn"
          >
            Analyze Current Viewport
          </button>
        )}
      </div>

      <div className="svg-canvas-frame">
        <svg
          viewBox={`0 0 ${projection.width} ${projection.height}`}
          className="geospatial-svg"
          role="img"
          aria-label={
            analysisArea
              ? `Interactive geospatial map for ${analysisArea.label} showing analysis boundary, facility circles, grid overlap cells, and ${listings.length} property listings`
              : 'Interactive US geospatial viewport awaiting location selection'
          }
        >
          <rect
            x={0}
            y={0}
            width={projection.width}
            height={projection.height}
            fill="#f8fafc"
            stroke="#cbd5e1"
          />

          {/* Subtle coordinate grid */}
          {[0.25, 0.5, 0.75].map((frac) => (
            <g key={frac} stroke="#e2e8f0" strokeWidth={1}>
              <line
                x1={projection.width * frac}
                y1={0}
                x2={projection.width * frac}
                y2={projection.height}
              />
              <line
                x1={0}
                y1={projection.height * frac}
                x2={projection.width}
                y2={projection.height * frac}
              />
            </g>
          ))}

          {/* Influence-buffer outer ring */}
          {analysisArea && areaCenterSvg && influenceFetchRadiusMeters && (
            <circle
              cx={areaCenterSvg.x}
              cy={areaCenterSvg.y}
              r={metersToSvgPixels(influenceFetchRadiusMeters, projection)}
              fill="rgba(148, 163, 184, 0.08)"
              stroke="#64748b"
              strokeWidth={1.5}
              strokeDasharray="6 4"
            >
              <title>{`Influence fetch buffer (${influenceFetchRadiusMeters} m)`}</title>
            </circle>
          )}

          {/* Selected Analysis Area Boundary Circle */}
          {analysisArea && areaCenterSvg && (
            <circle
              cx={areaCenterSvg.x}
              cy={areaCenterSvg.y}
              r={metersToSvgPixels(analysisArea.radiusMeters, projection)}
              fill="rgba(37, 99, 235, 0.05)"
              stroke="#1d4ed8"
              strokeWidth={2}
            >
              <title>{`Selected analysis boundary (${analysisArea.radiusMeters} m circular approximation)`}</title>
            </circle>
          )}

          {/* Bounded Grid / Kernel Venn-Like Overlap Cells */}
          {showGridOverlap &&
            gridOverlap &&
            gridOverlap.cells.map((cell) => {
              const pos = projectLatLngToSvg({ lat: cell.lat, lng: cell.lng }, projection);
              const isSweetSpot = gridOverlap.sweetSpotCells.some((s) => s.cellId === cell.cellId);
              const intensityRatio = Math.min(1, Math.max(0.08, cell.accessibilityScore / 100));
              const fillColor = isSweetSpot
                ? `rgba(15, 118, 110, ${(0.28 + intensityRatio * 0.35).toFixed(2)})`
                : cell.overlapCount >= 2
                  ? `rgba(2, 132, 199, ${(0.14 + intensityRatio * 0.25).toFixed(2)})`
                  : `rgba(148, 163, 184, ${(0.08 + intensityRatio * 0.14).toFixed(2)})`;

              return (
                <rect
                  key={cell.cellId}
                  x={pos.x - cellPixelRadius}
                  y={pos.y - cellPixelRadius}
                  width={cellPixelRadius * 2}
                  height={cellPixelRadius * 2}
                  rx={3}
                  fill={fillColor}
                  stroke={isSweetSpot ? '#0f766e' : 'rgba(100,116,139,0.22)'}
                  strokeWidth={isSweetSpot ? 1.5 : 0.75}
                >
                  <title>
                    {`Grid cell (${cell.row},${cell.col}): Score ${cell.accessibilityScore.toFixed(1)}/100 · ${cell.overlapCount}/${gridOverlap.activeCategories.length} overlapping categories (${cell.presentCategories.join(', ') || 'none'})`}
                  </title>
                </rect>
              );
            })}

          {/* Transparent Facility-Radius Circles per Toggled Amenity Category */}
          {showFacilityCircles &&
            filteredAmenities.slice(0, 80).map((facility) => {
              const cat = facility.category as AmenityCategory;
              const radiusM = preferences.radiiMeters[cat] ?? 1200;
              const color = CATEGORY_COLORS[cat] ?? { fill: '#475569', stroke: '#334155', symbol: '•' };
              const pos = projectLatLngToSvg({ lat: facility.lat, lng: facility.lng }, projection);
              return (
                <circle
                  key={`circle-${facility.id}`}
                  cx={pos.x}
                  cy={pos.y}
                  r={metersToSvgPixels(radiusM, projection)}
                  fill={color.fill}
                  fillOpacity={0.055}
                  stroke={color.stroke}
                  strokeOpacity={0.28}
                  strokeWidth={1}
                  pointerEvents="none"
                />
              );
            })}

          {/* Amenity Markers */}
          {filteredAmenities.map((facility) => {
            const cat = facility.category as AmenityCategory;
            const color = CATEGORY_COLORS[cat] ?? { fill: '#475569', stroke: '#334155', symbol: '•' };
            const pos = projectLatLngToSvg({ lat: facility.lat, lng: facility.lng }, projection);
            const catLabel =
              cat in AMENITY_CATEGORY_METADATA
                ? AMENITY_CATEGORY_METADATA[cat].shortLabel
                : facility.category;
            return (
              <g key={facility.id} transform={`translate(${pos.x}, ${pos.y})`}>
                <circle r={4.5} fill={color.fill} stroke="#ffffff" strokeWidth={1.2} />
                <title>{`${facility.name || catLabel} (${catLabel}) · ${facility.attribution}`}</title>
              </g>
            );
          })}

          {/* Separate US EPA FRS Environmental Due-Diligence Layer */}
          {(preferences.includeEnvironmentalDueDiligenceLayer ?? true) &&
            environmentalRecords.map((rec) => {
              const pos = projectLatLngToSvg({ lat: rec.lat, lng: rec.lng }, projection);
              return (
                <g key={rec.id} transform={`translate(${pos.x}, ${pos.y})`}>
                  <polygon
                    points="0,-7 6,-3 6,3 0,7 -6,3 -6,-3"
                    fill="#d97706"
                    stroke="#78350f"
                    strokeWidth={1.4}
                  />
                  <title>
                    {`EPA FRS Record: ${rec.name} (${rec.registryId}) · Programs: ${rec.programs.join(', ') || 'Registered'} · Permit record only — not an automatic health determination`}
                  </title>
                </g>
              );
            })}

          {/* Display-Only Google Places Context (Strictly Excluded from Scoring) */}
          {showPlacesContext &&
            displayOnlyPlacesContext.map((place) => {
              const pos = projectLatLngToSvg({ lat: place.lat, lng: place.lng }, projection);
              return (
                <g key={place.placeId} transform={`translate(${pos.x}, ${pos.y})`}>
                  <polygon
                    points="0,-6 6,0 0,6 -6,0"
                    fill="#94a3b8"
                    stroke="#334155"
                    strokeWidth={1.2}
                  />
                  <title>
                    {`[Excluded from Scoring] ${place.name} (Google Places display-only context)`}
                  </title>
                </g>
              );
            })}

          {/* Interactive Property Markers */}
          {listings.map((listing, idx) => {
            const pos = projectLatLngToSvg(
              { lat: listing.latitude, lng: listing.longitude },
              projection
            );
            const isSelected = listing.id === selectedPropertyId;
            const meta = RANGE_POSITION_META[listing.priceGap.rangePosition];
            const fillByPos: Record<string, string> = {
              below_estimate_range_candidate: '#0f766e',
              in_range: '#1d4ed8',
              above_estimate_range_candidate: '#b45309',
              range_unknown: '#6d28d9',
              no_avm: '#334155',
            };
            const fill = fillByPos[listing.priceGap.rangePosition] ?? '#334155';

            return (
              <g
                key={listing.id}
                transform={`translate(${pos.x}, ${pos.y})`}
                className="svg-property-marker"
                role="button"
                tabIndex={0}
                aria-label={`Select listing ${idx + 1}: ${listing.formattedAddress}, Asking ${formatCurrencyUsd(listing.askingPrice)}, ${meta.label}`}
                aria-pressed={isSelected}
                onClick={() => onSelectProperty(listing.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelectProperty(listing.id);
                  }
                }}
              >
                <circle
                  r={isSelected ? 11 : 8.5}
                  fill={fill}
                  stroke={isSelected ? '#fbbf24' : '#ffffff'}
                  strokeWidth={isSelected ? 3 : 2}
                />
                <text
                  x={0}
                  y={3.5}
                  textAnchor="middle"
                  fontSize="9"
                  fontWeight="700"
                  fill="#ffffff"
                >
                  {idx + 1}
                </text>
                <title>
                  {`${listing.formattedAddress} · Ask: ${formatCurrencyUsd(listing.askingPrice)} · ${meta.label}${listing.priceGap.gapPct !== null ? ` (${formatSignedPct(listing.priceGap.gapPct)})` : ''}`}
                </title>
              </g>
            );
          })}
        </svg>

        {!analysisArea && (
          <div className="map-empty-overlay">
            <p>
              Search and confirm any US city, neighborhood, ZIP, or coordinates above, then click{' '}
              <strong>Analyze Area</strong> to inspect amenities, overlap zones, and active listings.
            </p>
          </div>
        )}
      </div>

      <p className="muted-xs map-projection-note">
        WGS84 equirectangular interactive vector map (center:{' '}
        <code>
          {activeCenter.lat.toFixed(4)}, {activeCenter.lng.toFixed(4)}
        </code>
        ). Fully functional with keyboard navigation and zero external map keys required.
      </p>
    </div>
  );
};
