/**
 * Express Routers for Region Resolution, Property Search, On-Demand AVM & Session Expansion
 * (`src/server/property/router.ts`)
 *
 * Implements:
 * - `POST /api/regions/resolve` (`regionsRouter`)
 * - `POST /api/properties/search` (`propertiesRouter`)
 * - `POST /api/properties/:propertyId/avm` (`propertiesRouter`)
 * - `POST /api/sessions/:sessionId/expand` (`sessionsRouter`)
 */

import { type Request, type Response, Router } from 'express';
import {
  ANALYSIS_BOUNDS,
  MANDATORY_NON_CLAIMS,
} from '../../shared/constants';
import {
  PropertyAvmRequestSchema,
  PropertySearchRequestSchema,
  RegionResolveRequestSchema,
  SessionExpandRequestSchema,
  SessionIdSchema,
  buildValidationErrorResponse,
} from '../../shared/schemas';
import type {
  AccessibilityResult,
  AnalysisArea,
  ApiErrorResponse,
  BudgetSnapshot,
  PreferenceProfile,
  PropertyAvmResponse,
  PropertyListingSummary,
  PropertySearchResponse,
  SessionExpandResponse,
} from '../../shared/types';
import { type ServerConfig, redactSecretsFromText } from '../config';
import { computePriceGap, isValidCoordinate } from '../geospatial/scoring';
import { type BudgetStore, BudgetStoreError } from './budgetStore';
import {
  type RegionResolver,
  isCoordinateInUsCoverage,
} from './regionResolver';
import {
  type RentCastClient,
  RentCastClientError,
  normalizeAvmResponse,
} from './rentcastClient';
import {
  type PropertySessionStore,
  buildSearchCacheKey,
} from './sessionStore';
import {
  buildSyntheticAvmForProperty,
  buildSyntheticListingsForArea,
} from './syntheticFixtures';

export interface PropertyRouterDependencies {
  readonly config: ServerConfig;
  readonly budgetStore: BudgetStore;
  readonly regionResolver: RegionResolver;
  readonly rentcastClient: RentCastClient;
  readonly sessionStore: PropertySessionStore;
  /**
   * Optional hook allowing `integrator` / `geospatial` to enrich property listings
   * with server-computed accessibility scores and nearby EPA counts when cached/available.
   */
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

function extractClientRequestSeq(body: unknown): number | undefined {
  if (
    body &&
    typeof body === 'object' &&
    typeof (body as { clientRequestSeq?: unknown }).clientRequestSeq === 'number' &&
    Number.isInteger((body as { clientRequestSeq: number }).clientRequestSeq) &&
    (body as { clientRequestSeq: number }).clientRequestSeq >= 0 &&
    (body as { clientRequestSeq: number }).clientRequestSeq <= 1_000_000_000
  ) {
    return (body as { clientRequestSeq: number }).clientRequestSeq;
  }
  return undefined;
}

function extractClientKey(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
    return forwarded.split(',')[0]!.trim();
  }
  return req.ip || 'local_client';
}

async function safeGetBudgetSnapshot(
  budgetStore: BudgetStore,
  sessionId?: string | null
): Promise<BudgetSnapshot | null> {
  try {
    return await budgetStore.getSnapshot(sessionId);
  } catch {
    return null;
  }
}

async function sendHandledDomainError(
  res: Response,
  err: unknown,
  config: ServerConfig,
  budgetStore: BudgetStore,
  sessionId?: string | null,
  clientRequestSeq?: number
): Promise<void> {
  const seqField =
    clientRequestSeq !== undefined ? { clientRequestSeq } : {};

  if (err instanceof BudgetStoreError) {
    const budget =
      err.snapshot ?? (await safeGetBudgetSnapshot(budgetStore, sessionId));
    const payload: ApiErrorResponse = {
      error: {
        code: err.code,
        message: redactSecretsFromText(err.message, config),
        uiState: err.uiState,
        retryable: err.retryable,
      },
      budget,
      ...seqField,
    };
    res.status(err.statusCode).json(payload);
    return;
  }

  if (err instanceof RentCastClientError) {
    const budget = await safeGetBudgetSnapshot(budgetStore, sessionId);
    const payload: ApiErrorResponse = {
      error: {
        code: err.code,
        message: redactSecretsFromText(err.message, config),
        uiState: err.uiState,
        retryable: err.retryable,
        ...(err.missingEnvVarNames
          ? { missingEnvVarNames: err.missingEnvVarNames }
          : {}),
      },
      budget,
      ...seqField,
    };
    res.status(err.statusCode).json(payload);
    return;
  }

  const budget = await safeGetBudgetSnapshot(budgetStore, sessionId);
  const safeMsg =
    err instanceof Error
      ? redactSecretsFromText(err.message, config)
      : 'Unexpected property service error.';

  const payload: ApiErrorResponse = {
    error: {
      code: 'INTERNAL_ERROR',
      message: safeMsg,
      uiState: 'recovery',
      retryable: true,
    },
    budget,
    ...seqField,
  };
  res.status(500).json(payload);
}

