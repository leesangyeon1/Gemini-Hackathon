/**
 * Bounded TTL Spatial & Area Dataset Cache (`src/server/geospatial/cache.ts`)
 *
 * Caches licensed OpenStreetMap (`osm_overpass`) and US EPA (`epa_frs`) geospatial
 * datasets by `areaId` and quantized spatial keys so repeated preference slider adjustments
 * and property selections evaluate deterministically in memory without hammering Overpass/EPA.
 *
 * SECURITY & LICENSE INVARIANT:
 * `google_places_context` records are never stored in the analysis facility cache.
 */

import type {
  AnalysisArea,
  DisplayOnlyPlaceRecord,
  EnvironmentalLayerPayload,
  FacilityRecord,
} from "../../shared/types";
import type { CategorySourceStatus, ScorableFacilityInput } from "./scoring";
import { filterEligibleFacilities } from "./sourcePolicy";

export interface BoundedTtlCacheOptions {
  readonly maxEntries?: number;
  readonly ttlMs?: number;
  readonly nowFn?: () => number;
}

interface CacheBucket<V> {
  readonly value: V;
  readonly expiresAt: number;
}

export class BoundedTtlCache<V> {
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly nowFn: () => number;
  private readonly store = new Map<string, CacheBucket<V>>();

  constructor(options: BoundedTtlCacheOptions = {}) {
    this.maxEntries = Math.max(1, options.maxEntries ?? 128);
    this.ttlMs = Math.max(1_000, options.ttlMs ?? 15 * 60 * 1_000);
    this.nowFn = options.nowFn ?? (() => Date.now());
  }

  public get(key: string): V | null {
    const entry = this.store.get(key);
    if (!entry) {
      return null;
    }
    if (this.nowFn() > entry.expiresAt) {
      this.store.delete(key);
      return null;
    }
    // Refresh LRU order
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  public set(key: string, value: V, customTtlMs?: number): void {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }

    const effectiveTtl =
      customTtlMs !== undefined && customTtlMs > 0 ? customTtlMs : this.ttlMs;
    this.store.set(key, {
      value,
      expiresAt: this.nowFn() + effectiveTtl,
    });
  }

  public delete(key: string): boolean {
    return this.store.delete(key);
  }

  public clear(): void {
    this.store.clear();
  }

  public size(): number {
    return this.store.size;
  }
}

export interface CachedAreaGeospatialEntry {
  readonly areaId: string;
  readonly spatialKey: string;
  readonly analysisArea: AnalysisArea;
  readonly isSyntheticDemo: boolean;
  readonly dataMode: "live_open_data" | "synthetic_demo";
  readonly influenceFetchRadiusMeters: number;
  /** Validated & policy-filtered amenity facility candidates (never `google_places_context`) */
  readonly eligibleFacilityCandidates: ScorableFacilityInput[];
  /** Deduplicated facility records with distance from area center */
  readonly amenities: FacilityRecord[];
  readonly categorySourceStatuses: Record<string, CategorySourceStatus>;
  readonly environmentalLayer: EnvironmentalLayerPayload;
  readonly displayOnlyPlacesContext: DisplayOnlyPlaceRecord[];
  readonly fetchedAt: string;
}

/**
 * Builds a deterministic spatial cache key from center coordinates, influence-buffered fetch
 * radius, and data mode.
 */
export function buildSpatialFetchCacheKey(
  centerLat: number,
  centerLng: number,
  fetchRadiusMeters: number,
  isSyntheticDemo: boolean
): string {
  const latKey = centerLat.toFixed(4);
  const lngKey = centerLng.toFixed(4);
  const radiusBucket = Math.ceil(fetchRadiusMeters / 50) * 50;
  const modePrefix = isSyntheticDemo ? "synthetic" : "live";
  return `${modePrefix}:${latKey},${lngKey}:r${radiusBucket}`;
}

export class AreaGeospatialCache {
  private readonly byAreaId: BoundedTtlCache<CachedAreaGeospatialEntry>;
  private readonly bySpatialKey: BoundedTtlCache<CachedAreaGeospatialEntry>;

  constructor(options: BoundedTtlCacheOptions = {}) {
    this.byAreaId = new BoundedTtlCache<CachedAreaGeospatialEntry>(options);
    this.bySpatialKey = new BoundedTtlCache<CachedAreaGeospatialEntry>(options);
  }

  public getByAreaId(areaId: string): CachedAreaGeospatialEntry | null {
    return this.byAreaId.get(areaId);
  }

  public getBySpatialKey(spatialKey: string): CachedAreaGeospatialEntry | null {
    return this.bySpatialKey.get(spatialKey);
  }

  /**
   * Stores an area dataset after enforcing that `eligibleFacilityCandidates` and `amenities`
   * contain zero `google_places_context` or ineligible records.
   */
  public put(entry: CachedAreaGeospatialEntry, allowSyntheticDemo = false): void {
    const safeCandidates = filterEligibleFacilities(entry.eligibleFacilityCandidates, {
      allowSyntheticDemo,
      requireAmenityEligible: true,
    });
    const safeAmenities = filterEligibleFacilities(entry.amenities, {
      allowSyntheticDemo,
      requireAmenityEligible: true,
    });

    const sanitizedEntry: CachedAreaGeospatialEntry = {
      ...entry,
      eligibleFacilityCandidates: safeCandidates,
      amenities: safeAmenities,
    };

    this.byAreaId.set(entry.areaId, sanitizedEntry);
    this.bySpatialKey.set(entry.spatialKey, sanitizedEntry);
  }

  public clear(): void {
    this.byAreaId.clear();
    this.bySpatialKey.clear();
  }
}
