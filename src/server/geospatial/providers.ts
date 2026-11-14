/**
 * Licensed Geospatial & Environmental Data Providers (`src/server/geospatial/providers.ts`)
 *
 * Implements:
 * 1. OpenStreetMap Overpass API client (`sourceId: "osm_overpass"`, ODbL 1.0) fetching out to
 *    the influence-buffered radius `analysisArea.radiusMeters + max(radius_c)`.
 * 2. US EPA Facility Registry Service (FRS) client (`sourceId: "epa_frs"`, Public Domain)
 *    populating the separate user-controlled `environmentalLayer` (`isAutomaticHealthDetermination: false`).
 * 3. Optional display-only Google Places context client (`sourceId: "google_places_context"`,
 *    `analysisEligible: false`) strictly isolated from scoring, heatmaps, feature storage, and explain evidence.
 * 4. Coordinate-anchored Synthetic Demo fixture generator (`sourceId: "synthetic_demo"`) for
 *    opt-in `ENABLE_SYNTHETIC_DEMO_MODE=true`.
 */

import { ENVIRONMENTAL_LAYER_DISCLAIMER } from "../../shared/constants";
import type {
  AmenityCategory,
  AnalysisArea,
  CoordinatePoint,
  DisplayOnlyPlaceRecord,
  EnvironmentalLayerPayload,
} from "../../shared/types";
import {
  type CategorySourceStatus,
  type EnvironmentalCandidateInput,
  type ScorableFacilityInput,
  DEFAULT_AMENITY_CATEGORIES,
  WGS84_MEAN_EARTH_RADIUS_METERS,
  evaluateEnvironmentalLayer,
  isValidCoordinate,
} from "./scoring";
import { SOURCE_POLICY_REGISTRY } from "./sourcePolicy";

export const DEFAULT_OVERPASS_TIMEOUT_MS = 8_000;
export const DEFAULT_EPA_TIMEOUT_MS = 6_000;
export const DEFAULT_PLACES_TIMEOUT_MS = 4_000;

export const GEOSPATIAL_USER_AGENT =
  "ForealEstateHackathonPrototype/1.0 (ODbL-1.0; Berkeley-DeepMind-Hackathon)";

export interface OsmFetchResult {
  readonly status: "ok" | "failed" | "timeout";
  readonly facilities: ScorableFacilityInput[];
  readonly categorySourceStatuses: Record<string, CategorySourceStatus>;
  readonly errorMessage?: string;
}

/**
 * Offsets a WGS84 coordinate by `(northMeters, eastMeters)` for coordinate-anchored
 * deterministic synthetic fixtures at any US latitude/longitude.
 */
export function offsetCoordinateByMeters(
  origin: CoordinatePoint,
  northMeters: number,
  eastMeters: number
): CoordinatePoint {
  const dLat =
    (northMeters / WGS84_MEAN_EARTH_RADIUS_METERS) * (180 / Math.PI);
  const cosLat = Math.max(
    0.1,
    Math.cos((origin.lat * Math.PI) / 180)
  );
  const dLng =
    (eastMeters / (WGS84_MEAN_EARTH_RADIUS_METERS * cosLat)) *
    (180 / Math.PI);

  return {
    lat: Number(Math.max(-89.999, Math.min(89.999, origin.lat + dLat)).toFixed(6)),
    lng: Number(
      Math.max(-179.999, Math.min(179.999, origin.lng + dLng)).toFixed(6)
    ),
  };
}

/**
 * Maps an OpenStreetMap element's `tags` to one of the canonical `AmenityCategory` buckets.
 *
 * Bare industrial, factory, warehouse, or data-center tags (`landuse=industrial`,
 * `man_made=works`, `telecom=data_center`) intentionally return `null` so they remain neutral.
 */
