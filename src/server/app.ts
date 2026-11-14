/**
 * Express Application Wiring (`src/server/app.ts`)
 *
 * Wires the complete full-stack Foreal-Estate backend:
 * - `GET /api/health` & `GET /api/config`
 * - `POST /api/regions/resolve` (`propertyModule.regionsRouter`)
 * - `POST /api/geospatial/analyze` (`geospatialModule.geospatialRouter`)
 * - `POST /api/properties/search` & `POST /api/properties/:propertyId/avm` (`propertyModule.propertiesRouter`)
 * - `POST /api/sessions/:sessionId/expand` (`propertyModule.sessionsRouter`)
 * - `POST /api/explain` (`explainModule.explainRouter`, strictly server-resolved)
 * - Static SPA serving from `dist/client` when built.
 */

import fs from 'node:fs';
import path from 'node:path';
import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response,
  type Router,
} from 'express';
import { APP_SERVICE_ID, APP_VERSION } from '../shared/constants';
import {
  createDefaultPreferenceProfile,
  extractValidClientRequestSeq,
} from '../shared/schemas';
import type {
  AnalysisArea,
  ApiErrorResponse,
  HealthResponse,
  PreferenceProfile,
  PropertyAvmResponse,
  PropertyDetailRecord,
} from '../shared/types';
import {
  type ServerConfig,
  buildPublicRuntimeConfig,
  getRuntimeCapabilities,
  loadServerConfig,
  redactSecretsFromText,
} from './config';
import {
  type ExplainModule,
  type ExplainServiceDependencies,
  type PropertyContextResolution,
  createExplainModule,
} from './explain';
import {
  type GeospatialModule,
  type GeospatialModuleOptions,
  type PointAreaScoreEvaluation,
  computePriceGap,
  createGeospatialModule,
} from './geospatial';
import {
  type CreatePropertyModuleDependencies,
  type PropertyModule,
  buildContraryEvidence,
  createPropertyModule,
} from './property';

export interface CreateAppOptions {
  readonly config?: ServerConfig;
  readonly clientDistDir?: string;
  readonly geospatialModule?: GeospatialModule;
  readonly geospatialOptions?: GeospatialModuleOptions;
  readonly propertyModule?: PropertyModule;
  readonly propertyDeps?: CreatePropertyModuleDependencies;
  readonly explainModule?: ExplainModule;
  readonly explainDeps?: ExplainServiceDependencies;
  readonly regionsRouter?: Router;
  readonly geospatialRouter?: Router;
  readonly propertiesRouter?: Router;
  readonly sessionsRouter?: Router;
  readonly explainRouter?: Router;
  readonly apiRouter?: Router;
}

