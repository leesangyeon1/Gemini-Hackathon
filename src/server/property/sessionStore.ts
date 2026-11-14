/**
 * Server-Side Property Session, Durable Hydration, Cache & Request-Coalescing Store
 * (`src/server/property/sessionStore.ts`)
 *
 * Maintains server-verified property listings and on-demand AVM detail records
 * keyed by `(sessionId, propertyId)` with durable backing matching `config.budgetStoreMode`
 * (`'memory'`, `'sqlite'`, `'firestore'`) and a 24-hour session TTL so:
 * 1. Repeat clicks on an already-inspected property return cached AVM data with
 *    `0` additional provider calls.
 * 2. Concurrent duplicate clicks on the same property share a single in-flight promise.
 * 3. `POST /api/properties/:propertyId/avm`, `POST /api/sessions/:sessionId/expand`,
 *    and `POST /api/explain` resolve authoritative property valuations across process
 *    restarts, scale-to-zero cold starts, and Cloud Run revision rollouts without
 *    repeating paid RentCast calls.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
  AnalysisArea,
  BudgetStoreMode,
  PropertyDetailRecord,
  PropertyListingSummary,
} from '../../shared/types';

export const DEFAULT_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export interface PropertySessionRecord {
  readonly sessionId: string;
  analysisArea: AnalysisArea | null;
  isSyntheticDemo: boolean;
  readonly listingsById: Map<string, PropertyListingSummary>;
  readonly detailsById: Map<string, PropertyDetailRecord>;
  fetchedAt: string;
  createdAt: string;
  expiresAt: string;
}

export interface ResolvedSessionPropertyLookup {
  readonly sessionExists: boolean;
  readonly session: PropertySessionRecord | null;
  readonly listing: PropertyListingSummary | null;
  readonly detail: PropertyDetailRecord | null;
}

export interface CachedSearchEntry {
  readonly listings: PropertyListingSummary[];
  readonly isSyntheticDemo: boolean;
  readonly fetchedAt: string;
}

export interface PropertySessionStoreOptions {
  readonly mode?: BudgetStoreMode;
  readonly sqlitePath?: string;
  readonly googleCloudProject?: string | null;
  readonly firestoreSessionCollection?: string;
  readonly firestoreAccessTokenProvider?: () => Promise<string>;
  readonly fetchFn?: typeof fetch;
  readonly nowFn?: () => Date;
  readonly ttlMs?: number;
}

export interface RecordSearchListingsParams {
  readonly sessionId: string;
  readonly analysisArea: AnalysisArea;
  readonly listings: PropertyListingSummary[];
  readonly isSyntheticDemo: boolean;
  readonly fetchedAt: string;
}

export interface PropertySessionStore {
  readonly mode: BudgetStoreMode;
  ensureSession(sessionId?: string): PropertySessionRecord;
  getSession(sessionId: string): PropertySessionRecord | null;
  getSessionAsync(sessionId: string): Promise<PropertySessionRecord | null>;
  recordSearchListings(params: RecordSearchListingsParams): PropertySessionRecord;
  recordSearchListingsAsync(
    params: RecordSearchListingsParams
  ): Promise<PropertySessionRecord>;
  recordPropertyDetail(
    sessionId: string,
    detail: PropertyDetailRecord
  ): PropertyDetailRecord;
  recordPropertyDetailAsync(
    sessionId: string,
    detail: PropertyDetailRecord
  ): Promise<PropertyDetailRecord>;
  getResolvedSessionProperty(
    sessionId: string,
    propertyId: string
  ): ResolvedSessionPropertyLookup;
  getResolvedSessionPropertyAsync(
    sessionId: string,
    propertyId: string
  ): Promise<ResolvedSessionPropertyLookup>;
  getCachedSearch(cacheKey: string): CachedSearchEntry | null;
  setCachedSearch(cacheKey: string, entry: CachedSearchEntry): void;
  getCachedAvmDetail(propertyKey: string): PropertyDetailRecord | null;
  setCachedAvmDetail(propertyKey: string, detail: PropertyDetailRecord): void;
  coalesceInFlight<T>(key: string, fn: () => Promise<T>): Promise<T>;
  close(): void;
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

interface SqliteSessionRow {
  session_id: string;
  analysis_area_json: string | null;
  is_synthetic_demo: number;
  listings_json: string;
  details_json: string;
  fetched_at: string;
  created_at: string;
  expires_at: string;
}

interface FirestoreSessionDoc {
  name?: string;
  fields?: {
    sessionId?: { stringValue?: string };
    analysisAreaJson?: { stringValue?: string };
    isSyntheticDemo?: { booleanValue?: boolean };
    listingsJson?: { stringValue?: string };
    detailsJson?: { stringValue?: string };
    fetchedAt?: { stringValue?: string };
    createdAt?: { stringValue?: string };
    expiresAt?: { stringValue?: string };
  };
}

export function createPropertySessionStore(
  options: PropertySessionStoreOptions = {}
): PropertySessionStore {
  const mode: BudgetStoreMode = options.mode ?? 'memory';
  const nowFn = options.nowFn ?? (() => new Date());
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const ttlMs = Math.max(1_000, options.ttlMs ?? DEFAULT_SESSION_TTL_MS);

  const sessions = new Map<string, PropertySessionRecord>();
  const searchCache = new Map<string, CachedSearchEntry>();
  const avmCache = new Map<string, PropertyDetailRecord>();
  const inFlightMap = new Map<string, Promise<unknown>>();

  function computeExpiresAtIso(now: Date): string {
    return new Date(now.getTime() + ttlMs).toISOString();
  }

  function isExpiredIso(expiresAtIso: string | undefined): boolean {
    if (!expiresAtIso) {
      return false;
    }
    const parsedMs = Date.parse(expiresAtIso);
    if (!Number.isFinite(parsedMs)) {
      return false;
    }
    return parsedMs <= nowFn().getTime();
  }

  // ==========================================================================
  // SQLite Durable Session Backing (`mode === 'sqlite'`)
  // ==========================================================================
  let sqliteDb: DatabaseSync | null = null;
  const sqliteTarget = path.resolve(
    process.cwd(),
    options.sqlitePath ?? '.data/rentcast-budget.sqlite'
  );

  function ensureSqliteDb(): DatabaseSync | null {
    if (mode !== 'sqlite') {
      return null;
    }
    if (sqliteDb) {
      return sqliteDb;
    }
    try {
      fs.mkdirSync(path.dirname(sqliteTarget), { recursive: true });
      sqliteDb = new DatabaseSync(sqliteTarget);
      sqliteDb.exec(`
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA busy_timeout = 5000;

        CREATE TABLE IF NOT EXISTS foreal_property_sessions (
          session_id TEXT PRIMARY KEY,
          analysis_area_json TEXT,
          is_synthetic_demo INTEGER NOT NULL DEFAULT 0,
          listings_json TEXT NOT NULL DEFAULT '{}',
          details_json TEXT NOT NULL DEFAULT '{}',
          fetched_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL
        );
      `);
      return sqliteDb;
    } catch {
      return null;
    }
  }

  function persistSessionToSqliteSync(session: PropertySessionRecord): void {
    const db = ensureSqliteDb();
    if (!db) {
      return;
    }
    try {
      const listingsObj = Object.fromEntries(session.listingsById.entries());
      const detailsObj = Object.fromEntries(session.detailsById.entries());
      const areaJson = session.analysisArea
        ? JSON.stringify(session.analysisArea)
        : null;

      const stmt = db.prepare(`
        INSERT INTO foreal_property_sessions (
          session_id,
          analysis_area_json,
          is_synthetic_demo,
          listings_json,
          details_json,
          fetched_at,
          created_at,
          expires_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_id) DO UPDATE SET
          analysis_area_json = excluded.analysis_area_json,
          is_synthetic_demo = excluded.is_synthetic_demo,
          listings_json = excluded.listings_json,
          details_json = excluded.details_json,
          fetched_at = excluded.fetched_at,
          expires_at = excluded.expires_at
      `);
      stmt.run(
        session.sessionId,
        areaJson,
        session.isSyntheticDemo ? 1 : 0,
        JSON.stringify(listingsObj),
        JSON.stringify(detailsObj),
        session.fetchedAt,
        session.createdAt,
        session.expiresAt
      );
    } catch {
      // Non-fatal if SQLite write fails; in-memory session remains populated
    }
  }

  function deleteSessionFromSqliteSync(sessionId: string): void {
    const db = ensureSqliteDb();
    if (!db) {
      return;
    }
    try {
      const stmt = db.prepare(
        'DELETE FROM foreal_property_sessions WHERE session_id = ?'
      );
      stmt.run(sessionId);
    } catch {
      // Ignore cleanup errors
    }
  }

  function hydrateSessionFromSqliteSync(
    sessionId: string
  ): PropertySessionRecord | null {
    const db = ensureSqliteDb();
    if (!db) {
      return null;
    }
    try {
      const stmt = db.prepare(`
        SELECT
          session_id,
          analysis_area_json,
          is_synthetic_demo,
          listings_json,
          details_json,
          fetched_at,
          created_at,
          expires_at
        FROM foreal_property_sessions
        WHERE session_id = ?
      `);
      const row = stmt.get(sessionId) as SqliteSessionRow | undefined;
      if (!row) {
        return null;
      }

      if (isExpiredIso(row.expires_at)) {
        deleteSessionFromSqliteSync(sessionId);
        return null;
      }

      const analysisArea = row.analysis_area_json
        ? (JSON.parse(row.analysis_area_json) as AnalysisArea)
        : null;
      const rawListings = JSON.parse(row.listings_json || '{}') as Record<
        string,
        PropertyListingSummary
      >;
      const rawDetails = JSON.parse(row.details_json || '{}') as Record<
        string,
        PropertyDetailRecord
      >;

      const listingsById = new Map<string, PropertyListingSummary>(
        Object.entries(rawListings)
      );
      const detailsById = new Map<string, PropertyDetailRecord>(
        Object.entries(rawDetails)
      );
      for (const [id, detail] of detailsById.entries()) {
        listingsById.set(id, detail);
        const cachePrefix =
          detail.dataProvenance === 'synthetic_demo' || Boolean(row.is_synthetic_demo)
            ? 'syn'
            : 'live';
        avmCache.set(`${cachePrefix}:${id}`, detail);
      }

      const hydrated: PropertySessionRecord = {
        sessionId: row.session_id,
        analysisArea,
        isSyntheticDemo: Boolean(row.is_synthetic_demo),
        listingsById,
        detailsById,
        fetchedAt: row.fetched_at,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
      };
      sessions.set(sessionId, hydrated);
      return hydrated;
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // Firestore Durable Session Backing (`mode === 'firestore'`)
  // ==========================================================================
  const projectId = options.googleCloudProject?.trim() ?? '';
  const firestoreCollection =
    options.firestoreSessionCollection?.trim() || 'foreal_sessions';
  let cachedAccessToken: string | null = null;
  let cachedTokenExpiresAtMs = 0;

  async function resolveFirestoreToken(): Promise<string> {
    if (options.firestoreAccessTokenProvider) {
      return options.firestoreAccessTokenProvider();
    }
    const envToken = process.env.GOOGLE_OAUTH_ACCESS_TOKEN?.trim();
    if (envToken) {
      return envToken;
    }
    const nowMs = nowFn().getTime();
    if (cachedAccessToken && nowMs < cachedTokenExpiresAtMs) {
      return cachedAccessToken;
    }
    const resp = await fetchFn(
      'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',
      {
        headers: { 'Metadata-Flavor': 'Google' },
        signal: AbortSignal.timeout(3_000),
      }
    );
    if (!resp.ok) {
      throw new Error(`Metadata server token fetch failed with HTTP ${resp.status}`);
    }
    const data = (await resp.json()) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!data.access_token) {
      throw new Error('Metadata server response did not contain access_token');
    }
    const ttlSeconds = Number.isFinite(data.expires_in)
      ? Number(data.expires_in)
      : 300;
    cachedAccessToken = data.access_token;
    cachedTokenExpiresAtMs = nowMs + Math.max(0, (ttlSeconds - 60) * 1000);
    return data.access_token;
  }

  function buildFirestoreSessionDocUrl(sessionId: string): string {
    return `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      projectId
    )}/databases/(default)/documents/${encodeURIComponent(
      firestoreCollection
    )}/${encodeURIComponent(sessionId)}`;
  }

  async function persistSessionToFirestoreAsync(
    session: PropertySessionRecord
  ): Promise<void> {
    if (mode !== 'firestore' || !projectId) {
      return;
    }
    try {
      const token = await resolveFirestoreToken();
      const docUrl = buildFirestoreSessionDocUrl(session.sessionId);
      const listingsObj = Object.fromEntries(session.listingsById.entries());
      const detailsObj = Object.fromEntries(session.detailsById.entries());

      const body: FirestoreSessionDoc = {
        fields: {
          sessionId: { stringValue: session.sessionId },
          analysisAreaJson: {
            stringValue: session.analysisArea
              ? JSON.stringify(session.analysisArea)
              : '',
          },
          isSyntheticDemo: { booleanValue: session.isSyntheticDemo },
          listingsJson: { stringValue: JSON.stringify(listingsObj) },
          detailsJson: { stringValue: JSON.stringify(detailsObj) },
          fetchedAt: { stringValue: session.fetchedAt },
          createdAt: { stringValue: session.createdAt },
          expiresAt: { stringValue: session.expiresAt },
        },
      };

      await fetchFn(docUrl, {
        method: 'PATCH',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // Non-fatal: in-memory session remains populated on current instance
    }
  }

  async function hydrateSessionFromFirestoreAsync(
    sessionId: string
  ): Promise<PropertySessionRecord | null> {
    if (mode !== 'firestore' || !projectId) {
      return null;
    }
    try {
      const token = await resolveFirestoreToken();
      const docUrl = buildFirestoreSessionDocUrl(sessionId);
      const resp = await fetchFn(docUrl, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(5_000),
      });

      if (resp.status === 404 || !resp.ok) {
        return null;
      }

      const doc = (await resp.json()) as FirestoreSessionDoc;
      const f = doc?.fields;
      if (!f) {
        return null;
      }

      const expiresAt = f.expiresAt?.stringValue ?? '';
      if (expiresAt && isExpiredIso(expiresAt)) {
        return null;
      }

      const areaStr = f.analysisAreaJson?.stringValue ?? '';
      const analysisArea = areaStr
        ? (JSON.parse(areaStr) as AnalysisArea)
        : null;
      const isSyntheticDemo = Boolean(f.isSyntheticDemo?.booleanValue);
      const rawListings = JSON.parse(
        f.listingsJson?.stringValue || '{}'
      ) as Record<string, PropertyListingSummary>;
      const rawDetails = JSON.parse(
        f.detailsJson?.stringValue || '{}'
      ) as Record<string, PropertyDetailRecord>;

      const listingsById = new Map<string, PropertyListingSummary>(
        Object.entries(rawListings)
      );
      const detailsById = new Map<string, PropertyDetailRecord>(
        Object.entries(rawDetails)
      );
      for (const [id, detail] of detailsById.entries()) {
        listingsById.set(id, detail);
        const cachePrefix =
          detail.dataProvenance === 'synthetic_demo' || isSyntheticDemo
            ? 'syn'
            : 'live';
        avmCache.set(`${cachePrefix}:${id}`, detail);
      }

      const nowIso = nowFn().toISOString();
      const hydrated: PropertySessionRecord = {
        sessionId: f.sessionId?.stringValue || sessionId,
        analysisArea,
        isSyntheticDemo,
        listingsById,
        detailsById,
        fetchedAt: f.fetchedAt?.stringValue || nowIso,
        createdAt: f.createdAt?.stringValue || nowIso,
        expiresAt: expiresAt || computeExpiresAtIso(nowFn()),
      };
      sessions.set(sessionId, hydrated);
      return hydrated;
    } catch {
      return null;
    }
  }

  function getActiveMemoryOrSqliteSessionSync(
    sessionId: string
  ): PropertySessionRecord | null {
    const inMem = sessions.get(sessionId);
    if (inMem) {
      if (isExpiredIso(inMem.expiresAt)) {
        sessions.delete(sessionId);
        if (mode === 'sqlite') {
          deleteSessionFromSqliteSync(sessionId);
        }
        return null;
      }
      return inMem;
    }
    if (mode === 'sqlite') {
      return hydrateSessionFromSqliteSync(sessionId);
    }
    return null;
  }

  async function getActiveSessionAsync(
    sessionId: string
  ): Promise<PropertySessionRecord | null> {
    const syncFound = getActiveMemoryOrSqliteSessionSync(sessionId);
    if (syncFound) {
      return syncFound;
    }
    if (mode === 'firestore') {
      return hydrateSessionFromFirestoreAsync(sessionId);
    }
    return null;
  }

  return {
    mode,

    ensureSession(rawSessionId?: string): PropertySessionRecord {
      const sessionId =
        rawSessionId && /^[a-zA-Z0-9_-]{8,64}$/.test(rawSessionId.trim())
          ? rawSessionId.trim()
          : generateSessionId();

      const existing = getActiveMemoryOrSqliteSessionSync(sessionId);
      if (existing) {
        return existing;
      }

      const now = nowFn();
      const nowIso = now.toISOString();
      const created: PropertySessionRecord = {
        sessionId,
        analysisArea: null,
        isSyntheticDemo: false,
        listingsById: new Map<string, PropertyListingSummary>(),
        detailsById: new Map<string, PropertyDetailRecord>(),
        fetchedAt: nowIso,
        createdAt: nowIso,
        expiresAt: computeExpiresAtIso(now),
      };
      sessions.set(sessionId, created);
      return created;
    },

    getSession(sessionId: string): PropertySessionRecord | null {
      return getActiveMemoryOrSqliteSessionSync(sessionId);
    },

    async getSessionAsync(
      sessionId: string
    ): Promise<PropertySessionRecord | null> {
      return getActiveSessionAsync(sessionId);
    },

    recordSearchListings(
      params: RecordSearchListingsParams
    ): PropertySessionRecord {
      const session = this.ensureSession(params.sessionId);
      const now = nowFn();
      session.analysisArea = params.analysisArea;
      session.isSyntheticDemo = params.isSyntheticDemo;
      session.fetchedAt = params.fetchedAt;
      session.expiresAt = computeExpiresAtIso(now);

      for (const item of params.listings) {
        const existingDetail = session.detailsById.get(item.id);
        if (existingDetail) {
          session.listingsById.set(item.id, existingDetail);
        } else {
          session.listingsById.set(item.id, item);
        }
      }

      if (mode === 'sqlite') {
        persistSessionToSqliteSync(session);
      } else if (mode === 'firestore') {
        void persistSessionToFirestoreAsync(session);
      }

      return session;
    },

    async recordSearchListingsAsync(
      params: RecordSearchListingsParams
    ): Promise<PropertySessionRecord> {
      if (mode === 'firestore' && !sessions.has(params.sessionId)) {
        await hydrateSessionFromFirestoreAsync(params.sessionId);
      }
      const session = this.ensureSession(params.sessionId);
      const now = nowFn();
      session.analysisArea = params.analysisArea;
      session.isSyntheticDemo = params.isSyntheticDemo;
      session.fetchedAt = params.fetchedAt;
      session.expiresAt = computeExpiresAtIso(now);

      for (const item of params.listings) {
        const existingDetail = session.detailsById.get(item.id);
        if (existingDetail) {
          session.listingsById.set(item.id, existingDetail);
        } else {
          session.listingsById.set(item.id, item);
        }
      }

      if (mode === 'sqlite') {
        persistSessionToSqliteSync(session);
      } else if (mode === 'firestore') {
        await persistSessionToFirestoreAsync(session);
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
      session.expiresAt = computeExpiresAtIso(nowFn());

      if (mode === 'sqlite') {
        persistSessionToSqliteSync(session);
      } else if (mode === 'firestore') {
        void persistSessionToFirestoreAsync(session);
      }

      return detail;
    },

    async recordPropertyDetailAsync(
      sessionId: string,
      detail: PropertyDetailRecord
    ): Promise<PropertyDetailRecord> {
      if (mode === 'firestore' && !sessions.has(sessionId)) {
        await hydrateSessionFromFirestoreAsync(sessionId);
      }
      const session = this.ensureSession(sessionId);
      session.detailsById.set(detail.id, detail);
      session.listingsById.set(detail.id, detail);
      session.expiresAt = computeExpiresAtIso(nowFn());

      if (mode === 'sqlite') {
        persistSessionToSqliteSync(session);
      } else if (mode === 'firestore') {
        await persistSessionToFirestoreAsync(session);
      }

      return detail;
    },

    getResolvedSessionProperty(
      sessionId: string,
      propertyId: string
    ): ResolvedSessionPropertyLookup {
      const session = getActiveMemoryOrSqliteSessionSync(sessionId);
      if (!session) {
        return {
          sessionExists: false,
          session: null,
          listing: null,
          detail: null,
        };
      }

      const detail = session.detailsById.get(propertyId) ?? null;
      const listing = detail ?? session.listingsById.get(propertyId) ?? null;
      return {
        sessionExists: true,
        session,
        listing,
        detail,
      };
    },

    async getResolvedSessionPropertyAsync(
      sessionId: string,
      propertyId: string
    ): Promise<ResolvedSessionPropertyLookup> {
      const session = await getActiveSessionAsync(sessionId);
      if (!session) {
        return {
          sessionExists: false,
          session: null,
          listing: null,
          detail: null,
        };
      }

      const detail = session.detailsById.get(propertyId) ?? null;
      const listing = detail ?? session.listingsById.get(propertyId) ?? null;
      return {
        sessionExists: true,
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

    close(): void {
      if (sqliteDb) {
        try {
          sqliteDb.close();
        } catch {
          // Ignore close errors
        }
        sqliteDb = null;
      }
    },
  };
}
