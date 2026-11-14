import '@testing-library/jest-dom/vitest';
import http from 'node:http';
import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { type Express } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/client/App';
import { createApp } from '../../src/server/app';
import { loadServerConfig } from '../../src/server/config';

async function bridgeFetchToExpress(
  app: Express,
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  if (init?.signal?.aborted) {
    const abortErr = new Error('The operation was aborted.');
    abortErr.name = 'AbortError';
    throw abortErr;
  }

  const rawUrl =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.pathname + input.search
        : input.url;
  const parsedUrl = rawUrl.startsWith('http') ? new URL(rawUrl) : new URL(rawUrl, 'http://localhost');
  const method = (init?.method ?? 'GET').toUpperCase();
  const bodyStr = typeof init?.body === 'string' ? init.body : undefined;
  const bodyBuf = bodyStr !== undefined ? Buffer.from(bodyStr, 'utf8') : undefined;

  return new Promise<Response>((resolve, reject) => {
    const onAbort = () => {
      const abortErr = new Error('The operation was aborted.');
      abortErr.name = 'AbortError';
      reject(abortErr);
    };
    init?.signal?.addEventListener('abort', onAbort, { once: true });

    const reqSocket = new Duplex({
      read() {},
      write(_chunk, _encoding, cb) {
        cb();
      },
    });
    Object.assign(reqSocket, { remoteAddress: '127.0.0.1' });

    const wireChunks: Buffer[] = [];
    const resSocket = new Duplex({
      read() {},
      write(chunk, encoding, cb) {
        wireChunks.push(
          Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(String(chunk), typeof encoding === 'string' ? encoding : 'utf8')
        );
        cb();
      },
    });
    Object.assign(resSocket, { writable: true });

    const req = new http.IncomingMessage(reqSocket as unknown as Socket);
    req._read = () => {};
    req.method = method;
    req.url = parsedUrl.pathname + parsedUrl.search;

    const headers: Record<string, string> = { host: 'localhost' };
    if (bodyBuf !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(bodyBuf.byteLength);
    }
    if (init?.headers) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => {
        headers[k.toLowerCase()] = v;
      });
    }
    req.headers = headers;

    const res = new http.ServerResponse(req);
    res.assignSocket(resSocket as unknown as Socket);

    res.on('finish', () => {
      init?.signal?.removeEventListener('abort', onAbort);
      const rawWire = Buffer.concat(wireChunks).toString('utf8');
      const idx = rawWire.indexOf('\r\n\r\n');
      const responseText = idx >= 0 ? rawWire.slice(idx + 4) : rawWire;

      const respHeaders = new Headers();
      for (const [k, v] of Object.entries(res.getHeaders())) {
        if (typeof v === 'string') respHeaders.set(k, v);
        else if (typeof v === 'number') respHeaders.set(k, String(v));
      }

      reqSocket.destroy();
      resSocket.destroy();
      resolve(
        new Response(responseText, {
          status: res.statusCode,
          headers: respHeaders,
        })
      );
    });

    res.on('error', (err) => {
      init?.signal?.removeEventListener('abort', onAbort);
      reject(err);
    });

    app(req, res);

    queueMicrotask(() => {
      if (bodyBuf !== undefined) {
        req.push(bodyBuf);
      }
      req.push(null);
    });
  });
}

