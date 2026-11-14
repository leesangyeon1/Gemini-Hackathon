/**
 * Server-Side Property Session, Cache & Request-Coalescing Store
 * (`src/server/property/sessionStore.ts`)
 *
 * Maintains server-verified property listings and on-demand AVM detail records
 * keyed by `(sessionId, propertyId)` so:
 * 1. Repeat clicks on an already-inspected property return cached AVM data with
 *    `0` additional provider calls.
 * 2. Concurrent duplicate clicks on the same property share a single in-flight promise.
 * 3. `POST /api/properties/:propertyId/avm` and `POST /api/explain` resolve
 *    authoritative property valuations from server state rather than trusting
 *    unverified client payloads.
 */

import crypto from 'node:crypto';
import type {
  AnalysisArea,
  PropertyDetailRecord,
  PropertyListingSummary,
} from '../../shared/types';

export interface PropertySessionRecord {
  readonly sessionId: string;
  analysisArea: AnalysisArea | null;
  isSyntheticDemo: boolean;
  readonly listingsById: Map<string, PropertyListingSummary>;
  readonly detailsById: Map<string, PropertyDetailRecord>;
  fetchedAt: string;
}

export interface ResolvedSessionPropertyLookup {
  readonly session: PropertySessionRecord | null;
  readonly listing: PropertyListingSummary | null;
  readonly detail: PropertyDetailRecord | null;
}

export interface CachedSearchEntry {
  readonly listings: PropertyListingSummary[];
  readonly isSyntheticDemo: boolean;
  readonly fetchedAt: string;
}

export interface PropertySessionStore {
  ensureSession(sessionId?: string): PropertySessionRecord;
  getSession(sessionId: string): PropertySessionRecord | null;
  recordSearchListings(params: {
    sessionId: string;
    analysisArea: AnalysisArea;
    listings: PropertyListingSummary[];
    isSyntheticDemo: boolean;
    fetchedAt: string;
  }): PropertySessionRecord;
  recordPropertyDetail(
    sessionId: string,
    detail: PropertyDetailRecord
  ): PropertyDetailRecord;
  getResolvedSessionProperty(
    sessionId: string,
    propertyId: string
  ): ResolvedSessionPropertyLookup;
  getCachedSearch(cacheKey: string): CachedSearchEntry | null;
  setCachedSearch(cacheKey: string, entry: CachedSearchEntry): void;
  getCachedAvmDetail(propertyKey: string): PropertyDetailRecord | null;
  setCachedAvmDetail(propertyKey: string, detail: PropertyDetailRecord): void;
  coalesceInFlight<T>(key: string, fn: () => Promise<T>): Promise<T>;
}

export function generateSessionId(): string {
  return `sess_${crypto.randomBytes(8).toString('hex')}`;
}

export function buildSearchCacheKey(params: {
  area: AnalysisArea;
  limit: number;
  propertyType?: string;
  isSyntheticDemo: boolean;
}): string {
  const lat = params.area.centerLat.toFixed(4);
  const lng = params.area.centerLng.toFixed(4);
  const rad = Math.round(params.area.radiusMeters);
  const type = (params.propertyType ?? 'ALL').toLowerCase();
  const mode = params.isSyntheticDemo ? 'syn' : 'live';
  return `${mode}:${lat},${lng}:${rad}:${params.limit}:${type}`;
}

export function createPropertySessionStore(): PropertySessionStore {
  const sessions = new Map<string, PropertySessionRecord>();
  const searchCache = new Map<string, CachedSearchEntry>();
  const avmCache = new Map<string, PropertyDetailRecord>();
  const inFlightMap = new Map<string, Promise<unknown>>();

  return {
    ensureSession(rawSessionId?: string): PropertySessionRecord {
      const sessionId =
        rawSessionId && /^[a-zA-Z0-9_-]{8,64}$/.test(rawSessionId.trim())
          ? rawSessionId.trim()
          : generateSessionId();

      const existing = sessions.get(sessionId);
      if (existing) {
        return existing;
      }

      const created: PropertySessionRecord = {
        sessionId,
        analysisArea: null,
        isSyntheticDemo: false,
        listingsById: new Map<string, PropertyListingSummary>(),
        detailsById: new Map<string, PropertyDetailRecord>(),
        fetchedAt: new Date().toISOString(),
      };
      sessions.set(sessionId, created);
      return created;
    },

    getSession(sessionId: string): PropertySessionRecord | null {
      return sessions.get(sessionId) ?? null;
    },

    recordSearchListings(params): PropertySessionRecord {
      const session = this.ensureSession(params.sessionId);
      session.analysisArea = params.analysisArea;
      session.isSyntheticDemo = params.isSyntheticDemo;
      session.fetchedAt = params.fetchedAt;

      for (const item of params.listings) {
        const existingDetail = session.detailsById.get(item.id);
        if (existingDetail) {
          session.listingsById.set(item.id, existingDetail);
        } else {
          session.listingsById.set(item.id, item);
        }
      }

      return session;
    },

    recordPropertyDetail(
      sessionId: string,
      detail: PropertyDetailRecord
    ): PropertyDetailRecord {
      const session = this.ensureSession(sessionId);
      session.detailsById.set(detail.id, detail);
      session.listingsById.set(detail.id, detail);
      return detail;
    },

    getResolvedSessionProperty(
      sessionId: string,
      propertyId: string
    ): ResolvedSessionPropertyLookup {
      const session = sessions.get(sessionId) ?? null;
      if (!session) {
        const cachedGlobalDetail =
          avmCache.get(`live:${propertyId}`) ??
          avmCache.get(`syn:${propertyId}`) ??
          null;
        return {
          session: null,
          listing: cachedGlobalDetail,
          detail: cachedGlobalDetail,
        };
      }

      const detail = session.detailsById.get(propertyId) ?? null;
      const listing = detail ?? session.listingsById.get(propertyId) ?? null;
      return {
        session,
        listing,
        detail,
      };
    },

    getCachedSearch(cacheKey: string): CachedSearchEntry | null {
      return searchCache.get(cacheKey) ?? null;
    },

    setCachedSearch(cacheKey: string, entry: CachedSearchEntry): void {
      searchCache.set(cacheKey, entry);
    },

    getCachedAvmDetail(propertyKey: string): PropertyDetailRecord | null {
      return avmCache.get(propertyKey) ?? null;
    },

    setCachedAvmDetail(propertyKey: string, detail: PropertyDetailRecord): void {
      avmCache.set(propertyKey, detail);
    },

    async coalesceInFlight<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const existing = inFlightMap.get(key) as Promise<T> | undefined;
      if (existing) {
        return existing;
      }
      const promise = fn().finally(() => {
        inFlightMap.delete(key);
      });
      inFlightMap.set(key, promise);
      return promise;
    },
  };
}
