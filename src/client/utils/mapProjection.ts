import type { BoundingBox, CoordinatePoint } from '../../shared/types';

export interface SvgViewportProjection {
  width: number;
  height: number;
  centerLat: number;
  centerLng: number;
  boundingBox: BoundingBox;
  metersPerPixel: number;
}

const EARTH_METERS_PER_DEGREE_LAT = 111_320;

/**
 * Builds an equirectangular WGS84 SVG projection centered at `(centerLat, centerLng)`
 * covering at least `spanRadiusMeters` in every direction.
 */
export function createSvgViewportProjection(
  centerLat: number,
  centerLng: number,
  spanRadiusMeters: number,
  width = 640,
  height = 460
): SvgViewportProjection {
  const safeSpan = Math.max(400, spanRadiusMeters);
  const paddingFactor = 1.2;
  const halfSpanMeters = safeSpan * paddingFactor;
  const minDimension = Math.min(width, height);
  const metersPerPixel = (halfSpanMeters * 2) / minDimension;

  const halfLatSpanDeg = (height / 2) * metersPerPixel / EARTH_METERS_PER_DEGREE_LAT;
  const cosLat = Math.max(0.15, Math.cos((centerLat * Math.PI) / 180));
  const halfLngSpanDeg = (width / 2) * metersPerPixel / (EARTH_METERS_PER_DEGREE_LAT * cosLat);

  return {
    width,
    height,
    centerLat,
    centerLng,
    metersPerPixel,
    boundingBox: {
      minLat: centerLat - halfLatSpanDeg,
      maxLat: centerLat + halfLatSpanDeg,
      minLng: centerLng - halfLngSpanDeg,
      maxLng: centerLng + halfLngSpanDeg,
    },
  };
}

export function projectLatLngToSvg(
  point: CoordinatePoint,
  projection: SvgViewportProjection
): { x: number; y: number } {
  const { boundingBox, width, height } = projection;
  const lngSpan = Math.max(1e-7, boundingBox.maxLng - boundingBox.minLng);
  const latSpan = Math.max(1e-7, boundingBox.maxLat - boundingBox.minLat);

  const x = ((point.lng - boundingBox.minLng) / lngSpan) * width;
  const y = ((boundingBox.maxLat - point.lat) / latSpan) * height;

  return { x, y };
}

export function metersToSvgPixels(meters: number, projection: SvgViewportProjection): number {
  return Math.max(1, meters / projection.metersPerPixel);
}

export function shiftCenterByMeters(
  centerLat: number,
  centerLng: number,
  deltaNorthMeters: number,
  deltaEastMeters: number
): CoordinatePoint {
  const latDelta = deltaNorthMeters / EARTH_METERS_PER_DEGREE_LAT;
  const cosLat = Math.max(0.15, Math.cos((centerLat * Math.PI) / 180));
  const lngDelta = deltaEastMeters / (EARTH_METERS_PER_DEGREE_LAT * cosLat);

  return {
    lat: Number(Math.max(-85, Math.min(85, centerLat + latDelta)).toFixed(6)),
    lng: Number(Math.max(-179.9, Math.min(179.9, centerLng + lngDelta)).toFixed(6)),
  };
}
