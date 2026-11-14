/**
 * Grounded Gemini Explanation Module (`src/server/explain/index.ts`)
 *
 * Exposes factory functions and domain utilities for generating strictly grounded,
 * server-authorized explanations of property valuations, accessibility scores,
 * and environmental due-diligence records.
 */

import type { Router } from 'express';
import type { ServerConfig } from '../config';
import {
  createExplainService,
  type ExplainService,
  type ExplainServiceDependencies,
  type PropertyContextResolution,
} from './explainService';
import { createExplainRouter } from './router';

export * from './evidenceBuilder';
export * from './promptBuilder';
export * from './validator';
export * from './explainService';
export * from './router';

export interface ExplainModule {
  readonly explainService: ExplainService;
  readonly explainRouter: Router;
}

/**
 * Creates and wires the complete grounded explanation module for Foreal-Estate.
 */
export function createExplainModule(
  config: ServerConfig,
  deps: ExplainServiceDependencies = {}
): ExplainModule {
  const explainService = createExplainService(config, deps);
  const explainRouter = createExplainRouter({ config, explainService });

  return {
    explainService,
    explainRouter,
  };
}
