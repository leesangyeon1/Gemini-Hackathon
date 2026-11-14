/**
 * Explain Router (`src/server/explain/router.ts`)
 *
 * Express HTTP router exposing `POST /api/explain`.
 * Enforces strict request body validation via Zod `ExplainRequestSchema`,
 * delegates to `ExplainService`, and returns validated `ExplainResponse`.
 */

import { Router, type Request, type Response } from 'express';
import {
  ExplainRequestSchema,
  ExplainResponseSchema,
  extractValidClientRequestSeq,
} from '../../shared/schemas';
import type { ApiErrorResponse } from '../../shared/types';
import type { ServerConfig } from '../config';
import { redactSecretsFromText } from '../config';
import type { ExplainService } from './explainService';

export interface CreateExplainRouterOptions {
  readonly config: ServerConfig;
  readonly explainService: ExplainService;
}

export function createExplainRouter(options: CreateExplainRouterOptions): Router {
  const { config, explainService } = options;
  const router = Router();

  router.post('/', async (req: Request, res: Response) => {
    const safeClientSeq = extractValidClientRequestSeq(req.body?.clientRequestSeq);

    // 1. Request Body Validation
    const parsedRequest = ExplainRequestSchema.safeParse(req.body);
    if (!parsedRequest.success) {
      const errorResponse: ApiErrorResponse = {
        error: {
          code: 'VALIDATION_ERROR',
          message: parsedRequest.error.errors
            .map((e) => `${e.path.join('.')}: ${e.message}`)
            .join('; '),
          uiState: 'recovery',
          retryable: false,
        },
        budget: null,
        ...(safeClientSeq !== undefined ? { clientRequestSeq: safeClientSeq } : {}),
      };
      res.status(400).json(errorResponse);
      return;
    }

    const validRequest = parsedRequest.data;

    try {
      // 2. Delegate to Grounded Explain Service
      const explainResult = await explainService.explainProperty(validRequest);

      if (!explainResult) {
        const notFoundResponse: ApiErrorResponse = {
          error: {
            code: 'NOT_FOUND',
            message: `Property listing "${validRequest.propertyId}" could not be resolved from authoritative server state.`,
            uiState: 'empty',
            retryable: false,
          },
          budget: null,
          ...(validRequest.clientRequestSeq !== undefined
            ? { clientRequestSeq: validRequest.clientRequestSeq }
            : {}),
        };
        res.status(404).json(notFoundResponse);
        return;
      }

      // 3. Response Schema Validation & Return
      const verifiedResponse = ExplainResponseSchema.parse(explainResult);
      res.status(200).json(verifiedResponse);
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : 'Failed to generate explanation.';
      const safeMessage = redactSecretsFromText(rawMessage, config);

      if (config.nodeEnv !== 'test') {
        console.error(`[foreal-estate] /api/explain uncaught error: ${safeMessage}`);
      }

      const internalErrorResponse: ApiErrorResponse = {
        error: {
          code: 'INTERNAL_ERROR',
          message: safeMessage,
          uiState: 'recovery',
          retryable: true,
        },
        budget: null,
        ...(validRequest.clientRequestSeq !== undefined
          ? { clientRequestSeq: validRequest.clientRequestSeq }
          : {}),
      };
      res.status(500).json(internalErrorResponse);
    }
  });

  return router;
}