export function classifyOsmTagsToAmenityCategory(
  tags: Readonly<Record<string, string>> | undefined
): AmenityCategory | null {
  if (!tags) {
    return null;
  }

  // Bare industrial / factory / data-center tags are explicitly neutral
  if (
    tags.landuse === "industrial" ||
    tags.man_made === "works" ||
    tags.industrial !== undefined ||
    tags.telecom === "data_center"
  ) {
    if (!tags.shop && !tags.amenity && !tags.leisure && !tags.railway && !tags.public_transport) {
      return null;
    }
  }

  const shop = (tags.shop ?? "").toLowerCase();
  const amenity = (tags.amenity ?? "").toLowerCase();
  const leisure = (tags.leisure ?? "").toLowerCase();
  const railway = (tags.railway ?? "").toLowerCase();
  const highway = (tags.highway ?? "").toLowerCase();
  const publicTransport = (tags.public_transport ?? "").toLowerCase();

  if (
    shop === "supermarket" ||
    shop === "grocery" ||
    shop === "greengrocer" ||
    shop === "convenience" ||
    shop === "Wholefoods" ||
    amenity === "marketplace"
  ) {
    return "grocery";
  }

  if (
    leisure === "park" ||
    leisure === "nature_reserve" ||
    leisure === "garden" ||
    leisure === "playground"
  ) {
    return "parks";
  }

  if (
    railway === "station" ||
    railway === "tram_stop" ||
    railway === "subway_entrance" ||
    railway === "halt" ||
    highway === "bus_stop" ||
    publicTransport === "station" ||
    publicTransport === "platform" ||
    publicTransport === "stop_position" ||
    amenity === "bus_station" ||
    amenity === "ferry_terminal"
  ) {
    return "transit";
  }

  if (
    amenity === "hospital" ||
    amenity === "clinic" ||
    amenity === "pharmacy" ||
    amenity === "doctors" ||
    amenity === "dentist"
  ) {
    return "healthcare";
  }

  if (
    amenity === "school" ||
    amenity === "library" ||
    amenity === "kindergarten" ||
    amenity === "college" ||
    amenity === "university"
  ) {
    return "schools";
  }

  if (
    amenity === "fast_food" ||
    amenity === "restaurant" ||
    amenity === "cafe"
  ) {
    return "fast_food";
  }

  return null;
}

/**
 * Builds a bounded Overpass QL query around `(centerLat, centerLng)` out to `fetchRadiusMeters`.
 */
export function buildOverpassAmenityQuery(
  centerLat: number,
  centerLng: number,
  fetchRadiusMeters: number,
  timeoutSeconds = 8
): string {
  const safeRadius = Math.max(200, Math.min(9_000, Math.round(fetchRadiusMeters)));
  const lat = centerLat.toFixed(6);
  const lng = centerLng.toFixed(6);
  const around = `around:${safeRadius},${lat},${lng}`;

  return [
    `[out:json][timeout:${timeoutSeconds}];`,
    `(`,
    `  nwr["shop"~"^(supermarket|grocery|greengrocer|convenience)$"](${around});`,
    `  nwr["leisure"~"^(park|nature_reserve|garden)$"](${around});`,
    `  nwr["public_transport"~"^(station|platform|stop_position)$"](${around});`,
    `  nwr["railway"~"^(station|tram_stop|subway_entrance)$"](${around});`,
    `  node["highway"="bus_stop"](${around});`,
    `  nwr["amenity"~"^(hospital|clinic|pharmacy|doctors|school|library|kindergarten|fast_food|restaurant|cafe)$"](${around});`,
    `);`,
    `out center 350;`,
  ].join("\n");
}

interface OverpassElement {
  readonly type?: string;
  readonly id?: number | string;
  readonly lat?: number;
  readonly lon?: number;
  readonly center?: { readonly lat?: number; readonly lon?: number };
  readonly tags?: Record<string, string>;
}

/**
 * Fetches licensed OpenStreetMap amenities from `osmOverpassUrl` out to `fetchRadiusMeters`.
 *
 * - Healthy response with 0 facilities => `status: "ok"`, category statuses `"ok"`, `a_c = 0`.
 * - Failed / timed-out response => `status: "failed" | "timeout"`, category statuses `"failed" | "timeout"`
 *   so `computeAccessibilityScore` marks weighted categories `"unknown"` and `completeness: "partial" | "unknown"`.
 */