export function createApp(options: CreateAppOptions = {}): Express {
  const config = options.config ?? loadServerConfig();
  const app = express();

  app.disable('x-powered-by');

  // Security & baseline response headers
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  app.use(express.json({ limit: '256kb' }));

  // ==========================================================================
  // Core Readiness & Public Configuration Endpoints
  // ==========================================================================

  app.get('/api/health', (_req: Request, res: Response) => {
    const payload: HealthResponse = {
      status: 'ok',
      service: APP_SERVICE_ID,
      version: APP_VERSION,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.round(process.uptime() * 100) / 100,
      durabilityMode: config.budgetStoreMode,
      capabilities: getRuntimeCapabilities(config),
    };
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(payload);
  });

  app.get('/api/config', (_req: Request, res: Response) => {
    const publicConfig = buildPublicRuntimeConfig(config);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(publicConfig);
  });

  // ==========================================================================
  // Cross-Module Server Wiring (Geospatial <-> Property <-> Grounded Explain)
  // ==========================================================================

  const geospatialModule =
    options.geospatialModule ??
    createGeospatialModule(config, options.geospatialOptions);

  // Coalesce concurrent initial area geospatial fetches (e.g. parallel `/api/geospatial/analyze`
  // and `/api/properties/search` on "Analyze Area") so listings always receive deterministic scores.
  const inFlightAreaEvaluations = new Map<string, Promise<void>>();

  async function evaluatePointWithAreaCache(params: {
    analysisArea: AnalysisArea | null;
    lat: number;
    lng: number;
    preferences?: PreferenceProfile;
    isSyntheticDemo: boolean;
  }): Promise<PointAreaScoreEvaluation | null> {
    const { analysisArea, lat, lng, preferences, isSyntheticDemo } = params;
    if (!analysisArea) {
      return null;
    }

    const effectiveSynthetic = Boolean(
      isSyntheticDemo && config.enableSyntheticDemoMode
    );
    const cachedEntry = geospatialModule.getCachedAreaGeospatial(
      analysisArea.areaId
    );

    if (!cachedEntry || cachedEntry.isSyntheticDemo !== effectiveSynthetic) {
      const inflightKey = `${effectiveSynthetic ? 'syn' : 'live'}:${analysisArea.areaId}`;
      let pending = inFlightAreaEvaluations.get(inflightKey);
      if (!pending) {
        pending = geospatialModule
          .analyzeArea({
            analysisArea,
            preferences: preferences ?? createDefaultPreferenceProfile(),
            useSyntheticDemo: effectiveSynthetic,
          })
          .then(() => undefined)
          .catch(() => undefined)
          .finally(() => {
            inFlightAreaEvaluations.delete(inflightKey);
          });
        inFlightAreaEvaluations.set(inflightKey, pending);
      }
      await pending;
    }

    try {
      return geospatialModule.scorePointForArea(
        analysisArea.areaId,
        { lat, lng },
        preferences
      );
    } catch {
      return null;
    }
  }

  const propertyModule =
    options.propertyModule ??
    createPropertyModule(config, {
      ...options.propertyDeps,
      scorePropertyPoint:
        options.propertyDeps?.scorePropertyPoint ??
        (async ({ analysisArea, lat, lng, preferences, isSyntheticDemo }) => {
          const evaluated = await evaluatePointWithAreaCache({
            analysisArea,
            lat,
            lng,
            preferences,
            isSyntheticDemo,
          });
          return {
            accessibility: evaluated?.accessibility ?? null,
            nearbyEnvironmentalCount: evaluated?.nearbyEnvironmentalCount ?? 0,
          };
        }),
    });

  const defaultResolvePropertyContext = async (
    sessionId: string,
    propertyId: string,
    preferences: PreferenceProfile,
    useSyntheticDemo?: boolean
  ): Promise<PropertyContextResolution | null> => {
    const resolved = propertyModule.getResolvedSessionProperty(
      sessionId,
      propertyId
    );
    const baseRecord = resolved.detail ?? resolved.listing;
    if (!baseRecord) {
      // Never trust forged/unverified client propertyContext when absent from server state
      return null;
    }

    const effectiveSynthetic = Boolean(
      (useSyntheticDemo && config.enableSyntheticDemoMode) ||
        baseRecord.dataProvenance === 'synthetic_demo' ||
        resolved.session?.isSyntheticDemo === true
    );

    const verifiedPriceGap = computePriceGap({
      askingPrice: baseRecord.askingPrice,
      avmPrice: baseRecord.avmPrice,
      avmLow: baseRecord.avmLow,
      avmHigh: baseRecord.avmHigh,
    });

    const spatialEval = await evaluatePointWithAreaCache({
      analysisArea: resolved.session?.analysisArea ?? null,
      lat: baseRecord.latitude,
      lng: baseRecord.longitude,
      preferences,
      isSyntheticDemo: effectiveSynthetic,
    });

    const accessibility =
      spatialEval?.accessibility ?? baseRecord.accessibility ?? null;
    const environmentalRecords = spatialEval?.environmentalRecords ?? [];
    const nearbyEnvironmentalCount =
      spatialEval?.nearbyEnvironmentalCount ??
      baseRecord.nearbyEnvironmentalCount ??
      0;

    const contraryEvidence = resolved.detail
      ? resolved.detail.contraryEvidence
      : buildContraryEvidence({
          property: {
            propertyType: baseRecord.propertyType,
            bedrooms: baseRecord.bedrooms,
            bathrooms: baseRecord.bathrooms,
            squareFootage: baseRecord.squareFootage,
            askingPrice: baseRecord.askingPrice,
            listingLastSeenAt: baseRecord.listingLastSeenAt,
            avmPrice: baseRecord.avmPrice,
            avmLow: baseRecord.avmLow,
            avmHigh: baseRecord.avmHigh,
          },
          comparablesSummary: baseRecord.comparablesSummary,
          priceGap: verifiedPriceGap,
        });

    const verifiedProperty: PropertyDetailRecord = {
      ...baseRecord,
      priceGap: verifiedPriceGap,
      accessibility,
      nearbyEnvironmentalCount,
      contraryEvidence,
    };

    return {
      property: verifiedProperty,
      accessibility,
      environmentalRecords,
      isSyntheticDemo: effectiveSynthetic,
      geospatialFetchedAt: spatialEval?.fetchedAt ?? null,
    };
  };

  const explainModule =
    options.explainModule ??
    createExplainModule(config, {
      ...options.explainDeps,
      resolvePropertyContext:
        options.explainDeps?.resolvePropertyContext ??
        defaultResolvePropertyContext,
    });

  // Ensure `/api/properties/:propertyId/avm` responses also carry cached area accessibility
  // when invoked via `propertySnapshot` prior to `/api/properties/search`.
  app.use('/api/properties', (req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'POST' || !req.path.endsWith('/avm')) {
      next();
      return;
    }
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      if (
        res.statusCode === 200 &&
        body &&
        typeof body === 'object' &&
        'property' in body &&
        'sessionId' in body
      ) {
        const avmBody = body as PropertyAvmResponse;
        if (avmBody.property && avmBody.property.accessibility === null) {
          const sess = propertyModule.sessionStore.getSession(avmBody.sessionId);
          if (sess?.analysisArea) {
            const scored = geospatialModule.scorePointForArea(
              sess.analysisArea.areaId,
              {
                lat: avmBody.property.latitude,
                lng: avmBody.property.longitude,
              }
            );
            if (scored) {
              const enriched: PropertyDetailRecord = {
                ...avmBody.property,
                accessibility: scored.accessibility,
                nearbyEnvironmentalCount: scored.nearbyEnvironmentalCount,
              };
              propertyModule.sessionStore.recordPropertyDetail(
                avmBody.sessionId,
                enriched
              );
              return originalJson({
                ...avmBody,
                property: enriched,
              });
            }
          }
        }
      }
      return originalJson(body);
    }) as Response['json'];
    next();
  });

  // ==========================================================================
  // Domain Router Mounts
  // ==========================================================================

  if (options.apiRouter) {
    app.use('/api', options.apiRouter);
  }
  app.use('/api/regions', options.regionsRouter ?? propertyModule.regionsRouter);
  app.use(
    '/api/geospatial',
    options.geospatialRouter ?? geospatialModule.geospatialRouter
  );
  app.use(
    '/api/properties',
    options.propertiesRouter ?? propertyModule.propertiesRouter
  );
  app.use(
    '/api/sessions',
    options.sessionsRouter ?? propertyModule.sessionsRouter
  );
  app.use('/api/explain', options.explainRouter ?? explainModule.explainRouter);

  // Unknown `/api/*` fallback
  app.use('/api', (req: Request, res: Response) => {
    const clientRequestSeq = extractValidClientRequestSeq(
      req.body?.clientRequestSeq
    );

    const payload: ApiErrorResponse = {
      error: {
        code: 'NOT_FOUND',
        message: `API endpoint not found: ${req.method} ${req.originalUrl}`,
        uiState: 'empty',
        retryable: false,
      },
      budget: null,
      ...(clientRequestSeq !== undefined ? { clientRequestSeq } : {}),
    };
    res.status(404).json(payload);
  });

  // ==========================================================================
  // Static Built Client Serving (`dist/client`) for Production / Cloud Run
  // ==========================================================================

  const clientDistDir =
    options.clientDistDir ?? path.resolve(process.cwd(), 'dist', 'client');
  const indexHtmlPath = path.join(clientDistDir, 'index.html');

  if (fs.existsSync(indexHtmlPath)) {
    app.use(express.static(clientDistDir, { index: false, maxAge: '1h' }));
    app.get('*', (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith('/api/')) {
        next();
        return;
      }
      res.sendFile(indexHtmlPath);
    });
  }

  // ==========================================================================
  // Sanitized Central Error Handler (Never Leaks Secrets or Stack Traces)
  // ==========================================================================

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    const clientRequestSeq = extractValidClientRequestSeq(
      req.body?.clientRequestSeq
    );

    if (
      err &&
      typeof err === 'object' &&
      'type' in err &&
      (err as { type?: string }).type === 'entity.parse.failed'
    ) {
      const badJsonResponse: ApiErrorResponse = {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Malformed JSON request body.',
          uiState: 'recovery',
          retryable: false,
        },
        budget: null,
        ...(clientRequestSeq !== undefined ? { clientRequestSeq } : {}),
      };
      res.status(400).json(badJsonResponse);
      return;
    }

    if (
      err &&
      typeof err === 'object' &&
      'type' in err &&
      (err as { type?: string }).type === 'entity.too.large'
    ) {
      const tooLargeResponse: ApiErrorResponse = {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request payload exceeds the 256 KiB maximum size.',
          uiState: 'recovery',
          retryable: false,
        },
        budget: null,
        ...(clientRequestSeq !== undefined ? { clientRequestSeq } : {}),
      };
      res.status(413).json(tooLargeResponse);
      return;
    }

    const rawMessage =
      err instanceof Error
        ? err.message
        : 'An unexpected server error occurred.';
    const safeMessage = redactSecretsFromText(rawMessage, config);

    if (config.nodeEnv !== 'test') {
      console.error(
        `[foreal-estate] request error on ${req.method} ${req.path}: ${safeMessage}`
      );
    }

    const fallbackResponse: ApiErrorResponse = {
      error: {
        code: 'INTERNAL_ERROR',
        message: 'An unexpected internal error occurred.',
        uiState: 'recovery',
        retryable: true,
      },
      budget: null,
      ...(clientRequestSeq !== undefined ? { clientRequestSeq } : {}),
    };
    res.status(500).json(fallbackResponse);
  };

  app.use(errorHandler);

  return app;
}
