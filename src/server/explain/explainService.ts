/**
 * Grounded Gemini Explanation Service (`src/server/explain/explainService.ts`)
 *
 * Coordinates server-resolved property valuation, OpenStreetMap accessibility,
 * and EPA environmental records to produce strictly grounded explanations via
 * the official `@google/genai` SDK.
 *
 * INVARIANTS:
 * 1. Strict Server Authority: Valuations and spatial metrics are resolved from server state;
 *    unverified client calculations are never trusted.
 * 2. Primary Model: `config.geminiExplainModel` (default `gemini-4-hydrogen`, thinking budget 1024).
 *    Fallback Model: `config.geminiExplainFallbackModel` (default `gemini-2.5-flash`).
 * 3. Graceful Degradation: Missing `GEMINI_API_KEY`, API errors, timeouts, or validation
 *    failures return HTTP 200 with `explanationAvailable: false`, `fallbackUsed: true`,
 *    and a deterministic server-computed factual summary.
 */

import { GoogleGenAI, Type } from '@google/genai';
import type {
  AccessibilityResult,
  EnvironmentalRecord,
  ExplainRequest,
  ExplainResponse,
  PreferenceProfile,
  PropertyDetailRecord,
} from '../../shared/types';
import type { ServerConfig } from '../config';
import { redactSecretsFromText } from '../config';
import { computePriceGap } from '../geospatial/scoring';
import { buildEvidenceCatalog, type DeterministicFacts } from './evidenceBuilder';
import { buildExplainPrompt } from './promptBuilder';
import { validateGeminiExplainPayload } from './validator';

export interface PropertyContextResolution {
  readonly property: PropertyDetailRecord;
  readonly accessibility: AccessibilityResult | null;
  readonly environmentalRecords: readonly EnvironmentalRecord[];
  readonly isSyntheticDemo: boolean;
  readonly geospatialFetchedAt?: string | null;
}

export interface ExplainServiceDependencies {
  readonly resolvePropertyContext?: (
    sessionId: string,
    propertyId: string,
    preferences: PreferenceProfile,
    useSyntheticDemo?: boolean
  ) => Promise<PropertyContextResolution | null>;
  /** Optional mock or injected AI client for deterministic testing */
  readonly aiClient?: {
    models: {
      generateContent: (params: any) => Promise<any>;
    };
  };
}

export interface ExplainService {
  explainProperty: (request: ExplainRequest) => Promise<ExplainResponse | null>;
}

const DEFAULT_TIMEOUT_MS = 12000;

function generateDeterministicSummary(
  property: PropertyDetailRecord,
  facts: DeterministicFacts
): string {
  const askStr =
    facts.askingPrice !== null ? `$${facts.askingPrice.toLocaleString('en-US')}` : 'an unlisted price';
  const avmStr =
    facts.avmPrice !== null ? `$${facts.avmPrice.toLocaleString('en-US')}` : 'uncalculated';
  const gapStr =
    facts.gapPct !== null ? `${facts.gapPct > 0 ? '+' : ''}${facts.gapPct.toFixed(1)}%` : 'N/A';
  const scoreStr =
    facts.accessibilityScore !== null
      ? `${facts.accessibilityScore.toFixed(1)}/100`
      : 'uncalculated';

  let rangeDesc = 'statistical valuation position is pending';
  if (facts.rangePosition === 'in_range') {
    rangeDesc = `asking price falls within the RentCast AVM confidence range [$${facts.avmLow?.toLocaleString('en-US')}, $${facts.avmHigh?.toLocaleString('en-US')}], reflecting expected statistical dispersion`;
  } else if (facts.rangePosition === 'below_estimate_range_candidate') {
    rangeDesc = `asking price is below the RentCast AVM confidence lower bound ($${facts.avmLow?.toLocaleString('en-US')}), marking a candidate signal for focused human due diligence`;
  } else if (facts.rangePosition === 'above_estimate_range_candidate') {
    rangeDesc = `asking price exceeds the RentCast AVM confidence upper bound ($${facts.avmHigh?.toLocaleString('en-US')}), which may reflect uncaptured recent renovations or premium lot attributes`;
  }

  return `${property.formattedAddress} is actively listed at ${askStr} compared to the RentCast AVM point estimate of ${avmStr} (${gapStr} price gap). The ${rangeDesc}. Amenity accessibility evaluates to ${scoreStr} based on user convenience preferences.`;
}

