import React, { useEffect, useRef, useState } from 'react';
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
import { CATEGORY_COLORS, RANGE_POSITION_META, formatCurrencyUsd } from '../utils/formatters';

interface GoogleMapsMinimal {
  Map: new (
    el: HTMLElement,
    opts: {
      center: { lat: number; lng: number };
      zoom: number;
      mapTypeControl?: boolean;
      streetViewControl?: boolean;
    }
  ) => GoogleMapInstance;
  Circle: new (opts: Record<string, unknown>) => GoogleOverlayInstance;
  Rectangle: new (opts: Record<string, unknown>) => GoogleOverlayInstance;
  Marker: new (opts: Record<string, unknown>) => GoogleMarkerInstance;
  SymbolPath?: {
    CIRCLE: unknown;
  };
}

interface GoogleMapInstance {
  setCenter: (pos: { lat: number; lng: number }) => void;
  setZoom: (zoom: number) => void;
  getCenter: () => { lat: () => number; lng: () => number } | null;
  addListener: (event: string, cb: () => void) => { remove: () => void };
}

interface GoogleOverlayInstance {
  setMap: (map: GoogleMapInstance | null) => void;
}

interface GoogleMarkerInstance extends GoogleOverlayInstance {
  addListener: (event: string, cb: () => void) => { remove: () => void };
}

declare global {
  interface Window {
    google?: {
      maps?: GoogleMapsMinimal;
    };
  }
}

let mapsScriptPromise: Promise<GoogleMapsMinimal> | null = null;