export async function fetchOsmOverpassAmenities(params: {
  readonly osmOverpassUrl: string;
  readonly centerLat: number;
  readonly centerLng: number;
  readonly fetchRadiusMeters: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}): Promise<OsmFetchResult> {
  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const timeoutMs = params.timeoutMs ?? DEFAULT_OVERPASS_TIMEOUT_MS;
  const query = buildOverpassAmenityQuery(
    params.centerLat,
    params.centerLng,
    params.fetchRadiusMeters,
    Math.max(3, Math.ceil(timeoutMs / 1000))
  );

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(params.osmOverpassUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Accept: "application/json",
        "User-Agent": GEOSPATIAL_USER_AGENT,
      },
      body: `data=${encodeURIComponent(query)}`,
      signal: controller.signal,
    });

    if (!response.ok) {
      const failedStatuses: Record<string, CategorySourceStatus> = {};
      for (const cat of DEFAULT_AMENITY_CATEGORIES) {
        failedStatuses[cat] = "failed";
      }
      return {
        status: "failed",
        facilities: [],
        categorySourceStatuses: failedStatuses,
        errorMessage: `Overpass API HTTP ${response.status}`,
      };
    }

    const payload = (await response.json()) as { elements?: unknown };
    if (!payload || !Array.isArray(payload.elements)) {
      const failedStatuses: Record<string, CategorySourceStatus> = {};
      for (const cat of DEFAULT_AMENITY_CATEGORIES) {
        failedStatuses[cat] = "failed";
      }
      return {
        status: "failed",
        facilities: [],
        categorySourceStatuses: failedStatuses,
        errorMessage: "Overpass response missing elements array.",
      };
    }

    const facilities: ScorableFacilityInput[] = [];
    for (const rawEl of payload.elements as OverpassElement[]) {
      if (!rawEl || typeof rawEl !== "object") {
        continue;
      }
      const category = classifyOsmTagsToAmenityCategory(rawEl.tags);
      if (!category) {
        continue;
      }

      const lat =
        typeof rawEl.lat === "number" ? rawEl.lat : rawEl.center?.lat;
      const lng =
        typeof rawEl.lon === "number" ? rawEl.lon : rawEl.center?.lon;

      if (!isValidCoordinate(lat, lng)) {
        continue;
      }

      const rawId = rawEl.id !== undefined ? String(rawEl.id) : "";
      const osmType = rawEl.type ?? "node";
      const externalId = rawId ? `osm:${osmType}:${rawId}` : undefined;
      const name =
        rawEl.tags?.name?.trim() ||
        rawEl.tags?.brand?.trim() ||
        rawEl.tags?.operator?.trim() ||
        category;

      facilities.push({
        id: externalId ?? `osm:${category}:${lat},${lng}`,
        externalId,
        sourceId: "osm_overpass",
        category,
        name,
        lat: lat as number,
        lng: lng as number,
        analysisEligible: true,
        tags: rawEl.tags,
      });
    }

    const okStatuses: Record<string, CategorySourceStatus> = {};
    for (const cat of DEFAULT_AMENITY_CATEGORIES) {
      okStatuses[cat] = "ok";
    }

    return {
      status: "ok",
      facilities,
      categorySourceStatuses: okStatuses,
    };
  } catch (err) {
    const isAbort =
      err instanceof Error &&
      (err.name === "AbortError" || err.name === "TimeoutError");
    const statusKind: CategorySourceStatus = isAbort ? "timeout" : "failed";
    const statuses: Record<string, CategorySourceStatus> = {};
    for (const cat of DEFAULT_AMENITY_CATEGORIES) {
      statuses[cat] = statusKind;
    }

    return {
      status: statusKind,
      facilities: [],
      categorySourceStatuses: statuses,
      errorMessage:
        err instanceof Error ? err.message : "Overpass request failed.",
    };
  } finally {
    clearTimeout(timer);
  }
}