export function createExplainService(
  config: ServerConfig,
  deps: ExplainServiceDependencies = {}
): ExplainService {
  let aiClientInstance = deps.aiClient ?? null;

  function getAiClient(): { models: { generateContent: (params: any) => Promise<any> } } | null {
    if (aiClientInstance) {
      return aiClientInstance;
    }
    if (!config.secrets.geminiApiKey) {
      return null;
    }
    aiClientInstance = new GoogleGenAI({ apiKey: config.secrets.geminiApiKey });
    return aiClientInstance;
  }

  return {
    async explainProperty(request: ExplainRequest): Promise<ExplainResponse | null> {
      const { sessionId, propertyId, preferences, useSyntheticDemo, clientRequestSeq } = request;

      // 1. Strict Server Authority: Resolve context via server dependency if available
      let resolvedContext: PropertyContextResolution | null = null;

      if (typeof deps.resolvePropertyContext === 'function') {
        resolvedContext = await deps.resolvePropertyContext(
          sessionId,
          propertyId,
          preferences,
          useSyntheticDemo
        );
      } else if (request.propertyContext) {
        // Fallback for standalone/test usage: Never trust unverified client priceGap calculations
        const rawProp = request.propertyContext;
        const verifiedPriceGap = computePriceGap({
          askingPrice: rawProp.askingPrice,
          avmPrice: rawProp.avmPrice,
          avmLow: rawProp.avmLow,
          avmHigh: rawProp.avmHigh,
        });

        const verifiedProp: PropertyDetailRecord = {
          ...rawProp,
          priceGap: verifiedPriceGap,
        };

        resolvedContext = {
          property: verifiedProp,
          accessibility: request.accessibilityContext ?? null,
          environmentalRecords: request.environmentalRecords ?? [],
          isSyntheticDemo: Boolean(
            useSyntheticDemo ||
              config.enableSyntheticDemoMode ||
              rawProp.dataProvenance === 'synthetic_demo'
          ),
        };
      }

      if (!resolvedContext) {
        return null;
      }

      const { property, accessibility, environmentalRecords, isSyntheticDemo, geospatialFetchedAt } =
        resolvedContext;

      // 2. Build Authoritative Evidence Catalog & Deterministic Facts
      const catalogResult = buildEvidenceCatalog({
        property,
        accessibility,
        environmentalRecords,
        preferences,
        isSyntheticDemo,
        geospatialFetchedAt,
      });

      const { evidenceCatalog, facts, dataAsOf } = catalogResult;

      // 3. Helper to build the deterministic fallback response
      function buildFallbackResponse(reason: string): ExplainResponse {
        const safeReason = redactSecretsFromText(reason, config);
        return {
          explanationAvailable: false,
          fallbackUsed: true,
          unavailableReason: safeReason,
          modelUsed: null,
          isSyntheticDemo,
          summary: generateDeterministicSummary(property, facts),
          evidenceIds: evidenceCatalog.map((e) => e.evidenceId),
          evidenceCatalog,
          positiveFactors: [...facts.positiveFactors],
          contraryAndUncertaintyFactors: [...facts.contraryAndUncertaintyFactors],
          limitations: [...facts.limitations],
          dataAsOf,
          clientRequestSeq,
        };
      }

      // 4. Check API Key availability
      const ai = getAiClient();
      if (!ai) {
        return buildFallbackResponse(
          'GEMINI_API_KEY is not configured on the server; deterministic factual explanation returned.'
        );
      }

      // 5. Build Grounded Prompt with Injection Neutralization
      const { systemInstruction, promptContents } = buildExplainPrompt({
        property,
        catalog: evidenceCatalog,
        facts,
        isSyntheticDemo,
      });

      // Target JSON Schema using official @google/genai Type enum
      const responseSchema = {
        type: Type.OBJECT,
        properties: {
          summary: { type: Type.STRING },
          evidenceIds: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          positiveFactors: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          contraryAndUncertaintyFactors: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
          limitations: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: [
          'summary',
          'evidenceIds',
          'positiveFactors',
          'contraryAndUncertaintyFactors',
          'limitations',
        ],
      };

      const primaryModel = config.geminiExplainModel;
      const fallbackModel = config.geminiExplainFallbackModel;

      async function invokeModel(
        modelName: string,
        useThinking: boolean
      ): Promise<{ text: string | undefined; modelUsed: string }> {
        const generatePromise = ai!.models.generateContent({
          model: modelName,
          contents: promptContents,
          config: {
            systemInstruction,
            responseMimeType: 'application/json',
            responseSchema,
            ...(useThinking ? { thinkingConfig: { thinkingBudget: 1024 } } : {}),
          },
        });

        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(() => reject(new Error(`Gemini model ${modelName} timed out after ${DEFAULT_TIMEOUT_MS}ms`)), DEFAULT_TIMEOUT_MS);
        });

        const response = await Promise.race([generatePromise, timeoutPromise]);
        return { text: response?.text, modelUsed: modelName };
      }

      let rawResponseText: string | undefined;
      let effectiveModelUsed: string | null = null;
      let callErrorReason: string | null = null;

      // 6. Attempt primary model (gemini-4-hydrogen with thinkingConfig)
      try {
        const primaryResult = await invokeModel(primaryModel, true);
        rawResponseText = primaryResult.text;
        effectiveModelUsed = primaryResult.modelUsed;
      } catch (primaryErr) {
        const errMessage = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
        const safeErr = redactSecretsFromText(errMessage, config);
        if (config.nodeEnv !== 'test') {
          console.warn(`[foreal-estate] Gemini primary model (${primaryModel}) failed: ${safeErr}. Attempting fallback model (${fallbackModel})...`);
        }

        // 7. Clean documented fallback to supported Flash model
        try {
          const fallbackResult = await invokeModel(fallbackModel, false);
          rawResponseText = fallbackResult.text;
          effectiveModelUsed = fallbackResult.modelUsed;
        } catch (fallbackErr) {
          const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          const safeFallbackMsg = redactSecretsFromText(fallbackMsg, config);
          callErrorReason = `Gemini generation failed: ${safeFallbackMsg}`;
        }
      }

      if (!rawResponseText) {
        return buildFallbackResponse(callErrorReason ?? 'Gemini model returned empty response.');
      }

      // 8. Strict Post-Generation Grounding, Numerical, and Claim Validation
      const validationResult = validateGeminiExplainPayload(
        rawResponseText,
        evidenceCatalog,
        facts
      );

      if (!validationResult.valid) {
        if (config.nodeEnv !== 'test') {
          console.warn(`[foreal-estate] Gemini explanation rejected by post-generation validator (${validationResult.errorType}): ${validationResult.reason}`);
        }
        return buildFallbackResponse(
          `Grounded validation rejected LLM output (${validationResult.errorType}): ${validationResult.reason}`
        );
      }

      const payload = validationResult.payload;

      return {
        explanationAvailable: true,
        fallbackUsed: false,
        unavailableReason: null,
        modelUsed: effectiveModelUsed,
        isSyntheticDemo,
        summary: payload.summary,
        evidenceIds: payload.evidenceIds,
        evidenceCatalog,
        positiveFactors: payload.positiveFactors,
        contraryAndUncertaintyFactors: payload.contraryAndUncertaintyFactors,
        limitations: payload.limitations,
        dataAsOf,
        clientRequestSeq,
      };
    },
  };
}
