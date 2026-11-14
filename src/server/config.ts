/**
 * Runtime Server Configuration & Secret Isolation (`src/server/config.ts`)
 *
 * SECURITY INVARIANT:
 * Server secrets (`RENTCAST_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_PLACES_SERVER_KEY`)
 * are read exclusively on the server and NEVER serialized into `PublicRuntimeConfig`,
 * client bundles, URLs, logs, or error payloads.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  ANALYSIS_BOUNDS,
  APP_NAME,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_SOURCE_ATTRIBUTIONS,
  RENTCAST_BUDGET_DEFAULTS,
} from '../shared/constants';
import { createDefaultPreferenceProfile } from '../shared/schemas';
import type {
  BudgetStoreMode,
  MissingSetupEnvVar,
  PublicRuntimeConfig,
  RuntimeCapabilities,
} from '../shared/types';

export interface ServerSecrets {
  readonly rentcastApiKey: string | null;
  readonly geminiApiKey: string | null;
  readonly googlePlacesServerKey: string | null;
}

export interface ServerConfig {
  readonly nodeEnv: 'development' | 'production' | 'test';
  readonly host: string;
  readonly port: number;
  readonly secrets: ServerSecrets;
  /** HTTP-referrer-restricted browser key intentionally served via GET /api/config */
  readonly googleMapsBrowserKey: string | null;
  readonly rentcastGlobalMonthlyLimit: number;
  readonly rentcastInitialSpentCalls: number;
  readonly budgetStoreMode: BudgetStoreMode;
  readonly sqliteBudgetPath: string;
  readonly googleCloudProject: string | null;
  readonly firestoreBudgetCollection: string;
  readonly geminiExplainModel: string;
  readonly geminiExplainFallbackModel: string;
  readonly osmOverpassUrl: string;
  readonly enableSyntheticDemoMode: boolean;
}

let dotEnvLoaded = false;

function maybeLoadDotEnvFile(): void {
  if (dotEnvLoaded) {
    return;
  }
  dotEnvLoaded = true;
  if (process.env.NODE_ENV === 'test') {
    return;
  }
  const envFilePath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envFilePath) && typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(envFilePath);
    } catch {
      // Ignore optional .env parse issues; missing vars degrade cleanly to setup_needed
    }
  }
}

