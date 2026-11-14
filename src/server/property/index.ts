/**
 * Property, Region Resolution & Durable Budget Module Barrel (`src/server/property/index.ts`)
 *
 * Exports `createPropertyModule(config, deps?)` for Stage 3 app wiring in `src/server/app.ts`
 * as well as all underlying stores, resolvers, and normalizers.
 */

import type { Router } from 'express';
import type {
  AccessibilityResult,
  AnalysisArea,
  PreferenceProfile,
} from '../../shared/types';
import type { ServerConfig } from '../config';
import {
  type BudgetStore,
  type BudgetStoreOptions,
  BudgetStoreError,
  createBudgetStore,
} from './budgetStore';
import {
  type RegionResolver,
  type RegionResolverOptions,
  NOMINATIM_USER_AGENT,
  candidateToAnalysisArea,
  createRegionResolver,
  isCoordinateInUsCoverage,
} from './regionResolver';
import {
  type RentCastClient,
  type RentCastClientOptions,
  RENTCAST_BASE_URL,
  RentCastClientError,
  buildContraryEvidence,
  createRentCastClient,
  extractLatestTaxAssessment,
  normalizeAddressForMatch,
  normalizeAvmResponse,
  normalizeSaleListingRecord,
  stripRentCastPii,
} from './rentcastClient';
import { createPropertyRouters } from './router';
import {
  type PropertySessionStore,
  type ResolvedSessionPropertyLookup,
  buildSearchCacheKey,
  createPropertySessionStore,
  generateSessionId,
} from './sessionStore';
import {
  buildSyntheticAvmForProperty,
  buildSyntheticListingsForArea,
} from './syntheticFixtures';

export interface CreatePropertyModuleDependencies {
  readonly budgetStore?: BudgetStore;
  readonly budgetStoreOptions?: Partial<BudgetStoreOptions>;
  readonly regionResolver?: RegionResolver;
  readonly regionResolverOptions?: Partial<RegionResolverOptions>;
  readonly rentcastClient?: RentCastClient;
  readonly rentcastClientOptions?: Partial<RentCastClientOptions>;
  readonly sessionStore?: PropertySessionStore;
  readonly fetchFn?: typeof fetch;
  readonly scorePropertyPoint?: (params: {
    analysisArea: AnalysisArea | null;
    lat: number;
    lng: number;
    preferences?: PreferenceProfile;
    isSyntheticDemo: boolean;
  }) => Promise<{
    accessibility: AccessibilityResult | null;
    nearbyEnvironmentalCount: number;
  }> | {
    accessibility: AccessibilityResult | null;
    nearbyEnvironmentalCount: number;
  };
}

export interface PropertyModule {
  readonly regionsRouter: Router;
  readonly propertiesRouter: Router;
  readonly sessionsRouter: Router;
  readonly budgetStore: BudgetStore;
  readonly regionResolver: RegionResolver;
  readonly rentcastClient: RentCastClient;
  readonly sessionStore: PropertySessionStore;
  getResolvedSessionProperty(
    sessionId: string,
    propertyId: string
  ): ResolvedSessionPropertyLookup;
}

export function createPropertyModule(
  config: ServerConfig,
  deps: CreatePropertyModuleDependencies = {}
): PropertyModule {
  const budgetStore =
    deps.budgetStore ??
    createBudgetStore({
      mode: config.budgetStoreMode,
      reportedDurabilityMode: config.budgetStoreMode,
      globalMonthlyLimit: config.rentcastGlobalMonthlyLimit,
      initialSpentCalls: config.rentcastInitialSpentCalls,
      sqlitePath: config.sqliteBudgetPath,
      googleCloudProject: config.googleCloudProject,
      firestoreCollection: config.firestoreBudgetCollection,
      fetchFn: deps.fetchFn,
      ...deps.budgetStoreOptions,
    });

  const regionResolver =
    deps.regionResolver ??
    createRegionResolver({
      fetchFn: deps.fetchFn,
      ...deps.regionResolverOptions,
    });

  const rentcastClient =
    deps.rentcastClient ??
    createRentCastClient({
      apiKey: config.secrets.rentcastApiKey,
      fetchFn: deps.fetchFn,
      ...deps.rentcastClientOptions,
    });

  const sessionStore = deps.sessionStore ?? createPropertySessionStore();

  const routers = createPropertyRouters({
    config,
    budgetStore,
    regionResolver,
    rentcastClient,
    sessionStore,
    scorePropertyPoint: deps.scorePropertyPoint,
  });

  return {
    regionsRouter: routers.regionsRouter,
    propertiesRouter: routers.propertiesRouter,
    sessionsRouter: routers.sessionsRouter,
    budgetStore,
    regionResolver,
    rentcastClient,
    sessionStore,
    getResolvedSessionProperty(
      sessionId: string,
      propertyId: string
    ): ResolvedSessionPropertyLookup {
      return sessionStore.getResolvedSessionProperty(sessionId, propertyId);
    },
  };
}

export {
  BudgetStoreError,
  createBudgetStore,
  type BudgetStore,
  type BudgetStoreOptions,
  NOMINATIM_USER_AGENT,
  candidateToAnalysisArea,
  createRegionResolver,
  isCoordinateInUsCoverage,
  type RegionResolver,
  type RegionResolverOptions,
  RENTCAST_BASE_URL,
  RentCastClientError,
  buildContraryEvidence,
  createRentCastClient,
  extractLatestTaxAssessment,
  normalizeAddressForMatch,
  normalizeAvmResponse,
  normalizeSaleListingRecord,
  stripRentCastPii,
  type RentCastClient,
  type RentCastClientOptions,
  createPropertyRouters,
  buildSearchCacheKey,
  createPropertySessionStore,
  generateSessionId,
  type PropertySessionStore,
  type ResolvedSessionPropertyLookup,
  buildSyntheticAvmForProperty,
  buildSyntheticListingsForArea,
};