export function createPropertyRouters(deps: PropertyRouterDependencies): {
  regionsRouter: Router;
  propertiesRouter: Router;
  sessionsRouter: Router;
} {
  const {
    config,
    budgetStore,
    regionResolver,
    rentcastClient,
    sessionStore,
    scorePropertyPoint,
  } = deps;

  const regionsRouter = Router();
  const propertiesRouter = Router();
  const sessionsRouter = Router();

  // ==========================================================================
  // 1. POST /api/regions/resolve
  // ==========================================================================
  regionsRouter.post('/resolve', async (req: Request, res: Response) => {
    const rawSeq = extractClientRequestSeq(req.body);
    const parsed = RegionResolveRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json(buildValidationErrorResponse(parsed.error, rawSeq));
      return;
    }

    try {
      const result = await regionResolver.resolveRegion(parsed.data);
      res.status(200).json(result);
    } catch (err) {
      await sendHandledDomainError(
        res,
        err,
        config,
        budgetStore,
        null,
        parsed.data.clientRequestSeq
      );
    }
  });

  // ==========================================================================
  // 2. POST /api/properties/search
  // ==========================================================================
  propertiesRouter.post('/search', async (req: Request, res: Response) => {
    const rawSeq = extractClientRequestSeq(req.body);
    const parsed = PropertySearchRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      res
        .status(400)
        .json(buildValidationErrorResponse(parsed.error, rawSeq));
      return;
    }

    const {
      sessionId: requestedSessionId,
      analysisArea,
      limit,
      propertyType,
      preferences,
      useSyntheticDemo,
      clientRequestSeq,
    } = parsed.data;
    const seqField =
      clientRequestSeq !== undefined ? { clientRequestSeq } : {};

    // Verify US coverage on analysisArea coordinates
    if (
      !isCoordinateInUsCoverage(
        analysisArea.centerLat,
        analysisArea.centerLng
      )
    ) {
      const budget = await safeGetBudgetSnapshot(
        budgetStore,
        requestedSessionId
      );
      const unsupportedPayload: ApiErrorResponse = {
        error: {
          code: 'UNSUPPORTED_AREA',
          message:
            'Analysis area is outside supported United States geographic coverage.',
          uiState: 'unsupported_area',
          retryable: false,
        },
        budget,
        ...seqField,
      };
      res.status(422).json(unsupportedPayload);
      return;
    }

    const session = sessionStore.ensureSession(requestedSessionId);
    const safeLimit = Math.max(
      1,
      Math.min(ANALYSIS_BOUNDS.maxListingsPerSearch, limit ?? 25)
    );
    const isSyntheticRequested = Boolean(useSyntheticDemo);

    try {
      // Opt-in Synthetic Demo Mode
      if (isSyntheticRequested) {
        if (!config.enableSyntheticDemoMode) {
          const budget = await safeGetBudgetSnapshot(
            budgetStore,
            session.sessionId
          );
          const missingVars = config.secrets.rentcastApiKey
            ? ['ENABLE_SYNTHETIC_DEMO_MODE']
            : ['RENTCAST_API_KEY', 'ENABLE_SYNTHETIC_DEMO_MODE'];
          const setupPayload: ApiErrorResponse = {
            error: {
              code: 'SETUP_NEEDED',
              message:
                'Synthetic Demo mode is not enabled on the server (ENABLE_SYNTHETIC_DEMO_MODE=true required).',
              uiState: 'setup_needed',
              retryable: false,
              missingEnvVarNames: missingVars,
            },
            budget,
            ...seqField,
          };
          res.status(503).json(setupPayload);
          return;
        }

        const cacheKey = buildSearchCacheKey({
          area: analysisArea,
          limit: safeLimit,
          propertyType,
          isSyntheticDemo: true,
        });
        const cached = sessionStore.getCachedSearch(cacheKey);
        const nowIso = new Date().toISOString();

        const rawListings = cached
          ? cached.listings
          : buildSyntheticListingsForArea(
              analysisArea,
              safeLimit,
              propertyType
            );

        if (!cached) {
          sessionStore.setCachedSearch(cacheKey, {
            listings: rawListings,
            isSyntheticDemo: true,
            fetchedAt: nowIso,
          });
        }

        const enrichedListings: PropertyListingSummary[] = [];
        for (const item of rawListings) {
          if (scorePropertyPoint) {
            const scored = await scorePropertyPoint({
              analysisArea,
              lat: item.latitude,
              lng: item.longitude,
              preferences,
              isSyntheticDemo: true,
            });
            enrichedListings.push({
              ...item,
              accessibility: scored.accessibility,
              nearbyEnvironmentalCount: scored.nearbyEnvironmentalCount,
            });
          } else {
            enrichedListings.push(item);
          }
        }

        await sessionStore.recordSearchListingsAsync({
          sessionId: session.sessionId,
          analysisArea,
          listings: enrichedListings,
          isSyntheticDemo: true,
          fetchedAt: cached?.fetchedAt ?? nowIso,
        });

        const budget = await budgetStore.getSnapshot(session.sessionId);
        const responsePayload: PropertySearchResponse = {
          sessionId: session.sessionId,
          uiState: 'synthetic_demo',
          isSyntheticDemo: true,
          fromCache: Boolean(cached),
          listings: enrichedListings,
          budget,
          fetchedAt: cached?.fetchedAt ?? nowIso,
          ...seqField,
        };
        res.status(200).json(responsePayload);
        return;
      }

      // Live Mode: Check if RENTCAST_API_KEY is configured
      if (!config.secrets.rentcastApiKey) {
        const budget = await safeGetBudgetSnapshot(
          budgetStore,
          session.sessionId
        );
        const setupPayload: ApiErrorResponse = {
          error: {
            code: 'SETUP_NEEDED',
            message:
              'RENTCAST_API_KEY is not configured. Configure RENTCAST_API_KEY on the server or opt into labeled Synthetic Demo mode if enabled.',
            uiState: 'setup_needed',
            retryable: false,
            missingEnvVarNames: ['RENTCAST_API_KEY'],
          },
          budget,
          ...seqField,
        };
        res.status(503).json(setupPayload);
        return;
      }

      const cacheKey = buildSearchCacheKey({
        area: analysisArea,
        limit: safeLimit,
        propertyType,
        isSyntheticDemo: false,
      });

      const cachedLive = sessionStore.getCachedSearch(cacheKey);
      let rawListings: PropertyListingSummary[];
      let fetchedAt: string;
      let fromCache = false;
      let budget: BudgetSnapshot;

      if (cachedLive) {
        rawListings = cachedLive.listings;
        fetchedAt = cachedLive.fetchedAt;
        fromCache = true;
        budget = await budgetStore.getSnapshot(session.sessionId);
      } else {
        // Reserve 1 atomic listings call in the durable budget store BEFORE calling RentCast
        const clientKey = extractClientKey(req);
        budget = await budgetStore.reserveListingsCall(
          session.sessionId,
          clientKey
        );

        rawListings = await budgetStore.withConcurrencySlot(() =>
          rentcastClient.fetchSaleListings({
            centerLat: analysisArea.centerLat,
            centerLng: analysisArea.centerLng,
            radiusMeters: analysisArea.radiusMeters,
            limit: safeLimit,
            propertyType,
          })
        );

        fetchedAt = new Date().toISOString();
        sessionStore.setCachedSearch(cacheKey, {
          listings: rawListings,
          isSyntheticDemo: false,
          fetchedAt,
        });
      }

      const enrichedListings: PropertyListingSummary[] = [];
      for (const item of rawListings) {
        if (scorePropertyPoint) {
          const scored = await scorePropertyPoint({
            analysisArea,
            lat: item.latitude,
            lng: item.longitude,
            preferences,
            isSyntheticDemo: false,
          });
          enrichedListings.push({
            ...item,
            accessibility: scored.accessibility,
            nearbyEnvironmentalCount: scored.nearbyEnvironmentalCount,
          });
        } else {
          enrichedListings.push(item);
        }
      }

      await sessionStore.recordSearchListingsAsync({
        sessionId: session.sessionId,
        analysisArea,
        listings: enrichedListings,
        isSyntheticDemo: false,
        fetchedAt,
      });

      const responsePayload: PropertySearchResponse = {
        sessionId: session.sessionId,
        uiState: enrichedListings.length > 0 ? 'ready' : 'empty',
        isSyntheticDemo: false,
        fromCache,
        listings: enrichedListings,
        budget,
        fetchedAt,
        ...seqField,
      };
      res.status(200).json(responsePayload);
    } catch (err) {
      await sendHandledDomainError(
        res,
        err,
        config,
        budgetStore,
        session.sessionId,
        clientRequestSeq
      );
    }
  });

  // ==========================================================================
  // 3. POST /api/properties/:propertyId/avm
  // ==========================================================================
  propertiesRouter.post(
    '/:propertyId/avm',
    async (req: Request, res: Response) => {
      const rawSeq = extractClientRequestSeq(req.body);
      const rawPropertyId = String(req.params.propertyId ?? '').trim();

      if (!rawPropertyId || rawPropertyId.length > 160) {
        const badIdPayload: ApiErrorResponse = {
          error: {
            code: 'VALIDATION_ERROR',
            message: 'propertyId path parameter must be 1–160 characters.',
            uiState: 'recovery',
            retryable: false,
          },
          budget: null,
          ...(rawSeq !== undefined ? { clientRequestSeq: rawSeq } : {}),
        };
        res.status(400).json(badIdPayload);
        return;
      }

      const parsed = PropertyAvmRequestSchema.safeParse(req.body);
      if (!parsed.success) {
        res
          .status(400)
          .json(buildValidationErrorResponse(parsed.error, rawSeq));
        return;
      }

      const {
        sessionId,
        propertySnapshot,
        includeRecentSalesRecord,
        useSyntheticDemo,
        clientRequestSeq,
      } = parsed.data;
      const seqField =
        clientRequestSeq !== undefined ? { clientRequestSeq } : {};

      try {
        const resolved = await sessionStore.getResolvedSessionPropertyAsync(
          sessionId,
          rawPropertyId
        );

        let subject: PropertyListingSummary | null = resolved.listing;

        // If subject was not in session memory/durable store, reconstruct from validated propertySnapshot if provided
        if (!subject && propertySnapshot) {
          if (
            !isValidCoordinate(
              propertySnapshot.latitude,
              propertySnapshot.longitude
            ) ||
            !propertySnapshot.formattedAddress.trim()
          ) {
            const invalidSnapPayload: ApiErrorResponse = {
              error: {
                code: 'VALIDATION_ERROR',
                message:
                  'propertySnapshot requires a valid full formattedAddress and finite WGS84 coordinates.',
                uiState: 'recovery',
                retryable: false,
              },
              budget: await safeGetBudgetSnapshot(budgetStore, sessionId),
              ...seqField,
            };
            res.status(400).json(invalidSnapPayload);
            return;
          }

          const isSyn =
            Boolean(useSyntheticDemo) || rawPropertyId.startsWith('syn-');
          const ask = propertySnapshot.askingPrice ?? null;

          subject = {
            id: rawPropertyId,
            formattedAddress: propertySnapshot.formattedAddress.trim(),
            city: propertySnapshot.city ?? null,
            state: propertySnapshot.state ?? null,
            zipCode: propertySnapshot.zipCode ?? null,
            latitude: propertySnapshot.latitude,
            longitude: propertySnapshot.longitude,
            propertyType: propertySnapshot.propertyType ?? 'Single Family',
            bedrooms: propertySnapshot.bedrooms ?? null,
            bathrooms: propertySnapshot.bathrooms ?? null,
            squareFootage: propertySnapshot.squareFootage ?? null,
            lotSize: propertySnapshot.lotSize ?? null,
            yearBuilt: propertySnapshot.yearBuilt ?? null,
            askingPrice: ask,
            listingLastSeenAt: propertySnapshot.listingLastSeenAt ?? null,
            avmPrice: null,
            avmLow: null,
            avmHigh: null,
            avmFetchedAt: null,
            lastSalePrice: null,
            lastSaleDate: null,
            assessedValue: null,
            assessedYear: null,
            comparablesSummary: null,
            priceGap: computePriceGap({
              askingPrice: ask,
              avmPrice: null,
              avmLow: null,
              avmHigh: null,
            }),
            accessibility: null,
            nearbyEnvironmentalCount: 0,
            dataProvenance: isSyn ? 'synthetic_demo' : 'rentcast_live',
          };
        }

        if (!subject) {
          if (!resolved.sessionExists) {
            const expiredPayload: ApiErrorResponse = {
              error: {
                code: 'SESSION_EXPIRED',
                message: `Session "${sessionId}" has expired or is no longer available after a server restart or revision rollout. Zero paid RentCast calls were repeated automatically. Please run Analyze Area to start a fresh session or provide propertySnapshot.`,
                uiState: 'recovery',
                retryable: false,
              },
              budget: await safeGetBudgetSnapshot(budgetStore, sessionId),
              ...seqField,
            };
            res.status(409).json(expiredPayload);
            return;
          }

          const notFoundPayload: ApiErrorResponse = {
            error: {
              code: 'NOT_FOUND',
              message: `Property "${rawPropertyId}" was not found in session "${sessionId}". Run /api/properties/search first or supply propertySnapshot.`,
              uiState: 'empty',
              retryable: false,
            },
            budget: await safeGetBudgetSnapshot(budgetStore, sessionId),
            ...seqField,
          };
          res.status(404).json(notFoundPayload);
          return;
        }

        const isSyntheticMode =
          Boolean(useSyntheticDemo) ||
          subject.dataProvenance === 'synthetic_demo' ||
          resolved.session?.isSyntheticDemo === true;

        const cacheKey = `${isSyntheticMode ? 'syn' : 'live'}:${rawPropertyId}`;
        const existingDetail =
          resolved.detail ?? sessionStore.getCachedAvmDetail(cacheKey);

        // Return cached detail with 0 provider calls if already fetched (and no unfulfilled recent-sales request)
        if (
          existingDetail &&
          existingDetail.avmFetchedAt !== null &&
          (!includeRecentSalesRecord ||
            existingDetail.lastSalePrice !== null ||
            existingDetail.assessedValue !== null)
        ) {
          await sessionStore.recordPropertyDetailAsync(sessionId, existingDetail);
          const budget = await budgetStore.getSnapshot(sessionId);
          const cachedResponse: PropertyAvmResponse = {
            sessionId,
            uiState: isSyntheticMode ? 'synthetic_demo' : 'ready',
            isSyntheticDemo: isSyntheticMode,
            fromCache: true,
            property: existingDetail,
            budget,
            disclaimers: [...MANDATORY_NON_CLAIMS],
            ...seqField,
          };
          res.status(200).json(cachedResponse);
          return;
        }

        // Synthetic Demo AVM Path
        if (isSyntheticMode) {
          if (!config.enableSyntheticDemoMode) {
            const budget = await safeGetBudgetSnapshot(budgetStore, sessionId);
            const setupPayload: ApiErrorResponse = {
              error: {
                code: 'SETUP_NEEDED',
                message:
                  'Synthetic Demo mode is disabled on the server (ENABLE_SYNTHETIC_DEMO_MODE=true required).',
                uiState: 'setup_needed',
                retryable: false,
                missingEnvVarNames: ['ENABLE_SYNTHETIC_DEMO_MODE'],
              },
              budget,
              ...seqField,
            };
            res.status(503).json(setupPayload);
            return;
          }

          const detail = buildSyntheticAvmForProperty(subject);
          await sessionStore.recordPropertyDetailAsync(sessionId, detail);
          sessionStore.setCachedAvmDetail(cacheKey, detail);
          const budget = await budgetStore.getSnapshot(sessionId);

          const synResponse: PropertyAvmResponse = {
            sessionId,
            uiState: 'synthetic_demo',
            isSyntheticDemo: true,
            fromCache: false,
            property: detail,
            budget,
            disclaimers: [...MANDATORY_NON_CLAIMS],
            ...seqField,
          };
          res.status(200).json(synResponse);
          return;
        }

        // Live RentCast AVM Path
        if (!config.secrets.rentcastApiKey) {
          const budget = await safeGetBudgetSnapshot(budgetStore, sessionId);
          const setupPayload: ApiErrorResponse = {
            error: {
              code: 'SETUP_NEEDED',
              message:
                'RENTCAST_API_KEY is not configured on the server. Live on-demand AVM lookup is unavailable.',
              uiState: 'setup_needed',
              retryable: false,
              missingEnvVarNames: ['RENTCAST_API_KEY'],
            },
            budget,
            ...seqField,
          };
          res.status(503).json(setupPayload);
          return;
        }

        const clientKey = extractClientKey(req);
        const coalescedKey = `${sessionId}:${rawPropertyId}:${
          includeRecentSalesRecord ? 'with_rec' : 'avm_only'
        }`;

        const { detail, budget } = await sessionStore.coalesceInFlight(
          coalescedKey,
          async () => {
            // 1. Reserve 1 AVM call in the durable atomic budget store
            let latestBudget = await budgetStore.reserveAvmCall(
              sessionId,
              clientKey
            );

            // 2. If caller also requested optional `/v1/properties` record lookup, reserve that slot too
            let rawPropRecord: Record<string, unknown> | null = null;
            if (includeRecentSalesRecord) {
              latestBudget = await budgetStore.reservePropertyRecordCall(
                sessionId,
                clientKey
              );
            }

            // 3. Dispatch upstream RentCast calls within concurrency semaphore
            const rawAvmPayload = await budgetStore.withConcurrencySlot(() =>
              rentcastClient.fetchPropertyAvm({ subject: subject! })
            );

            if (includeRecentSalesRecord) {
              rawPropRecord = await budgetStore.withConcurrencySlot(() =>
                rentcastClient.fetchPropertyRecord(subject!.formattedAddress)
              );
            }

            const normalizedDetail = normalizeAvmResponse({
              subject: subject!,
              rawAvmPayload,
              rawPropertyRecordPayload: rawPropRecord,
            });

            await sessionStore.recordPropertyDetailAsync(
              sessionId,
              normalizedDetail
            );
            sessionStore.setCachedAvmDetail(cacheKey, normalizedDetail);

            return { detail: normalizedDetail, budget: latestBudget };
          }
        );

        const liveResponse: PropertyAvmResponse = {
          sessionId,
          uiState: 'ready',
          isSyntheticDemo: false,
          fromCache: false,
          property: detail,
          budget,
          disclaimers: [...MANDATORY_NON_CLAIMS],
          ...seqField,
        };
        res.status(200).json(liveResponse);
      } catch (err) {
        await sendHandledDomainError(
          res,
          err,
          config,
          budgetStore,
          sessionId,
          clientRequestSeq
        );
      }
    }
  );

  // ==========================================================================
  // 4. POST /api/sessions/:sessionId/expand
  // ==========================================================================
  sessionsRouter.post(
    '/:sessionId/expand',
    async (req: Request, res: Response) => {
      const rawSeq = extractClientRequestSeq(req.body);
      const sessionIdParse = SessionIdSchema.safeParse(req.params.sessionId);
      if (!sessionIdParse.success) {
        res
          .status(400)
          .json(buildValidationErrorResponse(sessionIdParse.error, rawSeq));
        return;
      }

      const bodyParse = SessionExpandRequestSchema.safeParse(req.body);
      if (!bodyParse.success) {
        res
          .status(400)
          .json(buildValidationErrorResponse(bodyParse.error, rawSeq));
        return;
      }

      const sessionId = sessionIdParse.data;
      const { userConfirmed, clientRequestSeq } = bodyParse.data;

      try {
        const hydratedSession = await sessionStore.getSessionAsync(sessionId);
        if (!hydratedSession) {
          const expiredPayload: ApiErrorResponse = {
            error: {
              code: 'SESSION_EXPIRED',
              message: `Session "${sessionId}" has expired or is no longer available after a server restart or revision rollout. Zero paid RentCast calls were repeated automatically. Please run Analyze Area to start a fresh session.`,
              uiState: 'recovery',
              retryable: false,
            },
            budget: await safeGetBudgetSnapshot(budgetStore, sessionId),
            ...(clientRequestSeq !== undefined ? { clientRequestSeq } : {}),
          };
          res.status(409).json(expiredPayload);
          return;
        }

        const budget = await budgetStore.expandSession(sessionId, userConfirmed);

        const responsePayload: SessionExpandResponse = {
          sessionId,
          expanded: true,
          budget,
          message: `Session "${sessionId}" expanded to allow up to ${budget.sessionAvmsLimit} on-demand home AVM comparisons and ${budget.sessionPropertyRecordsLimit} optional property record lookup (subject to remaining global monthly cap of ${budget.globalRemaining} calls).`,
          ...(clientRequestSeq !== undefined ? { clientRequestSeq } : {}),
        };
        res.status(200).json(responsePayload);
      } catch (err) {
        await sendHandledDomainError(
          res,
          err,
          config,
          budgetStore,
          sessionId,
          clientRequestSeq
        );
      }
    }
  );

  return {
    regionsRouter,
    propertiesRouter,
    sessionsRouter,
  };
}
