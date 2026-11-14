/**
 * Post-Generation Explain Output Validator (`src/server/explain/validator.ts`)
 *
 * Enforces strict grounding, numerical fidelity, and claim guardrails on raw
 * JSON output returned by Google Gemini models.
 *
 * REJECTION CRITERIA:
 * 1. Malformed JSON or schema non-conformance (Zod `GeminiStructuredExplainPayloadSchema`).
 * 2. Hallucinated `evidenceId` not present in authoritative server catalog.
 * 3. Prohibited causal claims (e.g. fast-food / McDonald's causing property appreciation).
 * 4. Prohibited demographic, racial, crime, or protected-class claims.
 * 5. Prohibited certainty claims (e.g. "guaranteed profit", "proven undervaluation").
 * 6. Hallucinated or contradictory dollar values and percentages not in server records.
 */

import { GeminiStructuredExplainPayloadSchema } from '../../shared/schemas';
import type { ExplainEvidenceItem } from '../../shared/types';
import type { DeterministicFacts } from './evidenceBuilder';

export type ExplainValidationErrorType =
  | 'EMPTY_RESPONSE'
  | 'JSON_PARSE_ERROR'
  | 'SCHEMA_ERROR'
  | 'HALLUCINATED_EVIDENCE_ID'
  | 'PROHIBITED_CLAIM'
  | 'NUMERICAL_HALLUCINATION';

export interface ValidExplainPayload {
  readonly summary: string;
  readonly evidenceIds: string[];
  readonly positiveFactors: string[];
  readonly contraryAndUncertaintyFactors: string[];
  readonly limitations: string[];
}

export type ExplainValidationResult =
  | {
      readonly valid: true;
      readonly payload: ValidExplainPayload;
    }
  | {
      readonly valid: false;
      readonly errorType: ExplainValidationErrorType;
      readonly reason: string;
    };

/**
 * Extracts and parses JSON from raw LLM text, safely unwrapping markdown code fences if present.
 */
function extractAndParseJson(rawText: string): unknown {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error('LLM returned empty or whitespace-only response.');
  }

  // Remove markdown code fences if present: ```json ... ``` or ``` ... ```
  let cleaned = trimmed;
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
  }

  // If there are leading/trailing non-JSON characters, attempt to slice outermost braces
  const firstBrace = cleaned.indexOf('{');
  const lastBrace = cleaned.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    cleaned = cleaned.substring(firstBrace, lastBrace + 1);
  }

  return JSON.parse(cleaned);
}

const FAST_FOOD_PATTERN = /\b(fast[- ]?food|mcdonald'?s|burger[- ]?king|wendy'?s|taco[- ]?bell|subway|drive[- ]?thru)\b/i;
const CAUSAL_APPRECIATION_PATTERN =
  /\b(causes?|drives?|boosts?|increases?|enhances?|appreciat(ion|e)|growth in (value|price)|capital growth|investment yield)\b/i;

const DEMOGRAPHIC_PATTERN =
  /\b(race|racial|ethnic|ethnicity|demographic(s)?|crime[- ]?rate|safe[- ]?neighborhood|dangerous[- ]?neighborhood|bad[- ]?neighborhood|gentrif(ying|ication)|white|black|hispanic|asian|income[- ]?bracket|class of people)\b/i;

const GUARANTEED_PROFIT_PATTERN =
  /\b(proven undervaluation|guaranteed (profit|return|equity|yield)|risk[- ]?free|surefire deal|guaranteed appreciation)\b/i;

/**
 * Checks text for prohibited causal, demographic, or guaranteed-profit claims.
 */
function detectProhibitedClaims(text: string): { prohibited: boolean; reason?: string } {
  // Check fast food causal appreciation claim per sentence
  const sentences = text.split(/(?<=[.?!])\s+/);
  for (const sentence of sentences) {
    if (FAST_FOOD_PATTERN.test(sentence) && CAUSAL_APPRECIATION_PATTERN.test(sentence)) {
      return {
        prohibited: true,
        reason: 'Claim asserts fast-food presence causes or drives property value appreciation.',
      };
    }
  }

  if (DEMOGRAPHIC_PATTERN.test(text)) {
    return {
      prohibited: true,
      reason: 'Claim contains prohibited demographic, racial, crime, or protected-class assertions.',
    };
  }

  if (GUARANTEED_PROFIT_PATTERN.test(text)) {
    return {
      prohibited: true,
      reason: 'Claim asserts guaranteed profit, equity, or proven undervaluation.',
    };
  }

  return { prohibited: false };
}

/**
 * Validates dollar amounts and percentages referenced in LLM text against server-authoritative numbers.
 */