interface EpaFrsFacilityRow {
  readonly RegistryId?: string;
  readonly REGISTRY_ID?: string;
  readonly FacilityName?: string;
  readonly PRIMARY_NAME?: string;
  readonly Latitude83?: string | number;
  readonly LATITUDE83?: string | number;
  readonly Longitude83?: string | number;
  readonly LONGITUDE83?: string | number;
  readonly PGM_SYS_ACRNMS?: string;
  readonly ProgramFacilities?: unknown;
}

/**
 * Fetches documented US EPA Facility Registry Service (FRS) records (`sourceId: "epa_frs"`)
 * for the separate user-controlled environmental due-diligence layer.
 *
 * If the EPA endpoint fails or times out, returns `status: "unknown"` rather than claiming
 * zero regulated sites.
 */
export async function fetchEpaFrsEnvironmentalRecords(params: {
  readonly centerLat: number;
  readonly centerLng: number;
  readonly fetchRadiusMeters: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}): Promise<EnvironmentalLayerPayload> {
  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const timeoutMs = params.timeoutMs ?? DEFAULT_EPA_TIMEOUT_MS;
  const radiusMiles = Math.max(0.5, Math.min(5, params.fetchRadiusMeters / 1609.344));

  const url = new URL(
    "https://ofmpub.epa.gov/frs_public2/frs_rest_services.get_facilities"
  );
  url.searchParams.set("latitude83", params.centerLat.toFixed(5));
  url.searchParams.set("longitude83", params.centerLng.toFixed(5));
  url.searchParams.set("search_radius", radiusMiles.toFixed(2));
  url.searchParams.set("output", "JSON");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(url.toString(), {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": GEOSPATIAL_USER_AGENT,
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return {
        status: "unknown",
        records: [],
        disclaimer: ENVIRONMENTAL_LAYER_DISCLAIMER,
      };
    }

    const payload = (await response.json()) as {
      Results?: { FRSFacility?: EpaFrsFacilityRow | EpaFrsFacilityRow[] };
    };

    const rawFacilities = payload?.Results?.FRSFacility;
    const rows: EpaFrsFacilityRow[] = Array.isArray(rawFacilities)
      ? rawFacilities
      : rawFacilities && typeof rawFacilities === "object"
      ? [rawFacilities]
      : [];

    const candidates: EnvironmentalCandidateInput[] = [];
    for (const row of rows) {
      const lat = Number(row.Latitude83 ?? row.LATITUDE83);
      const lng = Number(row.Longitude83 ?? row.LONGITUDE83);
      if (!isValidCoordinate(lat, lng)) {
        continue;
      }

      const registryId = String(
        row.RegistryId ?? row.REGISTRY_ID ?? ""
      ).trim();
      const name = String(
        row.FacilityName ?? row.PRIMARY_NAME ?? "EPA Regulated Facility"
      ).trim();

      const programs: string[] = [];
      if (typeof row.PGM_SYS_ACRNMS === "string" && row.PGM_SYS_ACRNMS.trim()) {
        for (const token of row.PGM_SYS_ACRNMS.split(/[,;\s]+/)) {
          const trimmed = token.trim();
          if (trimmed) {
            programs.push(trimmed);
          }
        }
      } else if (Array.isArray(row.ProgramFacilities)) {
        for (const pf of row.ProgramFacilities) {
          if (
            pf &&
            typeof pf === "object" &&
            "ProgramSystemAcronym" in pf &&
            typeof (pf as { ProgramSystemAcronym?: unknown }).ProgramSystemAcronym === "string"
          ) {
            programs.push(
              String((pf as { ProgramSystemAcronym: string }).ProgramSystemAcronym)
            );
          }
        }
      } else if (registryId) {
        programs.push("EPA-FRS");
      }

      if (programs.length === 0) {
        continue;
      }

      candidates.push({
        id: registryId ? `epa:${registryId}` : undefined,
        registryId: registryId || "EPA-FRS",
        sourceId: "epa_frs",
        name,
        lat,
        lng,
        programs,
        activePermitsOrEmissions: true,
        status: "Documented EPA FRS Program Registration",
        profileUrl: registryId
          ? `https://ofmpub.epa.gov/frs_public2/fii_query_detail.disp_program_facility?p_registry_id=${encodeURIComponent(
              registryId
            )}`
          : undefined,
      });
    }

    const evaluated = evaluateEnvironmentalLayer(
      { lat: params.centerLat, lng: params.centerLng },
      candidates,
      params.fetchRadiusMeters,
      { allowSyntheticDemo: false }
    ).map((rec) => ({
      ...rec,
      attribution: SOURCE_POLICY_REGISTRY.epa_frs.attributionText,
    }));

    return {
      status: "ok",
      records: evaluated.slice(0, 25),
      disclaimer: ENVIRONMENTAL_LAYER_DISCLAIMER,
    };
  } catch {
    return {
      status: "unknown",
      records: [],
      disclaimer: ENVIRONMENTAL_LAYER_DISCLAIMER,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Optional display-only Google Places context fetch (`sourceId: "google_places_context"`,
 * `analysisEligible: false`).
 *
 * Strictly isolated from scoring, heatmaps, feature storage, and `/api/explain` evidence.
 */
export async function fetchDisplayOnlyGooglePlacesContext(params: {
  readonly googlePlacesServerKey: string | null;
  readonly centerLat: number;
  readonly centerLng: number;
  readonly radiusMeters: number;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}): Promise<DisplayOnlyPlaceRecord[]> {
  if (!params.googlePlacesServerKey) {
    return [];
  }

  const fetchFn = params.fetchImpl ?? globalThis.fetch;
  const timeoutMs = params.timeoutMs ?? DEFAULT_PLACES_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchFn(
      "https://places.googleapis.com/v1/places:searchNearby",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": params.googlePlacesServerKey,
          "X-Goog-FieldMask":
            "places.id,places.displayName,places.location,places.primaryType,places.formattedAddress",
        },
        body: JSON.stringify({
          maxResultCount: 10,
          locationRestriction: {
            circle: {
              center: {
                latitude: params.centerLat,
                longitude: params.centerLng,
              },
              radius: Math.min(5000, Math.max(200, params.radiusMeters)),
            },
          },
        }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      return [];
    }

    const data = (await response.json()) as {
      places?: Array<{
        id?: string;
        displayName?: { text?: string };
        location?: { latitude?: number; longitude?: number };
        primaryType?: string;
        formattedAddress?: string;
      }>;
    };

    if (!data || !Array.isArray(data.places)) {
      return [];
    }

    const displayRecords: DisplayOnlyPlaceRecord[] = [];
    for (const place of data.places) {
      const lat = place.location?.latitude;
      const lng = place.location?.longitude;
      if (!isValidCoordinate(lat, lng)) {
        continue;
      }
      displayRecords.push({
        placeId: String(place.id ?? `gplace_${lat}_${lng}`),
        sourceId: "google_places_context",
        analysisEligible: false,
        name: place.displayName?.text ?? "Nearby Place",
        lat: lat as number,
        lng: lng as number,
        primaryType: place.primaryType,
        formattedAddress: place.formattedAddress,
        attribution: SOURCE_POLICY_REGISTRY.google_places_context.attributionText,
      });
    }

    return displayRecords;
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export interface SyntheticGeospatialDataset {
  readonly facilities: ScorableFacilityInput[];
  readonly categorySourceStatuses: Record<string, CategorySourceStatus>;
  readonly environmentalLayer: EnvironmentalLayerPayload;
}

/**
 * Generates deterministic, coordinate-anchored synthetic demo facilities and environmental
 * due-diligence records around any US `analysisArea`.
 *
 * Includes:
 * - Multi-category facilities within `analysisArea.radiusMeters`
 * - A duplicate OSM-style node/way pair to demonstrate deterministic deduplication
 * - A buffered edge facility outside `analysisArea.radiusMeters` (within `influenceFetchRadiusMeters`)
 *   so boundary points capture neighborhood facilities across the area border
 * - Separate `synthetic_demo` EPA FRS environmental due-diligence records (`isAutomaticHealthDetermination: false`)
 */
export function generateSyntheticGeospatialDataset(
  analysisArea: AnalysisArea,
  influenceFetchRadiusMeters: number
): SyntheticGeospatialDataset {
  const center: CoordinatePoint = {
    lat: analysisArea.centerLat,
    lng: analysisArea.centerLng,
  };
  const areaLabel = analysisArea.city ?? analysisArea.label ?? "Metro";
  const edgeDistanceNorth = Math.min(
    influenceFetchRadiusMeters - 100,
    analysisArea.radiusMeters + 250
  );

  const specs: Array<{
    id: string;
    category: AmenityCategory;
    name: string;
    northMeters: number;
    eastMeters: number;
  }> = [
    {
      id: `synth_${analysisArea.areaId}_grocery_1`,
      category: "grocery",
      name: `${areaLabel} Community Market & Grocery`,
      northMeters: 260,
      eastMeters: 180,
    },
    {
      id: `synth_${analysisArea.areaId}_grocery_2`,
      category: "grocery",
      name: `${areaLabel} Fresh Foods Co-op`,
      northMeters: -480,
      eastMeters: 360,
    },
    // Near-identical duplicate entry (4m away, same name) to exercise conservative deduplication
    {
      id: `synth_${analysisArea.areaId}_grocery_2_dup_way`,
      category: "grocery",
      name: `${areaLabel} Fresh Foods Co-op`,
      northMeters: -483,
      eastMeters: 362,
    },
    // Buffered edge facility just outside analysisArea.radiusMeters
    {
      id: `synth_${analysisArea.areaId}_grocery_edge_buffer`,
      category: "grocery",
      name: `${areaLabel} Perimeter Regional Supermarket`,
      northMeters: edgeDistanceNorth,
      eastMeters: 0,
    },
    {
      id: `synth_${analysisArea.areaId}_parks_1`,
      category: "parks",
      name: `${areaLabel} Central Commons Park`,
      northMeters: 170,
      eastMeters: -210,
    },
    {
      id: `synth_${analysisArea.areaId}_parks_2`,
      category: "parks",
      name: `${areaLabel} Creekside Greenway`,
      northMeters: -390,
      eastMeters: -320,
    },
    {
      id: `synth_${analysisArea.areaId}_parks_3`,
      category: "parks",
      name: `${areaLabel} Botanical Pocket Garden`,
      northMeters: 590,
      eastMeters: 290,
    },
    {
      id: `synth_${analysisArea.areaId}_transit_1`,
      category: "transit",
      name: `${areaLabel} Central Transit Station`,
      northMeters: 140,
      eastMeters: 105,
    },
    {
      id: `synth_${analysisArea.areaId}_transit_2`,
      category: "transit",
      name: `${areaLabel} Crosstown Rapid Bus Stop`,
      northMeters: -240,
      eastMeters: 170,
    },
    {
      id: `synth_${analysisArea.areaId}_transit_3`,
      category: "transit",
      name: `${areaLabel} Civic Plaza Transit Platform`,
      northMeters: 440,
      eastMeters: -180,
    },
    {
      id: `synth_${analysisArea.areaId}_healthcare_1`,
      category: "healthcare",
      name: `${areaLabel} Community Health & Urgent Care`,
      northMeters: -310,
      eastMeters: 270,
    },
    {
      id: `synth_${analysisArea.areaId}_healthcare_2`,
      category: "healthcare",
      name: `${areaLabel} Neighborhood Pharmacy & Clinic`,
      northMeters: 510,
      eastMeters: 430,
    },
    {
      id: `synth_${analysisArea.areaId}_schools_1`,
      category: "schools",
      name: `${areaLabel} Public Elementary School`,
      northMeters: 360,
      eastMeters: -290,
    },
    {
      id: `synth_${analysisArea.areaId}_schools_2`,
      category: "schools",
      name: `${areaLabel} Central Branch Public Library`,
      northMeters: -200,
      eastMeters: -260,
    },
    {
      id: `synth_${analysisArea.areaId}_fast_food_1`,
      category: "fast_food",
      name: `${areaLabel} QuickBurger Drive-Thru (Synthetic Context)`,
      northMeters: 210,
      eastMeters: 310,
    },
    {
      id: `synth_${analysisArea.areaId}_fast_food_2`,
      category: "fast_food",
      name: `${areaLabel} Corner Roast Cafe (Synthetic Context)`,
      northMeters: -160,
      eastMeters: 230,
    },
  ];

  const facilities: ScorableFacilityInput[] = specs.map((spec) => {
    const coord = offsetCoordinateByMeters(
      center,
      spec.northMeters,
      spec.eastMeters
    );
    return {
      id: spec.id,
      externalId: spec.id,
      sourceId: "synthetic_demo",
      category: spec.category,
      name: spec.name,
      lat: coord.lat,
      lng: coord.lng,
      analysisEligible: true,
    };
  });

  const envCoord1 = offsetCoordinateByMeters(center, -820, 590);
  const envCoord2 = offsetCoordinateByMeters(center, 1080, -680);
  const neutralIndustrialCoord = offsetCoordinateByMeters(center, 300, 300);

  const envCandidates: EnvironmentalCandidateInput[] = [
    {
      id: `synth_epa_${analysisArea.areaId}_1`,
      registryId: "SYNTH-FRS-1001",
      sourceId: "synthetic_demo",
      name: `${areaLabel} Materials Recovery & Transfer Facility (Synthetic Demo)`,
      lat: envCoord1.lat,
      lng: envCoord1.lng,
      programs: ["RCRAInfo (Hazardous Waste Handler)", "ICIS-AIR (Air Permit)"],
      activePermitsOrEmissions: true,
      status: "Synthetic Demo EPA FRS Program Record",
      profileUrl:
        "https://ofmpub.epa.gov/frs_public2/fii_query_detail.disp_program_facility?p_registry_id=110000000001",
    },
    {
      id: `synth_epa_${analysisArea.areaId}_2`,
      registryId: "SYNTH-FRS-1002",
      sourceId: "synthetic_demo",
      name: `${areaLabel} Municipal Water Treatment Facility (Synthetic Demo)`,
      lat: envCoord2.lat,
      lng: envCoord2.lng,
      programs: ["NPDES (Clean Water Act Discharge Permit)"],
      activePermitsOrEmissions: true,
      status: "Synthetic Demo EPA FRS Program Record",
      profileUrl:
        "https://ofmpub.epa.gov/frs_public2/fii_query_detail.disp_program_facility?p_registry_id=110000000002",
    },
    // Bare data-center / industrial building with zero active EPA programs -> ignored as neutral
    {
      id: `synth_neutral_datacenter_${analysisArea.areaId}`,
      registryId: "",
      sourceId: "synthetic_demo",
      name: `${areaLabel} Neutral Colocation Data Center`,
      lat: neutralIndustrialCoord.lat,
      lng: neutralIndustrialCoord.lng,
      programs: [],
      activePermitsOrEmissions: false,
    },
  ];

  const evaluatedEnv = evaluateEnvironmentalLayer(
    center,
    envCandidates,
    influenceFetchRadiusMeters,
    { allowSyntheticDemo: true }
  ).map((rec) => ({
    ...rec,
    attribution: SOURCE_POLICY_REGISTRY.synthetic_demo.attributionText,
  }));

  const categorySourceStatuses: Record<string, CategorySourceStatus> = {};
  for (const cat of DEFAULT_AMENITY_CATEGORIES) {
    categorySourceStatuses[cat] = "ok";
  }

  return {
    facilities,
    categorySourceStatuses,
    environmentalLayer: {
      status: "ok",
      records: evaluatedEnv,
      disclaimer: ENVIRONMENTAL_LAYER_DISCLAIMER,
    },
  };
}
