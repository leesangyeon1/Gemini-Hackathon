/**
 * Durable Atomic RentCast Budget & Session Quota Store (`src/server/property/budgetStore.ts`)
 *
 * Enforces:
 * - Hard monthly account cap `RENTCAST_GLOBAL_MONTHLY_LIMIT < 50` (default `35`)
 * - Pre-existing account usage offset `RENTCAST_INITIAL_SPENT_CALLS` (default `0`)
 * - Bounded session caps:
 *   - Default session: `1` listings call (`<= 25` homes) + `<= 5` selected-home AVM calls = `6` calls max
 *   - Explicitly expanded session (`userConfirmed: true`): up to `10` total AVM calls + `1` optional
 *     `/v1/properties` record call = `12` calls max
 * - Per-client sliding-window rate limiting and upstream concurrency semaphore
 * - Durable persistence across container/process restarts via:
 *   - `sqlite`: Node.js v24 built-in `node:sqlite` (`DatabaseSync` with `BEGIN IMMEDIATE` atomic transactions)
 *   - `firestore`: Google Cloud Firestore REST atomic transactions (multi-instance Cloud Run)
 *   - `memory`: Isolated in-memory mode for unit testing
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RENTCAST_BUDGET_DEFAULTS } from '../../shared/constants';
import type { ApiErrorCode, BudgetSnapshot, BudgetStoreMode, UiState } from '../../shared/types';

export type BudgetReservationKind = 'listings' | 'avm' | 'property_record';

export class BudgetStoreError extends Error {
  public readonly code: ApiErrorCode;
  public readonly statusCode: number;
  public readonly uiState: UiState;
  public readonly retryable: boolean;
  public readonly snapshot: BudgetSnapshot | null;

  constructor(options: {
    code: ApiErrorCode;
    message: string;
    statusCode: number;
    uiState: UiState;
    retryable: boolean;
    snapshot?: BudgetSnapshot | null;
  }) {
    super(options.message);
    this.name = 'BudgetStoreError';
    this.code = options.code;
    this.statusCode = options.statusCode;
    this.uiState = options.uiState;
    this.retryable = options.retryable;
    this.snapshot = options.snapshot ?? null;
  }
}

export interface SessionUsageRow {
  sessionId: string;
  billingMonth: string;
  listingsUsed: number;
  avmsUsed: number;
  propertyRecordsUsed: number;
  expanded: boolean;
}

export interface BudgetStoreOptions {
  readonly mode?: BudgetStoreMode | 'memory';
  readonly reportedDurabilityMode?: BudgetStoreMode;
  readonly globalMonthlyLimit?: number;
  readonly initialSpentCalls?: number;
  readonly sqlitePath?: string;
  readonly googleCloudProject?: string | null;
  readonly firestoreCollection?: string;
  readonly firestoreAccessTokenProvider?: () => Promise<string>;
  readonly fetchFn?: typeof fetch;
  readonly nowFn?: () => Date;
  readonly maxClientCallsPerWindow?: number;
  readonly clientWindowMs?: number;
  readonly maxConcurrentUpstreamCalls?: number;
}

export interface BudgetStore {
  readonly mode: BudgetStoreMode | 'memory';
  readonly reportedDurabilityMode: BudgetStoreMode;
  getSnapshot(sessionId?: string | null): Promise<BudgetSnapshot>;
  reserveCall(
    kind: BudgetReservationKind,
    sessionId: string,
    clientKey?: string
  ): Promise<BudgetSnapshot>;
  reserveListingsCall(sessionId: string, clientKey?: string): Promise<BudgetSnapshot>;
  reserveAvmCall(sessionId: string, clientKey?: string): Promise<BudgetSnapshot>;
  reservePropertyRecordCall(sessionId: string, clientKey?: string): Promise<BudgetSnapshot>;
  expandSession(sessionId: string, userConfirmed: boolean): Promise<BudgetSnapshot>;
  withConcurrencySlot<T>(fn: () => Promise<T>): Promise<T>;
  close(): void;
}

function formatBillingMonth(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

function clampMonthlyLimit(rawLimit: number | undefined): number {
  if (rawLimit === undefined || !Number.isFinite(rawLimit)) {
    return RENTCAST_BUDGET_DEFAULTS.defaultGlobalMonthlyLimit;
  }
  return Math.max(
    1,
    Math.min(RENTCAST_BUDGET_DEFAULTS.maxConfigurableMonthlyLimit, Math.floor(rawLimit))
  );
}

function clampInitialSpent(rawInitial: number | undefined): number {
  if (rawInitial === undefined || !Number.isFinite(rawInitial)) {
    return RENTCAST_BUDGET_DEFAULTS.defaultInitialSpentCalls;
  }
  return Math.max(0, Math.floor(rawInitial));
}

function buildSnapshotFromCounters(params: {
  billingMonth: string;
  globalMonthlyLimit: number;
  initialSpentCalls: number;
  runtimeSpentCalls: number;
  session: SessionUsageRow | null;
  durabilityMode: BudgetStoreMode;
}): BudgetSnapshot {
  const totalSpentCalls = params.initialSpentCalls + params.runtimeSpentCalls;
  const globalRemaining = Math.max(0, params.globalMonthlyLimit - totalSpentCalls);
  const expanded = params.session?.expanded ?? false;

  const sessionListingsLimit = RENTCAST_BUDGET_DEFAULTS.defaultSessionListingsLimit;
  const sessionAvmsLimit = expanded
    ? RENTCAST_BUDGET_DEFAULTS.expandedSessionAvmsLimit
    : RENTCAST_BUDGET_DEFAULTS.defaultSessionAvmsLimit;
  const sessionPropertyRecordsLimit = expanded
    ? RENTCAST_BUDGET_DEFAULTS.expandedSessionPropertyRecordsLimit
    : RENTCAST_BUDGET_DEFAULTS.defaultSessionPropertyRecordsLimit;

  return {
    billingMonth: params.billingMonth,
    globalMonthlyLimit: params.globalMonthlyLimit,
    initialSpentCalls: params.initialSpentCalls,
    runtimeSpentCalls: params.runtimeSpentCalls,
    totalSpentCalls,
    globalRemaining,
    sessionId: params.session?.sessionId ?? null,
    sessionListingsUsed: params.session?.listingsUsed ?? 0,
    sessionListingsLimit,
    sessionAvmsUsed: params.session?.avmsUsed ?? 0,
    sessionAvmsLimit,
    sessionPropertyRecordsUsed: params.session?.propertyRecordsUsed ?? 0,
    sessionPropertyRecordsLimit,
    sessionExpanded: expanded,
    durabilityMode: params.durabilityMode,
    quotaExhausted: globalRemaining <= 0,
  };
}

function validateReservationAgainstCaps(
  kind: BudgetReservationKind,
  snapshot: BudgetSnapshot
): void {
  if (snapshot.globalRemaining <= 0 || snapshot.totalSpentCalls >= snapshot.globalMonthlyLimit) {
    throw new BudgetStoreError({
      code: 'GLOBAL_QUOTA_EXHAUSTED',
      message: `Global monthly RentCast budget cap (${snapshot.globalMonthlyLimit} calls; < 50 free-tier limit) has been reached for ${snapshot.billingMonth}. Cached results and opt-in Synthetic Demo mode remain available.`,
      statusCode: 429,
      uiState: 'quota_exhausted',
      retryable: false,
      snapshot: { ...snapshot, quotaExhausted: true },
    });
  }

  if (kind === 'listings' && snapshot.sessionListingsUsed >= snapshot.sessionListingsLimit) {
    throw new BudgetStoreError({
      code: 'SESSION_CAP_REACHED',
      message: `Session listings search cap (${snapshot.sessionListingsLimit} search of <= 25 homes per session) reached for session "${snapshot.sessionId}". Start a new session or inspect loaded homes.`,
      statusCode: 429,
      uiState: 'quota_exhausted',
      retryable: false,
      snapshot,
    });
  }

  if (kind === 'avm' && snapshot.sessionAvmsUsed >= snapshot.sessionAvmsLimit) {
    const canExpand = !snapshot.sessionExpanded;
    throw new BudgetStoreError({
      code: 'SESSION_CAP_REACHED',
      message: canExpand
        ? `Default session AVM cap (${snapshot.sessionAvmsLimit} selected homes) reached. Explicitly confirm session expansion (/api/sessions/${snapshot.sessionId}/expand) to allow up to ${RENTCAST_BUDGET_DEFAULTS.expandedSessionAvmsLimit} AVM comparisons.`
        : `Expanded session AVM cap (${snapshot.sessionAvmsLimit} selected homes) reached for session "${snapshot.sessionId}".`,
      statusCode: 429,
      uiState: 'quota_exhausted',
      retryable: canExpand,
      snapshot,
    });
  }

  if (
    kind === 'property_record' &&
    snapshot.sessionPropertyRecordsUsed >= snapshot.sessionPropertyRecordsLimit
  ) {
    const canExpand = !snapshot.sessionExpanded;
    throw new BudgetStoreError({
      code: 'SESSION_CAP_REACHED',
      message: canExpand
        ? 'Optional property-record / recent-sales lookup requires explicit session expansion (/api/sessions/:sessionId/expand).'
        : `Expanded session property-record lookup cap (${snapshot.sessionPropertyRecordsLimit} call) reached for session "${snapshot.sessionId}".`,
      statusCode: 429,
      uiState: 'quota_exhausted',
      retryable: canExpand,
      snapshot,
    });
  }
}

export function createBudgetStore(options: BudgetStoreOptions = {}): BudgetStore {
  const mode: BudgetStoreMode | 'memory' = options.mode ?? 'sqlite';
  const reportedDurabilityMode: BudgetStoreMode =
    options.reportedDurabilityMode ?? (mode === 'firestore' ? 'firestore' : 'sqlite');
  const globalMonthlyLimit = clampMonthlyLimit(options.globalMonthlyLimit);
  const initialSpentCalls = clampInitialSpent(options.initialSpentCalls);
  const nowFn = options.nowFn ?? (() => new Date());
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  const maxClientCallsPerWindow = Math.max(1, options.maxClientCallsPerWindow ?? 24);
  const clientWindowMs = Math.max(1_000, options.clientWindowMs ?? 60_000);
  const maxConcurrentUpstreamCalls = Math.max(1, options.maxConcurrentUpstreamCalls ?? 2);

  // Per-client sliding window timestamps
  const clientCallTimestamps = new Map<string, number[]>();

  function checkAndRecordClientRateLimit(
    clientKey: string | undefined,
    currentSnapshot: BudgetSnapshot
  ): void {
    const key = (clientKey ?? 'default_client').trim() || 'default_client';
    const nowMs = nowFn().getTime();
    const cutoff = nowMs - clientWindowMs;
    const recent = (clientCallTimestamps.get(key) ?? []).filter((ts) => ts > cutoff);

    if (recent.length >= maxClientCallsPerWindow) {
      throw new BudgetStoreError({
        code: 'RATE_LIMITED',
        message: `Per-client rate limit exceeded (${maxClientCallsPerWindow} RentCast calls per ${Math.round(
          clientWindowMs / 1000
        )}s window). Please wait before issuing additional live provider requests.`,
        statusCode: 429,
        uiState: 'recovery',
        retryable: true,
        snapshot: currentSnapshot,
      });
    }

    recent.push(nowMs);
    clientCallTimestamps.set(key, recent);
  }

  // Concurrency semaphore queue
  let activeConcurrentCalls = 0;
  const waitQueue: Array<() => void> = [];

  async function withConcurrencySlot<T>(fn: () => Promise<T>): Promise<T> {
    if (activeConcurrentCalls >= maxConcurrentUpstreamCalls) {
      await new Promise<void>((resolve) => {
        waitQueue.push(resolve);
      });
    }
    activeConcurrentCalls += 1;
    try {
      return await fn();
    } finally {
      activeConcurrentCalls = Math.max(0, activeConcurrentCalls - 1);
      const next = waitQueue.shift();
      if (next) {
        next();
      }
    }
  }

  // ==========================================================================
  // Backing Store 1: SQLite (`node:sqlite` DatabaseSync) or In-Memory SQLite
  // ==========================================================================
  if (mode === 'sqlite' || mode === 'memory') {
    let db: DatabaseSync | null = null;
    const sqliteTarget =
      mode === 'memory'
        ? ':memory:'
        : path.resolve(
            process.cwd(),
            options.sqlitePath ?? '.data/rentcast-budget.sqlite'
          );

    function ensureDb(): DatabaseSync {
      if (db) {
        return db;
      }
      try {
        if (sqliteTarget !== ':memory:') {
          fs.mkdirSync(path.dirname(sqliteTarget), { recursive: true });
        }
        db = new DatabaseSync(sqliteTarget);
        db.exec(`
          PRAGMA journal_mode = WAL;
          PRAGMA busy_timeout = 5000;
          CREATE TABLE IF NOT EXISTS rentcast_monthly_budget (
            billing_month TEXT PRIMARY KEY,
            runtime_spent_calls INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS rentcast_session_budget (
            session_id TEXT PRIMARY KEY,
            billing_month TEXT NOT NULL,
            listings_used INTEGER NOT NULL DEFAULT 0,
            avms_used INTEGER NOT NULL DEFAULT 0,
            property_records_used INTEGER NOT NULL DEFAULT 0,
            expanded INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL
          );
        `);
        return db;
      } catch (err) {
        throw new BudgetStoreError({
          code: 'BUDGET_STORE_UNAVAILABLE',
          message: `Durable SQLite budget store failed closed: ${
            err instanceof Error ? err.message : 'database initialization error'
          }`,
          statusCode: 503,
          uiState: 'quota_exhausted',
          retryable: true,
        });
      }
    }

    function readStateSync(
      database: DatabaseSync,
      billingMonth: string,
      sessionId?: string | null
    ): { runtimeSpentCalls: number; session: SessionUsageRow | null } {
      const monthStmt = database.prepare(
        'SELECT runtime_spent_calls FROM rentcast_monthly_budget WHERE billing_month = ?'
      );
      const monthRow = monthStmt.get(billingMonth) as
        | { runtime_spent_calls: number }
        | undefined;
      const runtimeSpentCalls = monthRow ? Number(monthRow.runtime_spent_calls) : 0;

      let session: SessionUsageRow | null = null;
      if (sessionId) {
        const sessStmt = database.prepare(
          `SELECT session_id, billing_month, listings_used, avms_used, property_records_used, expanded
           FROM rentcast_session_budget WHERE session_id = ?`
        );
        const sessRow = sessStmt.get(sessionId) as
          | {
              session_id: string;
              billing_month: string;
              listings_used: number;
              avms_used: number;
              property_records_used: number;
              expanded: number;
            }
          | undefined;

        if (sessRow && sessRow.billing_month === billingMonth) {
          session = {
            sessionId: sessRow.session_id,
            billingMonth: sessRow.billing_month,
            listingsUsed: Number(sessRow.listings_used),
            avmsUsed: Number(sessRow.avms_used),
            propertyRecordsUsed: Number(sessRow.property_records_used),
            expanded: Boolean(sessRow.expanded),
          };
        } else {
          session = {
            sessionId,
            billingMonth,
            listingsUsed: 0,
            avmsUsed: 0,
            propertyRecordsUsed: 0,
            expanded: false,
          };
        }
      }

      return { runtimeSpentCalls, session };
    }

    return {
      mode,
      reportedDurabilityMode,

      async getSnapshot(sessionId?: string | null): Promise<BudgetSnapshot> {
        const database = ensureDb();
        const billingMonth = formatBillingMonth(nowFn());
        const state = readStateSync(database, billingMonth, sessionId);
        return buildSnapshotFromCounters({
          billingMonth,
          globalMonthlyLimit,
          initialSpentCalls,
          runtimeSpentCalls: state.runtimeSpentCalls,
          session: state.session,
          durabilityMode: reportedDurabilityMode,
        });
      },

      async reserveCall(
        kind: BudgetReservationKind,
        sessionId: string,
        clientKey?: string
      ): Promise<BudgetSnapshot> {
        const database = ensureDb();
        const now = nowFn();
        const billingMonth = formatBillingMonth(now);
        const nowIso = now.toISOString();

        database.exec('BEGIN IMMEDIATE');
        try {
          const state = readStateSync(database, billingMonth, sessionId);
          const preSnapshot = buildSnapshotFromCounters({
            billingMonth,
            globalMonthlyLimit,
            initialSpentCalls,
            runtimeSpentCalls: state.runtimeSpentCalls,
            session: state.session,
            durabilityMode: reportedDurabilityMode,
          });

          // 1. Validate session & global caps first
          validateReservationAgainstCaps(kind, preSnapshot);

          // 2. Check per-client rate window
          checkAndRecordClientRateLimit(clientKey, preSnapshot);

          // 3. Atomically increment monthly counter and session counter
          const nextRuntimeSpent = state.runtimeSpentCalls + 1;
          const currentSession = state.session ?? {
            sessionId,
            billingMonth,
            listingsUsed: 0,
            avmsUsed: 0,
            propertyRecordsUsed: 0,
            expanded: false,
          };

          const nextSession: SessionUsageRow = {
            ...currentSession,
            listingsUsed:
              currentSession.listingsUsed + (kind === 'listings' ? 1 : 0),
            avmsUsed: currentSession.avmsUsed + (kind === 'avm' ? 1 : 0),
            propertyRecordsUsed:
              currentSession.propertyRecordsUsed +
              (kind === 'property_record' ? 1 : 0),
          };

          const upsertMonth = database.prepare(`
            INSERT INTO rentcast_monthly_budget (billing_month, runtime_spent_calls, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(billing_month) DO UPDATE SET
              runtime_spent_calls = excluded.runtime_spent_calls,
              updated_at = excluded.updated_at
          `);
          upsertMonth.run(billingMonth, nextRuntimeSpent, nowIso);

          const upsertSession = database.prepare(`
            INSERT INTO rentcast_session_budget (
              session_id, billing_month, listings_used, avms_used, property_records_used, expanded, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              billing_month = excluded.billing_month,
              listings_used = excluded.listings_used,
              avms_used = excluded.avms_used,
              property_records_used = excluded.property_records_used,
              expanded = excluded.expanded,
              updated_at = excluded.updated_at
          `);
          upsertSession.run(
            sessionId,
            billingMonth,
            nextSession.listingsUsed,
            nextSession.avmsUsed,
            nextSession.propertyRecordsUsed,
            nextSession.expanded ? 1 : 0,
            nowIso
          );

          database.exec('COMMIT');

          return buildSnapshotFromCounters({
            billingMonth,
            globalMonthlyLimit,
            initialSpentCalls,
            runtimeSpentCalls: nextRuntimeSpent,
            session: nextSession,
            durabilityMode: reportedDurabilityMode,
          });
        } catch (err) {
          try {
            database.exec('ROLLBACK');
          } catch {
            // Ignore rollback error if transaction already closed
          }
          if (err instanceof BudgetStoreError) {
            throw err;
          }
          throw new BudgetStoreError({
            code: 'BUDGET_STORE_UNAVAILABLE',
            message: `Durable SQLite budget reservation failed closed: ${
              err instanceof Error ? err.message : 'transaction failure'
            }`,
            statusCode: 503,
            uiState: 'quota_exhausted',
            retryable: true,
          });
        }
      },

      async reserveListingsCall(sessionId: string, clientKey?: string): Promise<BudgetSnapshot> {
        return this.reserveCall('listings', sessionId, clientKey);
      },

      async reserveAvmCall(sessionId: string, clientKey?: string): Promise<BudgetSnapshot> {
        return this.reserveCall('avm', sessionId, clientKey);
      },

      async reservePropertyRecordCall(
        sessionId: string,
        clientKey?: string
      ): Promise<BudgetSnapshot> {
        return this.reserveCall('property_record', sessionId, clientKey);
      },

      async expandSession(sessionId: string, userConfirmed: boolean): Promise<BudgetSnapshot> {
        if (userConfirmed !== true) {
          throw new BudgetStoreError({
            code: 'VALIDATION_ERROR',
            message: 'Explicit user confirmation (userConfirmed: true) is required to expand session budget.',
            statusCode: 400,
            uiState: 'recovery',
            retryable: false,
          });
        }

        const database = ensureDb();
        const now = nowFn();
        const billingMonth = formatBillingMonth(now);
        const nowIso = now.toISOString();

        database.exec('BEGIN IMMEDIATE');
        try {
          const state = readStateSync(database, billingMonth, sessionId);
          const currentSession = state.session ?? {
            sessionId,
            billingMonth,
            listingsUsed: 0,
            avmsUsed: 0,
            propertyRecordsUsed: 0,
            expanded: false,
          };

          const expandedSession: SessionUsageRow = {
            ...currentSession,
            expanded: true,
          };

          const upsertSession = database.prepare(`
            INSERT INTO rentcast_session_budget (
              session_id, billing_month, listings_used, avms_used, property_records_used, expanded, updated_at
            )
            VALUES (?, ?, ?, ?, ?, 1, ?)
            ON CONFLICT(session_id) DO UPDATE SET
              billing_month = excluded.billing_month,
              expanded = 1,
              updated_at = excluded.updated_at
          `);
          upsertSession.run(
            sessionId,
            billingMonth,
            expandedSession.listingsUsed,
            expandedSession.avmsUsed,
            expandedSession.propertyRecordsUsed,
            nowIso
          );

          database.exec('COMMIT');

          return buildSnapshotFromCounters({
            billingMonth,
            globalMonthlyLimit,
            initialSpentCalls,
            runtimeSpentCalls: state.runtimeSpentCalls,
            session: expandedSession,
            durabilityMode: reportedDurabilityMode,
          });
        } catch (err) {
          try {
            database.exec('ROLLBACK');
          } catch {
            // Ignore rollback error
          }
          if (err instanceof BudgetStoreError) {
            throw err;
          }
          throw new BudgetStoreError({
            code: 'BUDGET_STORE_UNAVAILABLE',
            message: `Failed to expand session in durable SQLite store: ${
              err instanceof Error ? err.message : 'transaction failure'
            }`,
            statusCode: 503,
            uiState: 'quota_exhausted',
            retryable: true,
          });
        }
      },

      withConcurrencySlot,

      close(): void {
        if (db) {
          try {
            db.close();
          } catch {
            // Ignore close errors
          }
          db = null;
        }
      },
    };
  }

  // ==========================================================================
  // Backing Store 2: Google Cloud Firestore REST Atomic Transactions (`firestore`)
  // ==========================================================================
  const projectId = options.googleCloudProject?.trim() ?? '';
  const collectionName = options.firestoreCollection?.trim() || 'rentcast_budget';
  const MAX_FIRESTORE_COMMIT_ATTEMPTS = 4;

  let cachedAccessToken: string | null = null;
  let cachedTokenExpiresAtMs = 0;

  // In-process async mutex so concurrent calls within a single Cloud Run instance
  // serialize cleanly before hitting Firestore optimistic concurrency preconditions.
  let firestoreMutexChain: Promise<void> = Promise.resolve();
  async function withFirestoreLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prevLock = firestoreMutexChain;
    firestoreMutexChain = prevLock.then(() => nextLock);
    await prevLock;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  class FirestorePreconditionConflictError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'FirestorePreconditionConflictError';
      this.status = status;
    }
  }

  async function resolveFirestoreToken(forceRefresh = false): Promise<string> {
    if (options.firestoreAccessTokenProvider) {
      return options.firestoreAccessTokenProvider();
    }
    const envToken = process.env.GOOGLE_OAUTH_ACCESS_TOKEN?.trim();
    if (envToken) {
      return envToken;
    }
    const nowMs = nowFn().getTime();
    if (!forceRefresh && cachedAccessToken && nowMs < cachedTokenExpiresAtMs) {
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
    const data = (await resp.json()) as { access_token?: string; expires_in?: number };
    if (!data.access_token) {
      throw new Error('Metadata server response did not contain access_token');
    }
    const ttlSeconds = Number.isFinite(data.expires_in) ? Number(data.expires_in) : 300;
    cachedAccessToken = data.access_token;
    cachedTokenExpiresAtMs = nowMs + Math.max(0, (ttlSeconds - 60) * 1000);
    return data.access_token;
  }

  interface FirestoreBudgetDoc {
    name?: string;
    updateTime?: string;
    fields?: {
      runtimeSpentCalls?: { integerValue?: string };
      sessions?: {
        mapValue?: {
          fields?: Record<
            string,
            {
              mapValue?: {
                fields?: {
                  listingsUsed?: { integerValue?: string };
                  avmsUsed?: { integerValue?: string };
                  propertyRecordsUsed?: { integerValue?: string };
                  expanded?: { booleanValue?: boolean };
                };
              };
            }
          >;
        };
      };
    };
  }

  function parseFirestoreDoc(
    doc: FirestoreBudgetDoc | null,
    billingMonth: string,
    sessionId?: string | null
  ): {
    runtimeSpentCalls: number;
    sessionsMap: Record<string, SessionUsageRow>;
    session: SessionUsageRow | null;
    updateTime: string | null;
  } {
    const runtimeSpentCalls = Number.parseInt(
      doc?.fields?.runtimeSpentCalls?.integerValue ?? '0',
      10
    );
    const rawSessions = doc?.fields?.sessions?.mapValue?.fields ?? {};
    const sessionsMap: Record<string, SessionUsageRow> = {};

    for (const [sid, rawEntry] of Object.entries(rawSessions)) {
      const f = rawEntry?.mapValue?.fields;
      sessionsMap[sid] = {
        sessionId: sid,
        billingMonth,
        listingsUsed: Number.parseInt(f?.listingsUsed?.integerValue ?? '0', 10),
        avmsUsed: Number.parseInt(f?.avmsUsed?.integerValue ?? '0', 10),
        propertyRecordsUsed: Number.parseInt(
          f?.propertyRecordsUsed?.integerValue ?? '0',
          10
        ),
        expanded: Boolean(f?.expanded?.booleanValue),
      };
    }

    const session = sessionId
      ? sessionsMap[sessionId] ?? {
          sessionId,
          billingMonth,
          listingsUsed: 0,
          avmsUsed: 0,
          propertyRecordsUsed: 0,
          expanded: false,
        }
      : null;

    return {
      runtimeSpentCalls: Number.isFinite(runtimeSpentCalls) ? runtimeSpentCalls : 0,
      sessionsMap,
      session,
      updateTime: doc?.updateTime ?? null,
    };
  }

  async function fetchFirestoreDoc(
    billingMonth: string,
    token: string
  ): Promise<FirestoreBudgetDoc | null> {
    const docUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      projectId
    )}/databases/(default)/documents/${encodeURIComponent(
      collectionName
    )}/${encodeURIComponent(billingMonth)}`;

    const resp = await fetchFn(docUrl, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(5_000),
    });

    if (resp.status === 404) {
      return null;
    }
    if (!resp.ok) {
      throw new Error(`Firestore GET returned HTTP ${resp.status}`);
    }
    return (await resp.json()) as FirestoreBudgetDoc;
  }

  async function commitFirestoreState(params: {
    billingMonth: string;
    token: string;
    runtimeSpentCalls: number;
    sessionsMap: Record<string, SessionUsageRow>;
    previousUpdateTime: string | null;
  }): Promise<void> {
    const commitUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
      projectId
    )}/databases/(default)/documents:commit`;
    const docName = `projects/${projectId}/databases/(default)/documents/${collectionName}/${params.billingMonth}`;

    const sessionFields: Record<string, unknown> = {};
    for (const [sid, s] of Object.entries(params.sessionsMap)) {
      sessionFields[sid] = {
        mapValue: {
          fields: {
            listingsUsed: { integerValue: String(s.listingsUsed) },
            avmsUsed: { integerValue: String(s.avmsUsed) },
            propertyRecordsUsed: { integerValue: String(s.propertyRecordsUsed) },
            expanded: { booleanValue: s.expanded },
          },
        },
      };
    }

    const currentDocument = params.previousUpdateTime
      ? { updateTime: params.previousUpdateTime }
      : { exists: false };

    const resp = await fetchFn(commitUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${params.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        writes: [
          {
            currentDocument,
            update: {
              name: docName,
              fields: {
                runtimeSpentCalls: { integerValue: String(params.runtimeSpentCalls) },
                sessions: {
                  mapValue: {
                    fields: sessionFields,
                  },
                },
              },
            },
          },
        ],
      }),
      signal: AbortSignal.timeout(5_000),
    });

    if (resp.status === 409 || resp.status === 400) {
      throw new FirestorePreconditionConflictError(
        resp.status,
        `Firestore optimistic concurrency precondition conflict (HTTP ${resp.status})`
      );
    }
    if (!resp.ok) {
      throw new Error(`Firestore atomic commit failed with HTTP ${resp.status}`);
    }
  }

  return {
    mode: 'firestore',
    reportedDurabilityMode: 'firestore',

    async getSnapshot(sessionId?: string | null): Promise<BudgetSnapshot> {
      if (!projectId) {
        throw new BudgetStoreError({
          code: 'BUDGET_STORE_UNAVAILABLE',
          message:
            'Firestore budget store requires GOOGLE_CLOUD_PROJECT to be configured; failing closed to protect monthly RentCast allowance.',
          statusCode: 503,
          uiState: 'quota_exhausted',
          retryable: false,
        });
      }
      try {
        const billingMonth = formatBillingMonth(nowFn());
        const token = await resolveFirestoreToken();
        const doc = await fetchFirestoreDoc(billingMonth, token);
        const parsed = parseFirestoreDoc(doc, billingMonth, sessionId);
        return buildSnapshotFromCounters({
          billingMonth,
          globalMonthlyLimit,
          initialSpentCalls,
          runtimeSpentCalls: parsed.runtimeSpentCalls,
          session: parsed.session,
          durabilityMode: 'firestore',
        });
      } catch (err) {
        if (err instanceof BudgetStoreError) {
          throw err;
        }
        throw new BudgetStoreError({
          code: 'BUDGET_STORE_UNAVAILABLE',
          message: `Firestore budget store failed closed: ${
            err instanceof Error ? err.message : 'unavailable'
          }`,
          statusCode: 503,
          uiState: 'quota_exhausted',
          retryable: true,
        });
      }
    },

    async reserveCall(
      kind: BudgetReservationKind,
      sessionId: string,
      clientKey?: string
    ): Promise<BudgetSnapshot> {
      if (!projectId) {
        throw new BudgetStoreError({
          code: 'BUDGET_STORE_UNAVAILABLE',
          message:
            'Firestore budget store requires GOOGLE_CLOUD_PROJECT to be configured; failing closed to protect monthly RentCast allowance.',
          statusCode: 503,
          uiState: 'quota_exhausted',
          retryable: false,
        });
      }

      return withFirestoreLock(async () => {
        try {
          const billingMonth = formatBillingMonth(nowFn());
          const token = await resolveFirestoreToken();
          let rateLimitRecorded = false;
          let lastError: unknown = null;

          for (let attempt = 1; attempt <= MAX_FIRESTORE_COMMIT_ATTEMPTS; attempt += 1) {
            const doc = await fetchFirestoreDoc(billingMonth, token);
            const parsed = parseFirestoreDoc(doc, billingMonth, sessionId);

            const preSnapshot = buildSnapshotFromCounters({
              billingMonth,
              globalMonthlyLimit,
              initialSpentCalls,
              runtimeSpentCalls: parsed.runtimeSpentCalls,
              session: parsed.session,
              durabilityMode: 'firestore',
            });

            validateReservationAgainstCaps(kind, preSnapshot);
            if (!rateLimitRecorded) {
              checkAndRecordClientRateLimit(clientKey, preSnapshot);
              rateLimitRecorded = true;
            }

            const nextRuntimeSpent = parsed.runtimeSpentCalls + 1;
            const currentSession = parsed.session ?? {
              sessionId,
              billingMonth,
              listingsUsed: 0,
              avmsUsed: 0,
              propertyRecordsUsed: 0,
              expanded: false,
            };

            const nextSession: SessionUsageRow = {
              ...currentSession,
              listingsUsed:
                currentSession.listingsUsed + (kind === 'listings' ? 1 : 0),
              avmsUsed: currentSession.avmsUsed + (kind === 'avm' ? 1 : 0),
              propertyRecordsUsed:
                currentSession.propertyRecordsUsed +
                (kind === 'property_record' ? 1 : 0),
            };

            const nextSessionsMap = {
              ...parsed.sessionsMap,
              [sessionId]: nextSession,
            };

            try {
              await commitFirestoreState({
                billingMonth,
                token,
                runtimeSpentCalls: nextRuntimeSpent,
                sessionsMap: nextSessionsMap,
                previousUpdateTime: parsed.updateTime,
              });

              return buildSnapshotFromCounters({
                billingMonth,
                globalMonthlyLimit,
                initialSpentCalls,
                runtimeSpentCalls: nextRuntimeSpent,
                session: nextSession,
                durabilityMode: 'firestore',
              });
            } catch (commitErr) {
              lastError = commitErr;
              if (
                commitErr instanceof FirestorePreconditionConflictError &&
                attempt < MAX_FIRESTORE_COMMIT_ATTEMPTS
              ) {
                continue;
              }
              throw commitErr;
            }
          }

          throw lastError ?? new Error('Exhausted Firestore commit attempts');
        } catch (err) {
          if (err instanceof BudgetStoreError) {
            throw err;
          }
          throw new BudgetStoreError({
            code: 'BUDGET_STORE_UNAVAILABLE',
            message: `Firestore atomic budget reservation failed closed: ${
              err instanceof Error ? err.message : 'commit failure'
            }`,
            statusCode: 503,
            uiState: 'quota_exhausted',
            retryable: true,
          });
        }
      });
    },

    async reserveListingsCall(sessionId: string, clientKey?: string): Promise<BudgetSnapshot> {
      return this.reserveCall('listings', sessionId, clientKey);
    },

    async reserveAvmCall(sessionId: string, clientKey?: string): Promise<BudgetSnapshot> {
      return this.reserveCall('avm', sessionId, clientKey);
    },

    async reservePropertyRecordCall(
      sessionId: string,
      clientKey?: string
    ): Promise<BudgetSnapshot> {
      return this.reserveCall('property_record', sessionId, clientKey);
    },

    async expandSession(sessionId: string, userConfirmed: boolean): Promise<BudgetSnapshot> {
      if (userConfirmed !== true) {
        throw new BudgetStoreError({
          code: 'VALIDATION_ERROR',
          message:
            'Explicit user confirmation (userConfirmed: true) is required to expand session budget.',
          statusCode: 400,
          uiState: 'recovery',
          retryable: false,
        });
      }
      if (!projectId) {
        throw new BudgetStoreError({
          code: 'BUDGET_STORE_UNAVAILABLE',
          message: 'Firestore budget store requires GOOGLE_CLOUD_PROJECT to be configured.',
          statusCode: 503,
          uiState: 'quota_exhausted',
          retryable: false,
        });
      }

      return withFirestoreLock(async () => {
        try {
          const billingMonth = formatBillingMonth(nowFn());
          const token = await resolveFirestoreToken();
          let lastError: unknown = null;

          for (let attempt = 1; attempt <= MAX_FIRESTORE_COMMIT_ATTEMPTS; attempt += 1) {
            const doc = await fetchFirestoreDoc(billingMonth, token);
            const parsed = parseFirestoreDoc(doc, billingMonth, sessionId);

            const currentSession = parsed.session ?? {
              sessionId,
              billingMonth,
              listingsUsed: 0,
              avmsUsed: 0,
              propertyRecordsUsed: 0,
              expanded: false,
            };
            const expandedSession: SessionUsageRow = {
              ...currentSession,
              expanded: true,
            };

            try {
              await commitFirestoreState({
                billingMonth,
                token,
                runtimeSpentCalls: parsed.runtimeSpentCalls,
                sessionsMap: {
                  ...parsed.sessionsMap,
                  [sessionId]: expandedSession,
                },
                previousUpdateTime: parsed.updateTime,
              });

              return buildSnapshotFromCounters({
                billingMonth,
                globalMonthlyLimit,
                initialSpentCalls,
                runtimeSpentCalls: parsed.runtimeSpentCalls,
                session: expandedSession,
                durabilityMode: 'firestore',
              });
            } catch (commitErr) {
              lastError = commitErr;
              if (
                commitErr instanceof FirestorePreconditionConflictError &&
                attempt < MAX_FIRESTORE_COMMIT_ATTEMPTS
              ) {
                continue;
              }
              throw commitErr;
            }
          }

          throw lastError ?? new Error('Exhausted Firestore session expansion attempts');
        } catch (err) {
          if (err instanceof BudgetStoreError) {
            throw err;
          }
          throw new BudgetStoreError({
            code: 'BUDGET_STORE_UNAVAILABLE',
            message: `Firestore session expansion failed closed: ${
              err instanceof Error ? err.message : 'commit failure'
            }`,
            statusCode: 503,
            uiState: 'quota_exhausted',
            retryable: true,
          });
        }
      });
    },

    withConcurrencySlot,

    close(): void {
      // No persistent socket to close for REST client
    },
  };
}
