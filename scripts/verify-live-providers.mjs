#!/usr/bin/env node
/**
 * Live Provider & Gemini Model Verification Probe (`scripts/verify-live-providers.mjs`)
 *
 * SECURITY INVARIANT:
 * Loads optional `.env` via Node's built-in `process.loadEnvFile()` and NEVER prints
 * credential values, prefixes, suffixes, or unsanitized error bodies.
 *
 * Default behavior spends ZERO RentCast credits; pass `--probe-rentcast` explicitly
 * to execute a single `limit=1` `/v1/listings/sale` check.
 */

import fs from 'node:fs';
import path from 'node:path';
import { GoogleGenAI } from '@google/genai';

function maybeLoadDotEnv() {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath) && typeof process.loadEnvFile === 'function') {
    try {
      process.loadEnvFile(envPath);
    } catch {
      // Ignore optional .env parse warnings; individual var checks handle missing values
    }
  }
}

function readSecret(name) {
  const raw = process.env[name];
  if (typeof raw !== 'string') return '';
  return raw.trim();
}

function scrubSecrets(text, secrets) {
  let clean = String(text || '');
  for (const val of secrets) {
    if (val && val.length >= 4) {
      clean = clean.split(val).join('[REDACTED]');
      clean = clean.split(encodeURIComponent(val)).join('[REDACTED]');
    }
  }
  return clean;
}

function classifyGeminiError(err, secrets) {
  const rawMsg = err instanceof Error ? err.message : String(err);
  const safeMsg = scrubSecrets(rawMsg, secrets);
  const status =
    typeof err === 'object' && err !== null && 'status' in err
      ? Number(err.status)
      : undefined;

  const lower = safeMsg.toLowerCase();

  if (status === 401 || lower.includes('api key not valid') || lower.includes('unauthenticated')) {
    return {
      category: 'AUTH_ERROR (401)',
      detail: 'API key rejected or invalid (401/UNAUTHENTICATED).',
    };
  }

  if (
    status === 429 &&
    (lower.includes('limit: 0') ||
      lower.includes('limit:0') ||
      lower.includes('failed_precondition') ||
      lower.includes('billing'))
  ) {
    return {
      category: 'BILLING_REQUIRED (429 limit: 0 / FAILED_PRECONDITION)',
      detail: 'Project/key has zero free-tier quota or requires active Cloud Billing.',
    };
  }

  if (lower.includes('failed_precondition') || (status === 400 && lower.includes('billing'))) {
    return {
      category: 'BILLING_REQUIRED (429 limit: 0 / FAILED_PRECONDITION)',
      detail: 'Precondition/billing activation required before calling this model.',
    };
  }

  if (status === 429 || lower.includes('resource_exhausted') || lower.includes('quota')) {
    return {
      category: 'QUOTA_EXHAUSTED (429)',
      detail: 'Rate limit or quota exhausted (429/RESOURCE_EXHAUSTED).',
    };
  }

  if (
    status === 403 ||
    status === 404 ||
    lower.includes('not found') ||
    lower.includes('permission_denied') ||
    lower.includes('not supported')
  ) {
    return {
      category: `ENTITLEMENT_OR_MODEL_UNAVAILABLE (${status ?? '403/404'})`,
      detail: 'Model unavailable, deprecated, or lacking entitlement for this API key.',
    };
  }

  return {
    category: `OTHER_ERROR (${status ?? 'unknown'})`,
    detail: safeMsg.slice(0, 200),
  };
}

async function probeGeminiModel(ai, model, secrets) {
  try {
    const response = await ai.models.generateContent({
      model,
      contents: 'Reply with OK.',
      config: {
        maxOutputTokens: 1,
        temperature: 0,
      },
    });
    const hasText = typeof response?.text === 'string' && response.text.trim().length > 0;
    console.log(
      `  - ${model}: OK (generateContent succeeded${hasText ? ', 1-token output received' : ''})`
    );
    return true;
  } catch (err) {
    const classified = classifyGeminiError(err, secrets);
    console.log(`  - ${model}: ${classified.category} — ${classified.detail}`);
    return false;
  }
}

async function probeRentCast(apiKey, secrets) {
  const url = 'https://api.rentcast.io/v1/listings/sale?city=Austin&state=TX&limit=1';
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'X-Api-Key': apiKey,
      },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const data = await res.json();
      const count = Array.isArray(data) ? data.length : 0;
      console.log(`RENTCAST_API_KEY: OK (HTTP ${res.status}, sample count=${count})`);
      return true;
    }
    if (res.status === 401 || res.status === 403) {
      console.log(`RENTCAST_API_KEY: AUTH_ERROR (HTTP ${res.status})`);
      return false;
    }
    if (res.status === 429) {
      console.log(`RENTCAST_API_KEY: QUOTA_OR_RATE_LIMITED (HTTP 429)`);
      return false;
    }
    console.log(`RENTCAST_API_KEY: UPSTREAM_HTTP_${res.status}`);
    return false;
  } catch (err) {
    const msg = scrubSecrets(err instanceof Error ? err.message : String(err), secrets);
    console.log(`RENTCAST_API_KEY: NETWORK_OR_TIMEOUT_ERROR (${msg.slice(0, 120)})`);
    return false;
  }
}

async function main() {
  maybeLoadDotEnv();

  const shouldProbeRentCast = process.argv.includes('--probe-rentcast');
  const geminiKey = readSecret('GEMINI_API_KEY');
  const rentcastKey = readSecret('RENTCAST_API_KEY');
  const mapsBrowserKey = readSecret('GOOGLE_MAPS_BROWSER_KEY');
  const placesServerKey = readSecret('GOOGLE_PLACES_SERVER_KEY');

  const secrets = [geminiKey, rentcastKey, mapsBrowserKey, placesServerKey];

  const primaryModel = readSecret('GEMINI_EXPLAIN_MODEL') || 'gemini-4-hydrogen';
  const fallbackModel = readSecret('GEMINI_EXPLAIN_FALLBACK_MODEL') || 'gemini-2.5-flash';

  console.log('=== Foreal-Estate Live Provider & Model Probe ===');
  console.log(`GOOGLE_MAPS_BROWSER_KEY: ${mapsBrowserKey ? 'SET (browser key)' : 'MISSING (not probed)'}`);
  console.log(
    `GOOGLE_PLACES_SERVER_KEY: ${placesServerKey ? 'SET (optional)' : 'MISSING (optional)'}`
  );

  if (!rentcastKey) {
    console.log('RENTCAST_API_KEY: MISSING (not probed)');
  } else if (!shouldProbeRentCast) {
    console.log('RENTCAST_API_KEY: SET (not probed — pass --probe-rentcast to spend 1 call)');
  } else {
    await probeRentCast(rentcastKey, secrets);
  }

  if (!geminiKey) {
    console.log('GEMINI_API_KEY: MISSING (not probed)');
  } else {
    console.log(`GEMINI_API_KEY: SET — probing models (${primaryModel}, ${fallbackModel})...`);
    const ai = new GoogleGenAI({ apiKey: geminiKey });
    await probeGeminiModel(ai, primaryModel, secrets);
    if (fallbackModel !== primaryModel) {
      await probeGeminiModel(ai, fallbackModel, secrets);
    }
  }
}

main().catch((err) => {
  console.error('[verify-live-providers] Unexpected failure:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