function loadGoogleMapsApi(apiKey: string): Promise<GoogleMapsMinimal> {
  if (typeof window !== 'undefined' && window.google?.maps) {
    return Promise.resolve(window.google.maps);
  }
  if (mapsScriptPromise) {
    return mapsScriptPromise;
  }

  mapsScriptPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-foreal-google-maps="1"]');
    if (existing) {
      existing.addEventListener('load', () => {
        if (window.google?.maps) {
          resolve(window.google.maps);
        } else {
          reject(new Error('Google Maps JS API loaded without window.google.maps.'));
        }
      });
      existing.addEventListener('error', () => {
        reject(new Error('Failed to load Google Maps JS API script.'));
      });
      return;
    }

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(apiKey)}&v=weekly`;
    script.async = true;
    script.defer = true;
    script.dataset.forealGoogleMaps = '1';
    script.onload = () => {
      if (window.google?.maps) {
        resolve(window.google.maps);
      } else {
        reject(new Error('Google Maps JS API loaded without window.google.maps.'));
      }
    };
    script.onerror = () => {
      mapsScriptPromise = null;
      reject(new Error('Failed to load Google Maps JS API script.'));
    };
    document.head.appendChild(script);
  });

  return mapsScriptPromise;
}

export interface GoogleMapsViewportProps {
  mapsBrowserKey: string;
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
  onMapsLoadFailure: (reason: string) => void;
}

export const GoogleMapsViewport: React.FC<GoogleMapsViewportProps> = ({
  mapsBrowserKey,
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
  onMapsLoadFailure,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<GoogleMapInstance | null>(null);
  const overlaysRef = useRef<GoogleOverlayInstance[]>([]);
  const [mapsReady, setMapsReady] = useState(false);
  const [pannedCenter, setPannedCenter] = useState<CoordinatePoint | null>(null);

  useEffect(() => {
    let active = true;
    loadGoogleMapsApi(mapsBrowserKey)
      .then((gmaps) => {
        if (!active || !containerRef.current) {
          return;
        }
        if (!mapRef.current) {
          const center = analysisArea
            ? { lat: analysisArea.centerLat, lng: analysisArea.centerLng }
            : { lat: 39.8283, lng: -98.5795 };
          const map = new gmaps.Map(containerRef.current, {
            center,
            zoom: analysisArea ? 13 : 4,
            mapTypeControl: true,
            streetViewControl: false,
          });
          map.addListener('dragend', () => {
            const c = map.getCenter();
            if (c) {
              setPannedCenter({ lat: c.lat(), lng: c.lng() });
            }
          });
          mapRef.current = map;
        }
        setMapsReady(true);
      })
      .catch((err) => {
        if (active) {
          onMapsLoadFailure(err instanceof Error ? err.message : 'Google Maps load failed.');
        }
      });
    return () => {
      active = false;
    };
  }, [mapsBrowserKey, onMapsLoadFailure]);

  useEffect(() => {
    if (!mapsReady || !mapRef.current || !analysisArea) {
      return;
    }
    mapRef.current.setCenter({ lat: analysisArea.centerLat, lng: analysisArea.centerLng });
    mapRef.current.setZoom(analysisArea.radiusMeters <= 1200 ? 14 : 13);
    setPannedCenter(null);
  }, [mapsReady, analysisArea?.areaId, analysisArea?.centerLat, analysisArea?.centerLng, analysisArea?.radiusMeters]);

  useEffect(() => {
    const gmaps = window.google?.maps;
    const map = mapRef.current;
    if (!mapsReady || !gmaps || !map) {
      return;
    }

    for (const overlay of overlaysRef.current) {
      overlay.setMap(null);
    }
    overlaysRef.current = [];

    const nextOverlays: GoogleOverlayInstance[] = [];

    if (analysisArea) {
      nextOverlays.push(
        new gmaps.Circle({
          map,
          center: { lat: analysisArea.centerLat, lng: analysisArea.centerLng },
          radius: analysisArea.radiusMeters,
          strokeColor: '#1d4ed8',
          strokeOpacity: 0.9,
          strokeWeight: 2,
          fillColor: '#2563eb',
          fillOpacity: 0.06,
          clickable: false,
        })
      );

      if (influenceFetchRadiusMeters) {
        nextOverlays.push(
          new gmaps.Circle({
            map,
            center: { lat: analysisArea.centerLat, lng: analysisArea.centerLng },
            radius: influenceFetchRadiusMeters,
            strokeColor: '#64748b',
            strokeOpacity: 0.7,
            strokeWeight: 1.5,
            fillOpacity: 0,
            clickable: false,
          })
        );
      }
    }

    if (showGridOverlap && gridOverlap) {
      const latStep =
        (gridOverlap.radiusMeters / Math.max(4, gridOverlap.gridResolution)) / 111_320;
      const cosLat = Math.max(0.15, Math.cos((gridOverlap.center.lat * Math.PI) / 180));
      const lngStep = latStep / cosLat;

      for (const cell of gridOverlap.cells) {
        const isSweetSpot = gridOverlap.sweetSpotCells.some((s) => s.cellId === cell.cellId);
        nextOverlays.push(
          new gmaps.Rectangle({
            map,
            bounds: {
              north: cell.lat + latStep * 0.85,
              south: cell.lat - latStep * 0.85,
              east: cell.lng + lngStep * 0.85,
              west: cell.lng - lngStep * 0.85,
            },
            strokeColor: isSweetSpot ? '#0f766e' : '#64748b',
            strokeOpacity: isSweetSpot ? 0.85 : 0.25,
            strokeWeight: isSweetSpot ? 1.5 : 0.5,
            fillColor: isSweetSpot ? '#0f766e' : cell.overlapCount >= 2 ? '#0284c7' : '#94a3b8',
            fillOpacity: isSweetSpot ? 0.35 : 0.16,
            clickable: false,
          })
        );
      }
    }

    const filteredAmenities = amenities.filter((f) => {
      const cat = f.category as AmenityCategory;
      return cat in visibleCategories ? visibleCategories[cat] : true;
    });

    if (showFacilityCircles) {
      for (const facility of filteredAmenities.slice(0, 60)) {
        const cat = facility.category as AmenityCategory;
        const color = CATEGORY_COLORS[cat]?.fill ?? '#475569';
        const radius = preferences.radiiMeters[cat] ?? 1200;
        nextOverlays.push(
          new gmaps.Circle({
            map,
            center: { lat: facility.lat, lng: facility.lng },
            radius,
            strokeColor: color,
            strokeOpacity: 0.28,
            strokeWeight: 1,
            fillColor: color,
            fillOpacity: 0.05,
            clickable: false,
          })
        );
      }
    }

    for (const facility of filteredAmenities) {
      const cat = facility.category as AmenityCategory;
      const color = CATEGORY_COLORS[cat]?.fill ?? '#475569';
      nextOverlays.push(
        new gmaps.Marker({
          map,
          position: { lat: facility.lat, lng: facility.lng },
          title: `${facility.name} (${facility.category})`,
          icon: gmaps.SymbolPath
            ? {
                path: gmaps.SymbolPath.CIRCLE,
                scale: 5,
                fillColor: color,
                fillOpacity: 0.9,
                strokeColor: '#ffffff',
                strokeWeight: 1,
              }
            : undefined,
        })
      );
    }

    if (preferences.includeEnvironmentalDueDiligenceLayer ?? true) {
      for (const rec of environmentalRecords) {
        nextOverlays.push(
          new gmaps.Marker({
            map,
            position: { lat: rec.lat, lng: rec.lng },
            title: `EPA FRS: ${rec.name} (${rec.registryId}) — Due diligence only`,
            label: 'E',
          })
        );
      }
    }

    if (showPlacesContext) {
      for (const place of displayOnlyPlacesContext) {
        nextOverlays.push(
          new gmaps.Marker({
            map,
            position: { lat: place.lat, lng: place.lng },
            title: `[Excluded from Scoring] ${place.name}`,
            label: 'X',
          })
        );
      }
    }

    listings.forEach((listing, idx) => {
      const marker = new gmaps.Marker({
        map,
        position: { lat: listing.latitude, lng: listing.longitude },
        title: `${listing.formattedAddress} · ${formatCurrencyUsd(listing.askingPrice)} (${RANGE_POSITION_META[listing.priceGap.rangePosition].shortLabel})`,
        label: String(idx + 1),
        zIndex: listing.id === selectedPropertyId ? 999 : 100,
      });
      marker.addListener('click', () => onSelectProperty(listing.id));
      nextOverlays.push(marker);
    });

    overlaysRef.current = nextOverlays;
  }, [
    mapsReady,
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
  ]);

  const hasPanned =
    Boolean(pannedCenter) &&
    (!analysisArea ||
      Math.abs((pannedCenter?.lat ?? 0) - analysisArea.centerLat) > 0.0004 ||
      Math.abs((pannedCenter?.lng ?? 0) - analysisArea.centerLng) > 0.0004);

  return (
    <div className="google-map-shell" data-testid="google-maps-viewport">
      {hasPanned && pannedCenter && (
        <div className="map-toolbar">
          <span className="muted-xs">
            Map panned to ({pannedCenter.lat.toFixed(4)}, {pannedCenter.lng.toFixed(4)}). Zero API
            calls made on pan.
          </span>
          <button
            type="button"
            className="btn btn-primary btn-xs"
            onClick={() =>
              onAnalyzeViewportCenter(pannedCenter, analysisArea?.radiusMeters ?? 1600)
            }
          >
            Analyze Current Viewport
          </button>
        </div>
      )}
      <div
        ref={containerRef}
        className="google-map-canvas"
        aria-label="Interactive Google Map basemap"
      />
      <p className="muted-xs map-projection-note">
        Google Maps JS basemap active · © OpenStreetMap contributors (ODbL) · Map data © Google
      </p>
    </div>
  );
};