function validateNumericalClaims(
  allText: string,
  facts: DeterministicFacts
): { valid: boolean; reason?: string } {
  const allowed = facts.allowedNumbers;

  // Extract dollar amounts (e.g. $900,000, $1,000,000, $850k)
  const dollarRegex = /\$([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]+)?|[0-9]+(?:\.[0-9]+)?)/g;
  let dollarMatch: RegExpExecArray | null;

  while ((dollarMatch = dollarRegex.exec(allText)) !== null) {
    const rawVal = dollarMatch[1].replace(/,/g, '');
    const num = Number.parseFloat(rawVal);
    if (!Number.isFinite(num)) {
      continue;
    }

    // Ignore small nominal amounts like $0 or standard rounding differences <= 1
    if (num <= 10) {
      continue;
    }

    let isMatch = false;
    for (const validNum of allowed) {
      if (Math.abs(num - validNum) <= 1 || Math.abs(num - validNum) / validNum < 0.005) {
        isMatch = true;
        break;
      }
    }

    if (!isMatch) {
      return {
        valid: false,
        reason: `Referenced dollar amount $${dollarMatch[1]} does not correspond to any server-computed valuation or property figure.`,
      };
    }
  }

  // Extract percentages (e.g. 10.0%, +10%, 82.4%)
  const percentRegex = /([-+]?[0-9]+(?:\.[0-9]+)?)\s*%/g;
  let percentMatch: RegExpExecArray | null;

  while ((percentMatch = percentRegex.exec(allText)) !== null) {
    const rawVal = percentMatch[1];
    const num = Number.parseFloat(rawVal);
    if (!Number.isFinite(num)) {
      continue;
    }

    let isMatch = false;
    for (const validNum of allowed) {
      if (Math.abs(num - validNum) <= 0.15 || Math.abs(Math.abs(num) - Math.abs(validNum)) <= 0.15) {
        isMatch = true;
        break;
      }
    }

    // Allow standard 100% or 0% boundary mentions
    if (num === 100 || num === 0) {
      isMatch = true;
    }

    if (!isMatch) {
      return {
        valid: false,
        reason: `Referenced percentage ${percentMatch[0]} does not match server-calculated price gap or accessibility intensity.`,
      };
    }
  }

  return { valid: true };
}

/**
 * Authoritative validator function for Gemini-generated structured explanations.
 */
export function validateGeminiExplainPayload(
  rawText: string,
  catalog: readonly ExplainEvidenceItem[],
  facts: DeterministicFacts
): ExplainValidationResult {
  // 1. JSON parsing
  let parsed: unknown;
  try {
    parsed = extractAndParseJson(rawText);
  } catch (err) {
    return {
      valid: false,
      errorType: 'JSON_PARSE_ERROR',
      reason: err instanceof Error ? err.message : 'Failed to parse JSON from LLM output.',
    };
  }

  // 2. Schema validation
  const schemaResult = GeminiStructuredExplainPayloadSchema.safeParse(parsed);
  if (!schemaResult.success) {
    return {
      valid: false,
      errorType: 'SCHEMA_ERROR',
      reason: schemaResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
    };
  }

  const payload = schemaResult.data;

  // 3. Grounded Evidence ID Validation
  const validEvidenceIds = new Set(catalog.map((c) => c.evidenceId));
  for (const citedId of payload.evidenceIds) {
    if (!validEvidenceIds.has(citedId)) {
      return {
        valid: false,
        errorType: 'HALLUCINATED_EVIDENCE_ID',
        reason: `Cited evidence ID "${citedId}" does not exist in authoritative server catalog.`,
      };
    }
  }

  // 4. Prohibited Claims Check across all generated fields
  const allGeneratedText = [
    payload.summary,
    ...payload.positiveFactors,
    ...payload.contraryAndUncertaintyFactors,
    ...payload.limitations,
  ].join(' ');

  const claimCheck = detectProhibitedClaims(allGeneratedText);
  if (claimCheck.prohibited) {
    return {
      valid: false,
      errorType: 'PROHIBITED_CLAIM',
      reason: claimCheck.reason ?? 'Prohibited claim detected in explanation output.',
    };
  }

  // 5. Numerical Grounding & Hallucination Check
  const numCheck = validateNumericalClaims(allGeneratedText, facts);
  if (!numCheck.valid) {
    return {
      valid: false,
      errorType: 'NUMERICAL_HALLUCINATION',
      reason: numCheck.reason ?? 'Hallucinated numerical figure contradicted server authority.',
    };
  }

  return {
    valid: true,
    payload,
  };
}