function readNonEmptyString(raw: string | undefined): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseIntegerWithBounds(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number
): number {
  if (raw === undefined || raw.trim() === '') {
    return fallback;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function parseBooleanFlag(raw: string | undefined, fallback = false): boolean {
  if (raw === undefined) {
    return fallback;
  }
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no') {
    return false;
  }
  return fallback;
}

/**
 * Loads and validates server configuration from the provided `env` object
 * (defaults to `process.env` after optional local `.env` loading).
 */
export function loadServerConfig(env?: NodeJS.ProcessEnv): ServerConfig {
  if (!env) {
    maybeLoadDotEnvFile();
  }
  const sourceEnv = env ?? process.env;

  const rawNodeEnv = readNonEmptyString(sourceEnv.NODE_ENV);
  const nodeEnv: ServerConfig['nodeEnv'] =
    rawNodeEnv === 'production' || rawNodeEnv === 'test' ? rawNodeEnv : 'development';

  const parsedPort = Number(sourceEnv.PORT);
  const port =
    Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort <= 65535
      ? parsedPort
      : DEFAULT_PORT;

  const rentcastGlobalMonthlyLimit = parseIntegerWithBounds(
    sourceEnv.RENTCAST_GLOBAL_MONTHLY_LIMIT,
    RENTCAST_BUDGET_DEFAULTS.defaultGlobalMonthlyLimit,
    1,
    RENTCAST_BUDGET_DEFAULTS.maxConfigurableMonthlyLimit
  );

  const rentcastInitialSpentCalls = parseIntegerWithBounds(
    sourceEnv.RENTCAST_INITIAL_SPENT_CALLS,
    RENTCAST_BUDGET_DEFAULTS.defaultInitialSpentCalls,
    0,
    10_000
  );

  const rawStoreMode = readNonEmptyString(sourceEnv.BUDGET_STORE_MODE)?.toLowerCase();
  const budgetStoreMode: BudgetStoreMode =
    rawStoreMode === 'firestore'
      ? 'firestore'
      : rawStoreMode === 'memory'
        ? 'memory'
        : 'sqlite';

  const rawSecrets: ServerSecrets = {
    rentcastApiKey: readNonEmptyString(sourceEnv.RENTCAST_API_KEY),
    geminiApiKey: readNonEmptyString(sourceEnv.GEMINI_API_KEY),
    googlePlacesServerKey: readNonEmptyString(sourceEnv.GOOGLE_PLACES_SERVER_KEY),
  };

  // Define non-enumerable `toJSON` BEFORE freezing to prevent accidental JSON.stringify exposure
  Object.defineProperty(rawSecrets, 'toJSON', {
    value: () => '[REDACTED_SERVER_SECRETS]',
    enumerable: false,
  });

  const secrets: ServerSecrets = Object.freeze(rawSecrets);

  return Object.freeze({
    nodeEnv,
    host: DEFAULT_HOST,
    port,
    secrets,
    googleMapsBrowserKey: readNonEmptyString(sourceEnv.GOOGLE_MAPS_BROWSER_KEY),
    rentcastGlobalMonthlyLimit,
    rentcastInitialSpentCalls,
    budgetStoreMode,
    sqliteBudgetPath:
      readNonEmptyString(sourceEnv.SQLITE_BUDGET_PATH) ?? '.data/rentcast-budget.sqlite',
    googleCloudProject: readNonEmptyString(sourceEnv.GOOGLE_CLOUD_PROJECT),
    firestoreBudgetCollection:
      readNonEmptyString(sourceEnv.FIRESTORE_BUDGET_COLLECTION) ?? 'rentcast_budget',
    geminiExplainModel:
      readNonEmptyString(sourceEnv.GEMINI_EXPLAIN_MODEL) ?? 'gemini-4-hydrogen',
    geminiExplainFallbackModel:
      readNonEmptyString(sourceEnv.GEMINI_EXPLAIN_FALLBACK_MODEL) ?? 'gemini-2.5-flash',
    osmOverpassUrl:
      readNonEmptyString(sourceEnv.OSM_OVERPASS_URL) ??
      'https://overpass-api.de/api/interpreter',
    enableSyntheticDemoMode: parseBooleanFlag(sourceEnv.ENABLE_SYNTHETIC_DEMO_MODE, false),
  });
}

export function getRuntimeCapabilities(config: ServerConfig): RuntimeCapabilities {
  return {
    rentcastConfigured: Boolean(config.secrets.rentcastApiKey),
    geminiConfigured: Boolean(config.secrets.geminiApiKey),
    mapsBasemapConfigured: Boolean(config.googleMapsBrowserKey),
    placesContextConfigured: Boolean(config.secrets.googlePlacesServerKey),
    syntheticDemoEnabled: config.enableSyntheticDemoMode,
  };
}

/**
 * Constructs the safe public runtime DTO served by `GET /api/config`.
 * NEVER includes server secret values (`RENTCAST_API_KEY`, `GEMINI_API_KEY`, `GOOGLE_PLACES_SERVER_KEY`).
 */
export function buildPublicRuntimeConfig(config: ServerConfig): PublicRuntimeConfig {
  const capabilities = getRuntimeCapabilities(config);
  const missingSetupEnvVars: MissingSetupEnvVar[] = [];

  if (!capabilities.rentcastConfigured) {
    missingSetupEnvVars.push({
      envVarName: 'RENTCAST_API_KEY',
      feature: 'Live US Property Listings & On-Demand AVM',
      requiredForLiveMode: true,
    });
  }
  if (!capabilities.mapsBasemapConfigured) {
    missingSetupEnvVars.push({
      envVarName: 'GOOGLE_MAPS_BROWSER_KEY',
      feature: 'Interactive Google Maps JS Basemap',
      requiredForLiveMode: false,
    });
  }
  if (!capabilities.geminiConfigured) {
    missingSetupEnvVars.push({
      envVarName: 'GEMINI_API_KEY',
      feature: 'Grounded Gemini Explanation (/api/explain)',
      requiredForLiveMode: false,
    });
  }

  // Synthetic demo mode is strictly user opt-in via `capabilities.syntheticDemoEnabled`;
  // `uiSetupState` remains `'setup_needed'` whenever `RENTCAST_API_KEY` is unconfigured.
  const uiSetupState: PublicRuntimeConfig['uiSetupState'] = capabilities.rentcastConfigured
    ? 'ready'
    : 'setup_needed';

  return {
    appTitle: APP_NAME,
    uiSetupState,
    capabilities,
    missingSetupEnvVars,
    mapsBrowserKey: config.googleMapsBrowserKey,
    defaultPreferences: createDefaultPreferenceProfile(),
    analysisBounds: {
      minAreaRadiusMeters: ANALYSIS_BOUNDS.minAreaRadiusMeters,
      maxAreaRadiusMeters: ANALYSIS_BOUNDS.maxAreaRadiusMeters,
      defaultAreaRadiusMeters: ANALYSIS_BOUNDS.defaultAreaRadiusMeters,
      minCategoryRadiusMeters: ANALYSIS_BOUNDS.minCategoryRadiusMeters,
      maxCategoryRadiusMeters: ANALYSIS_BOUNDS.maxCategoryRadiusMeters,
      maxListingsPerSearch: ANALYSIS_BOUNDS.maxListingsPerSearch,
    },
    budgetLimits: {
      globalMonthlyLimit: config.rentcastGlobalMonthlyLimit,
      defaultSessionListingsLimit: RENTCAST_BUDGET_DEFAULTS.defaultSessionListingsLimit,
      defaultSessionAvmsLimit: RENTCAST_BUDGET_DEFAULTS.defaultSessionAvmsLimit,
      expandedSessionAvmsLimit: RENTCAST_BUDGET_DEFAULTS.expandedSessionAvmsLimit,
      expandedSessionPropertyRecordsLimit:
        RENTCAST_BUDGET_DEFAULTS.expandedSessionPropertyRecordsLimit,
      durabilityMode: config.budgetStoreMode,
    },
    attributions: [...DEFAULT_SOURCE_ATTRIBUTIONS],
  };
}

/**
 * Scrubs any configured secret values (both raw and URL-encoded forms) from arbitrary
 * log/error text as defense-in-depth.
 */
export function redactSecretsFromText(text: string, config: ServerConfig): string {
  let sanitized = text;
  const secretValues = [
    config.secrets.rentcastApiKey,
    config.secrets.geminiApiKey,
    config.secrets.googlePlacesServerKey,
  ];

  for (const val of secretValues) {
    if (val && val.length >= 4) {
      if (sanitized.includes(val)) {
        sanitized = sanitized.split(val).join('[REDACTED]');
      }
      const encoded = encodeURIComponent(val);
      if (encoded.length >= 4 && sanitized.includes(encoded)) {
        sanitized = sanitized.split(encoded).join('[REDACTED]');
      }
    }
  }
  return sanitized;
}