describe('Stage 3 Full-Stack Client <-> Express Journey & UX Verification', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('executes complete user journey against real createApp(): setup_needed -> opt-in synthetic_demo -> non-US rejection -> Springfield disambiguation -> pan no-AVM guard -> rescore -> 1M/900k in_range AVM -> fallback /api/explain', async () => {
    const config = loadServerConfig({
      NODE_ENV: 'test',
      BUDGET_STORE_MODE: 'memory',
      ENABLE_SYNTHETIC_DEMO_MODE: 'true',
      // Leave RENTCAST_API_KEY & GEMINI_API_KEY unset to verify setup_needed + opt-in demo + fallback explain!
    });

    const apiCallLog: Array<{ method: string; url: string }> = [];
    const app = createApp({
      config,
      propertyDeps: {
        regionResolverOptions: { enableExternalGeocoders: false },
      },
    });

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input.toString();
      apiCallLog.push({ method: (init?.method ?? 'GET').toUpperCase(), url: urlStr });
      return bridgeFetchToExpress(app, input, init);
    });

    render(<App />);

    // 1. Starts in setup_needed (never silently enters synthetic_demo!) with no hardcoded Berkeley
    const setupBanner = await screen.findByTestId('setup-needed-banner');
    expect(setupBanner).toHaveTextContent('Setup Needed');
    expect(setupBanner).toHaveTextContent('RENTCAST_API_KEY');
    expect(screen.queryByTestId('synthetic-demo-banner')).toBeNull();

    const searchInput = screen.getByLabelText(/US City, Neighborhood, or ZIP/i) as HTMLInputElement;
    expect(searchInput.value.toLowerCase()).not.toContain('berkeley');

    // Verify TWO separate accessible legends exist simultaneously
    expect(screen.getByTestId('legend-accessibility')).toHaveTextContent(
      '1. Facility Accessibility & Overlap Legend'
    );
    expect(screen.getByTestId('legend-price-gap')).toHaveTextContent(
      '2. Asking-vs-AVM Price Gap & Range Legend'
    );

    // 2. User explicitly opts into badged Synthetic Demo Mode
    fireEvent.click(screen.getByRole('button', { name: /Preview Labeled Synthetic Demo Mode/i }));
    expect(await screen.findByTestId('synthetic-demo-banner')).toHaveTextContent(
      'SYNTHETIC DEMO FIXTURE — NOT LIVE COVERAGE'
    );

    // 3. Non-US query ("Toronto, ON") is rejected before any property search
    fireEvent.change(searchInput, { target: { value: 'Toronto, ON' } });
    fireEvent.click(screen.getByRole('button', { name: /Resolve Location/i }));
    expect(await screen.findByTestId('unsupported-area-alert')).toHaveTextContent(
      /Unsupported Area/i
    );

    // 4. Ambiguous multi-state city ("Springfield") shows disambiguation picker
    fireEvent.change(searchInput, { target: { value: 'Springfield' } });
    fireEvent.click(screen.getByRole('button', { name: /Resolve Location/i }));
    const ambBox = await screen.findByTestId('ambiguous-candidates');
    expect(ambBox).toHaveTextContent('Springfield, Sangamon County, IL');
    expect(ambBox).toHaveTextContent('Springfield, Greene County, MO');

    // Select Springfield, IL -> shows confirmed circular viewport approximation box
    fireEvent.click(screen.getByRole('button', { name: /Springfield, Sangamon County, IL/i }));
    const confirmedBox = await screen.findByTestId('confirmed-area-box');
    expect(confirmedBox).toHaveTextContent('Springfield, Sangamon County, IL');
    expect(confirmedBox).toHaveTextContent(/circular geodesic viewport approximation/i);

    // Still 0 property searches before clicking "Analyze Area"!
    expect(apiCallLog.filter((c) => c.url.includes('/api/properties/search'))).toHaveLength(0);

    // 5. Click "Analyze Area" -> fetches geospatial + listings (0 AVM calls!)
    fireEvent.click(screen.getByTestId('analyze-area-button'));
    const home2Card = await screen.findByTestId('property-card-syn-us-il-springfield-02');
    expect(home2Card).toHaveTextContent('1234 Cedar Park Blvd (Synthetic Demo), Springfield, IL 62701');
    expect(apiCallLog.filter((c) => c.url.includes('/api/properties/search'))).toHaveLength(1);
    expect(apiCallLog.filter((c) => c.url.endsWith('/avm'))).toHaveLength(0);

    // 6. Panning the map MUST NOT trigger any property search or AVM call!
    fireEvent.click(screen.getByRole('button', { name: 'Pan map north' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pan map east' }));
    expect(apiCallLog.filter((c) => c.url.includes('/api/properties/search'))).toHaveLength(1);
    expect(apiCallLog.filter((c) => c.url.endsWith('/avm'))).toHaveLength(0);

    // 7. Preference weight adjustment + Re-Score updates scores with 0 AVM calls
    const transitSlider = screen.getByLabelText(/^Weight:/i, { selector: '#weight-transit' });
    fireEvent.change(transitSlider, { target: { value: '45' } });
    fireEvent.click(screen.getByTestId('rescore-preferences-button'));
    await waitFor(() => {
      expect(apiCallLog.filter((c) => c.url.includes('/api/geospatial/analyze')).length).toBeGreaterThanOrEqual(2);
    });
    expect(apiCallLog.filter((c) => c.url.endsWith('/avm'))).toHaveLength(0);

    // 8. Select Home #2 ($900k ask vs $1M AVM in [$850k, $1.15M]) & fetch on-demand AVM
    fireEvent.click(home2Card);
    const fetchAvmBtn = await screen.findByTestId('fetch-avm-button');
    fireEvent.click(fetchAvmBtn);

    await waitFor(() => {
      expect(screen.getByTestId('detail-avm-price')).toHaveTextContent('$1,000,000');
    });
    expect(screen.getByTestId('detail-asking-price')).toHaveTextContent('$900,000');
    expect(screen.getByTestId('detail-avm-range')).toHaveTextContent('$850,000 – $1,150,000');
    expect(screen.getByTestId('contrary-evidence-section')).toHaveTextContent(
      /Positive Midpoint Gap \(\+10\.0%\) Still Inside AVM Range/i
    );

    // 9. Click Generate Grounded Gemini Explanation -> deterministic fallback renders cleanly when GEMINI_API_KEY is unset
    fireEvent.click(screen.getByTestId('generate-explain-button'));
    const explainCard = await screen.findByTestId('explain-result');
    expect(explainCard).toHaveTextContent('Deterministic Fallback');
    expect(explainCard).toHaveTextContent('$900,000');
    expect(explainCard).toHaveTextContent('ev_prop_pricing');
  });

  it('cancels stale region requests via AbortController/clientRequestSeq and recovers cleanly from upstream 504 timeout', async () => {
    let searchAttempt = 0;
    const abortedUrls: string[] = [];

    const liveMockFetch: typeof fetch = async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('overpass')) {
        return new Response(JSON.stringify({ elements: [] }), { status: 200 });
      }
      if (url.includes('ofmpub.epa.gov')) {
        return new Response(JSON.stringify({ Results: { FRSFacility: [] } }), { status: 200 });
      }
      if (url.includes('api.rentcast.io/v1/listings/sale')) {
        searchAttempt += 1;
        if (searchAttempt === 1) {
          const timeoutErr = new Error('RentCast request timed out');
          timeoutErr.name = 'AbortError';
          throw timeoutErr;
        }
        return new Response(
          JSON.stringify([
            {
              id: 'rc-aus-recover-1',
              formattedAddress: '500 Congress Ave, Austin, TX 78701',
              city: 'Austin',
              state: 'TX',
              zipCode: '78701',
              latitude: 30.2672,
              longitude: -97.7431,
              propertyType: 'Condo',
              bedrooms: 2,
              bathrooms: 2,
              squareFootage: 1250,
              price: 610_000,
              lastSeenDate: '2026-11-13T12:00:00.000Z',
            },
          ]),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response('{}', { status: 404 });
    };

    const config = loadServerConfig({
      NODE_ENV: 'test',
      BUDGET_STORE_MODE: 'memory',
      RENTCAST_API_KEY: 'rk_live_test_key_recovery',
    });

    const app = createApp({
      config,
      geospatialOptions: { fetchImpl: liveMockFetch },
      propertyDeps: {
        fetchFn: liveMockFetch,
        regionResolverOptions: { enableExternalGeocoders: false },
      },
    });

    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input.toString();
      if (urlStr.includes('/api/regions/resolve') && typeof init?.body === 'string') {
        const parsed = JSON.parse(init.body);
        if (parsed.query === 'Seattle, WA') {
          // Delay first request so second request aborts it!
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 120);
            init.signal?.addEventListener(
              'abort',
              () => {
                clearTimeout(timer);
                abortedUrls.push('Seattle, WA');
                const err = new Error('Aborted');
                err.name = 'AbortError';
                reject(err);
              },
              { once: true }
            );
          });
        }
      }
      return bridgeFetchToExpress(app, input, init);
    });

    render(<App />);
    await screen.findByTestId('legend-accessibility');

    // Trigger Seattle resolve, then immediately supersede with Austin resolve
    const searchInput = screen.getByLabelText(/US City, Neighborhood, or ZIP/i);
    fireEvent.change(searchInput, { target: { value: 'Seattle, WA' } });
    fireEvent.click(screen.getByRole('button', { name: /Resolve Location/i }));

    fireEvent.change(searchInput, { target: { value: 'Austin, TX' } });
    fireEvent.click(screen.getByRole('button', { name: /Resolve Location/i }));

    const confirmedBox = await screen.findByTestId('confirmed-area-box');
    expect(confirmedBox).toHaveTextContent('Austin, TX 78701');
    expect(abortedUrls).toContain('Seattle, WA');

    // First Analyze Area hits simulated RentCast 504 timeout -> surfaces retryable error state
    fireEvent.click(screen.getByTestId('analyze-area-button'));
    const retryBtn = await screen.findByRole('button', { name: /Retry Search/i });
    expect(retryBtn).toBeInTheDocument();

    // Clicking Retry Search recovers cleanly on second attempt
    fireEvent.click(retryBtn);
    expect(await screen.findByTestId('property-card-rc-aus-recover-1')).toHaveTextContent(
      '500 Congress Ave, Austin, TX 78701'
    );
  });
});
