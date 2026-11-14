import '@testing-library/jest-dom/vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/client/App';
import {
  AUSTIN_AREA,
  SEATTLE_AREA,
  SPRINGFIELD_CANDIDATES,
  makeAustinAvmResponse,
  makeAustinGeospatialResponse,
  makeAustinListing,
  makeAustinSearchResponse,
  makeBudget,
  makeExpandResponse,
  makeExplainResponse,
  makeResolveResponse,
  makeSetupNeededConfig,
} from './fixtures';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('Foreal-Estate Client UI', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders Setup Needed banner with missing env var names and opt-in badged synthetic demo toggle', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/config') {
        return jsonResponse(makeSetupNeededConfig());
      }
      if (url === '/api/regions/resolve') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        expect(body.useSyntheticDemo).toBe(true);
        return jsonResponse(makeResolveResponse({ clientRequestSeq: body.clientRequestSeq }));
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);

    const setupBanner = await screen.findByTestId('setup-needed-banner');
    expect(setupBanner).toHaveTextContent('Setup Needed');
    expect(setupBanner).toHaveTextContent('RENTCAST_API_KEY');
    expect(setupBanner).toHaveTextContent('GOOGLE_MAPS_BROWSER_KEY');

    // Two separate accessible legends always rendered
    expect(screen.getByTestId('legend-accessibility')).toHaveTextContent(
      '1. Facility Accessibility & Overlap Legend'
    );
    expect(screen.getByTestId('legend-price-gap')).toHaveTextContent(
      '2. Asking-vs-AVM Price Gap & Range Legend'
    );

    // Non-causal fast-food default note & uncalibrated externality label
    expect(screen.getByTestId('fast-food-non-causal-note')).toHaveTextContent(
      'defaults to 0 weight'
    );
    expect(screen.getByLabelText(/Uncalibrated User Preference — Not Market Dollars/i)).toBeInTheDocument();

    // Opt into labeled synthetic demo mode
    const demoToggle = screen.getByRole('button', {
      name: /Preview Labeled Synthetic Demo Mode/i,
    });
    fireEvent.click(demoToggle);

    const demoBanner = await screen.findByTestId('synthetic-demo-banner');
    expect(demoBanner).toHaveTextContent('SYNTHETIC DEMO FIXTURE — NOT LIVE COVERAGE');

    // Resolving a region now sends useSyntheticDemo: true
    fireEvent.change(screen.getByLabelText(/US City, Neighborhood, or ZIP/i), {
      target: { value: 'Austin, TX' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Resolve Location/i }));

    await waitFor(() => {
      expect(screen.getByTestId('confirmed-area-box')).toHaveTextContent('Austin, TX (78704)');
    });
  });

  it('handles ambiguous US candidates, unsupported_area rejection, and requires explicit Analyze Area click', async () => {
    const calledUrls: string[] = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      calledUrls.push(url);
      if (url === '/api/config') {
        return jsonResponse(makeSetupNeededConfig({ uiSetupState: 'ready', missingSetupEnvVars: [] }));
      }
      if (url === '/api/regions/resolve') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.query === 'London, UK') {
          return jsonResponse(
            makeResolveResponse({
              status: 'unsupported_area',
              candidates: [],
              selectedArea: null,
              message: 'United States locations only.',
              clientRequestSeq: body.clientRequestSeq,
            })
          );
        }
        return jsonResponse(
          makeResolveResponse({
            status: 'ambiguous',
            candidates: SPRINGFIELD_CANDIDATES,
            selectedArea: null,
            message: 'Multiple US locations matched "Springfield".',
            clientRequestSeq: body.clientRequestSeq,
          })
        );
      }
      if (url === '/api/geospatial/analyze') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        return jsonResponse({
          ...makeAustinGeospatialResponse(body.analysisArea, false),
          clientRequestSeq: body.clientRequestSeq,
        });
      }
      if (url === '/api/properties/search') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        return jsonResponse({
          ...makeAustinSearchResponse(body.analysisArea, false),
          clientRequestSeq: body.clientRequestSeq,
        });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await screen.findByLabelText(/US City, Neighborhood, or ZIP/i);

    // 1. Non-US query returns unsupported_area without calling properties/search
    fireEvent.change(screen.getByLabelText(/US City, Neighborhood, or ZIP/i), {
      target: { value: 'London, UK' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Resolve Location/i }));
    await screen.findByTestId('unsupported-area-alert');
    expect(calledUrls).not.toContain('/api/properties/search');

    // 2. Ambiguous query presents selectable US candidates
    fireEvent.change(screen.getByLabelText(/US City, Neighborhood, or ZIP/i), {
      target: { value: 'Springfield' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Resolve Location/i }));
    const candidateBox = await screen.findByTestId('ambiguous-candidates');
    expect(candidateBox).toHaveTextContent('Springfield, Sangamon County, IL, USA');
    expect(candidateBox).toHaveTextContent('Springfield, Greene County, MO, USA');

    // Pick Missouri candidate -> confirms coordinates & approximation disclaimer, still does NOT call search yet
    fireEvent.click(screen.getByRole('button', { name: /Springfield, Greene County, MO/i }));
    const confirmedBox = await screen.findByTestId('confirmed-area-box');
    expect(confirmedBox).toHaveTextContent('37.20900, -93.29230');
    expect(confirmedBox).toHaveTextContent('Circular geodesic viewport approximation');
    expect(calledUrls).not.toContain('/api/properties/search');
    expect(calledUrls).not.toContain('/api/geospatial/analyze');

    // 3. Explicit Analyze Area button triggers both geospatial analyze and property search
    fireEvent.click(screen.getByTestId('analyze-area-button'));
    await waitFor(() => {
      expect(calledUrls).toContain('/api/geospatial/analyze');
      expect(calledUrls).toContain('/api/properties/search');
    });
  });

  it('cancels/ignores stale region responses so an older region never overwrites a newer one', async () => {
    const firstRegionHolder: { resolve: ((res: Response) => void) | null } = { resolve: null };
    let firstAborted = false;

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/config') {
        return Promise.resolve(makeSetupNeededConfig({ missingSetupEnvVars: [] })).then((cfg) =>
          jsonResponse(cfg)
        );
      }
      if (url === '/api/regions/resolve') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        if (body.query === 'Austin, TX') {
          init?.signal?.addEventListener('abort', () => {
            firstAborted = true;
          });
          return new Promise<Response>((resolve) => {
            firstRegionHolder.resolve = resolve;
          });
        }
        return Promise.resolve(
          jsonResponse(
            makeResolveResponse({
              selectedArea: SEATTLE_AREA,
              message: 'Resolved Ballard, Seattle, WA.',
              clientRequestSeq: body.clientRequestSeq,
            })
          )
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    const input = await screen.findByLabelText(/US City, Neighborhood, or ZIP/i);

    // Trigger Austin (slow)
    fireEvent.change(input, { target: { value: 'Austin, TX' } });
    fireEvent.click(screen.getByRole('button', { name: /Resolve Location/i }));

    // Immediately switch to Seattle (fast)
    fireEvent.change(input, { target: { value: 'Ballard, Seattle, WA' } });
    fireEvent.click(screen.getByRole('button', { name: /Resolve Location/i }));

    await waitFor(() => {
      expect(screen.getByTestId('confirmed-area-box')).toHaveTextContent('Ballard, Seattle, WA');
    });
    expect(firstAborted).toBe(true);

    // Even if the slow Austin promise resolves late, Seattle remains displayed
    firstRegionHolder.resolve?.(
      jsonResponse(
        makeResolveResponse({
          selectedArea: AUSTIN_AREA,
          message: 'Late Austin response',
          clientRequestSeq: 1,
        })
      )
    );

    await new Promise((r) => setTimeout(r, 25));
    expect(screen.getByTestId('confirmed-area-box')).toHaveTextContent('Ballard, Seattle, WA');
    expect(screen.getByTestId('confirmed-area-box')).not.toHaveTextContent('Austin, TX (78704)');
  });

  it('supports preference re-scoring without RentCast calls, on-demand AVM, contrary evidence, session expansion, and grounded/fallback explain', async () => {
    let searchCalls = 0;
    let avmCalls = 0;
    let explainCalls = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/config') {
        return jsonResponse(makeSetupNeededConfig());
      }
      if (url === '/api/regions/resolve') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        return jsonResponse(makeResolveResponse({ clientRequestSeq: body.clientRequestSeq }));
      }
      if (url === '/api/geospatial/analyze') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        return jsonResponse({
          ...makeAustinGeospatialResponse(AUSTIN_AREA, true),
          clientRequestSeq: body.clientRequestSeq,
        });
      }
      if (url === '/api/properties/search') {
        searchCalls += 1;
        const body = JSON.parse(String(init?.body ?? '{}'));
        return jsonResponse({
          ...makeAustinSearchResponse(AUSTIN_AREA, true),
          clientRequestSeq: body.clientRequestSeq,
        });
      }
      if (url === '/api/properties/prop-austin-1/avm') {
        avmCalls += 1;
        return jsonResponse(makeAustinAvmResponse());
      }
      if (url === '/api/sessions/sess_austin_001/expand') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        expect(body.userConfirmed).toBe(true);
        return jsonResponse(makeExpandResponse());
      }
      if (url === '/api/explain') {
        explainCalls += 1;
        return jsonResponse(makeExplainResponse(explainCalls === 1));
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await screen.findByTestId('setup-needed-banner');

    // Toggle synthetic demo, resolve Austin, click Analyze Area
    fireEvent.click(screen.getByRole('button', { name: /Preview Labeled Synthetic Demo Mode/i }));
    fireEvent.change(screen.getByLabelText(/US City, Neighborhood, or ZIP/i), {
      target: { value: 'Austin, TX' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Resolve Location/i }));
    await screen.findByTestId('confirmed-area-box');
    fireEvent.click(screen.getByTestId('analyze-area-button'));

    await screen.findByTestId('property-card-prop-austin-1');
    expect(searchCalls).toBe(1);
    expect(avmCalls).toBe(0);

    // Pan SVG map -> offers Analyze Current Viewport without calling AVM
    fireEvent.click(screen.getByRole('button', { name: /Pan map north/i }));
    expect(screen.getByTestId('analyze-current-viewport-btn')).toBeInTheDocument();
    expect(avmCalls).toBe(0);

    // Adjust preference weight and click Apply Preferences & Re-Score -> 0 additional RentCast calls
    const grocerySlider = screen.getByLabelText(/Weight:/i, {
      selector: '#weight-grocery',
    });
    fireEvent.change(grocerySlider, { target: { value: '40' } });
    fireEvent.click(screen.getByTestId('rescore-preferences-button'));
    await waitFor(() => {
      expect(searchCalls).toBe(1);
    });

    // Select property card -> does NOT auto-fetch AVM until button is clicked
    fireEvent.click(screen.getByTestId('property-card-prop-austin-1'));
    expect(avmCalls).toBe(0);
    expect(screen.getByTestId('detail-asking-price')).toHaveTextContent('$900,000');

    // Click explicit Fetch RentCast AVM button
    fireEvent.click(screen.getByTestId('fetch-avm-button'));
    await waitFor(() => {
      expect(avmCalls).toBe(1);
      expect(screen.getByTestId('detail-avm-price')).toHaveTextContent('$1,000,000');
    });

    // Verify +10.0% midpoint gap still in_range + contrary evidence + subject-in-comps + EPA + missing transit
    expect(screen.getByTestId('avm-range-visual')).toHaveTextContent('$850,000');
    const contrarySection = screen.getByTestId('contrary-evidence-section');
    expect(contrarySection).toHaveTextContent('Positive Midpoint Gap (+10.0%) Still Inside AVM Range');
    expect(contrarySection).toHaveTextContent('Subject-in-Comps Circularity Warning');
    expect(contrarySection).toHaveTextContent('Incomplete Geospatial Coverage (partial)');
    expect(contrarySection).toHaveTextContent('South Austin Fleet Maintenance Facility');

    // Generate Grounded Gemini Explanation -> verifies evidenceIds mapped to evidenceCatalog
    fireEvent.click(screen.getByTestId('generate-explain-button'));
    const explainResult = await screen.findByTestId('explain-result');
    expect(explainResult).toHaveTextContent('Grounded Gemini');
    expect(explainResult).toHaveTextContent('ev_prop_pricing');
    expect(explainResult).toHaveTextContent('Asking $900,000 vs AVM $1,000,000');

    // Second call simulates explanationAvailable: false graceful fallback
    fireEvent.click(screen.getByTestId('generate-explain-button'));
    await waitFor(() => {
      expect(screen.getByTestId('explain-result')).toHaveTextContent(
        'Gemini Narrative Unavailable — Deterministic Fallback Active'
      );
    });

    // Exit demo mode and test session expansion when live session exists
    fireEvent.click(screen.getByRole('button', { name: /Exit Synthetic Demo Mode/i }));
    fireEvent.click(screen.getByRole('button', { name: /Expand Session Limit/i }));
    await waitFor(() => {
      expect(screen.getByTestId('session-avms-meter')).toHaveTextContent('1 / 10');
    });
  });

  it('handles timeout retry recovery and empty listing states cleanly', async () => {
    let searchAttempt = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/config') {
        return jsonResponse(makeSetupNeededConfig({ missingSetupEnvVars: [] }));
      }
      if (url === '/api/regions/resolve') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        return jsonResponse(makeResolveResponse({ clientRequestSeq: body.clientRequestSeq }));
      }
      if (url === '/api/geospatial/analyze') {
        return jsonResponse(makeAustinGeospatialResponse(AUSTIN_AREA, false));
      }
      if (url === '/api/properties/search') {
        searchAttempt += 1;
        if (searchAttempt === 1) {
          return jsonResponse(
            {
              error: {
                code: 'UPSTREAM_TIMEOUT',
                message: 'RentCast listings timed out.',
                uiState: 'timeout',
                retryable: true,
              },
              budget: makeBudget(),
            },
            504
          );
        }
        return jsonResponse({
          ...makeAustinSearchResponse(AUSTIN_AREA, false),
          uiState: 'empty',
          listings: [],
        });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await screen.findByLabelText(/US City, Neighborhood, or ZIP/i);

    fireEvent.change(screen.getByLabelText(/US City, Neighborhood, or ZIP/i), {
      target: { value: 'Austin, TX' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Resolve Location/i }));
    await screen.findByTestId('confirmed-area-box');
    fireEvent.click(screen.getByTestId('analyze-area-button'));

    // First attempt times out -> Retry Search button appears
    await screen.findByText(/RentCast listings timed out/i);
    fireEvent.click(screen.getByRole('button', { name: /Retry Search/i }));

    // Second attempt succeeds with 0 listings -> distinct empty state
    const emptyState = await screen.findByTestId('empty-listings-state');
    expect(emptyState).toHaveTextContent('0 active residential listings found in this analysis radius');
  });

  it('supports keyboard selection on SVG map property markers and mobile tab switching', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/config') {
        return jsonResponse(makeSetupNeededConfig({ missingSetupEnvVars: [] }));
      }
      if (url === '/api/regions/resolve') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        return jsonResponse(makeResolveResponse({ clientRequestSeq: body.clientRequestSeq }));
      }
      if (url === '/api/geospatial/analyze') {
        return jsonResponse(makeAustinGeospatialResponse(AUSTIN_AREA, false));
      }
      if (url === '/api/properties/search') {
        return jsonResponse({
          ...makeAustinSearchResponse(AUSTIN_AREA, false),
          listings: [makeAustinListing({ id: 'prop-kbd-1' })],
        });
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await screen.findByLabelText(/US City, Neighborhood, or ZIP/i);

    fireEvent.change(screen.getByLabelText(/US City, Neighborhood, or ZIP/i), {
      target: { value: 'Austin, TX' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Resolve Location/i }));
    await screen.findByTestId('confirmed-area-box');
    fireEvent.click(screen.getByTestId('analyze-area-button'));

    const marker = await screen.findByRole('button', {
      name: /Select listing 1: 1804 S Congress Ave/i,
    });
    fireEvent.keyDown(marker, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByTestId('property-detail-drawer')).toHaveTextContent(
        '1804 S Congress Ave, Austin, TX 78704'
      );
    });

    // Switch mobile tabs
    const prefsTab = screen.getByRole('button', { name: 'Preferences' });
    fireEvent.click(prefsTab);
    expect(prefsTab).toHaveAttribute('aria-pressed', 'true');
  });

  it('aborts and ignores stale home AVM responses when switching homes and surfaces quota_exhausted state', async () => {
    const slowAvmHolder: { resolve: ((res: Response) => void) | null } = { resolve: null };
    let firstHomeAborted = false;

    const listingA = makeAustinListing({
      id: 'prop-a',
      formattedAddress: '101 Barton Springs Rd, Austin, TX 78704',
      askingPrice: 800000,
    });
    const listingB = makeAustinListing({
      id: 'prop-b',
      formattedAddress: '202 Zilker Park Way, Austin, TX 78704',
      askingPrice: 1200000,
    });

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/config') {
        return Promise.resolve(jsonResponse(makeSetupNeededConfig({ missingSetupEnvVars: [] })));
      }
      if (url === '/api/regions/resolve') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        return Promise.resolve(
          jsonResponse(makeResolveResponse({ clientRequestSeq: body.clientRequestSeq }))
        );
      }
      if (url === '/api/geospatial/analyze') {
        return Promise.resolve(jsonResponse(makeAustinGeospatialResponse(AUSTIN_AREA, false)));
      }
      if (url === '/api/properties/search') {
        return Promise.resolve(
          jsonResponse({
            ...makeAustinSearchResponse(AUSTIN_AREA, false),
            listings: [listingA, listingB],
          })
        );
      }
      if (url === '/api/properties/prop-a/avm') {
        init?.signal?.addEventListener('abort', () => {
          firstHomeAborted = true;
        });
        return new Promise<Response>((resolve) => {
          slowAvmHolder.resolve = resolve;
        });
      }
      if (url === '/api/properties/prop-b/avm') {
        return Promise.resolve(
          jsonResponse(
            {
              error: {
                code: 'SESSION_CAP_REACHED',
                message: 'Session AVM cap (5/5) reached. Expand session to continue.',
                uiState: 'quota_exhausted',
                retryable: true,
              },
              budget: makeBudget({ sessionAvmsUsed: 5, quotaExhausted: true }),
            },
            429
          )
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await screen.findByLabelText(/US City, Neighborhood, or ZIP/i);

    fireEvent.change(screen.getByLabelText(/US City, Neighborhood, or ZIP/i), {
      target: { value: 'Austin, TX' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Resolve Location/i }));
    await screen.findByTestId('confirmed-area-box');
    fireEvent.click(screen.getByTestId('analyze-area-button'));

    await screen.findByTestId('property-card-prop-a');

    // Select home A and trigger slow AVM fetch
    fireEvent.click(screen.getByTestId('property-card-prop-a'));
    fireEvent.click(screen.getByTestId('fetch-avm-button'));

    // Immediately switch to home B -> aborts home A's AVM request
    fireEvent.click(screen.getByTestId('property-card-prop-b'));
    expect(firstHomeAborted).toBe(true);
    expect(screen.getByTestId('property-detail-drawer')).toHaveTextContent(
      '202 Zilker Park Way, Austin, TX 78704'
    );

    // Resolve slow AVM for home A late -> must NOT overwrite home B's drawer
    slowAvmHolder.resolve?.(jsonResponse(makeAustinAvmResponse()));
    await new Promise((r) => setTimeout(r, 25));
    expect(screen.getByTestId('property-detail-drawer')).toHaveTextContent(
      '202 Zilker Park Way, Austin, TX 78704'
    );
    expect(screen.getByTestId('detail-avm-price')).toHaveTextContent('Not available');

    // Trigger AVM for home B -> hits quota_exhausted error cleanly
    fireEvent.click(screen.getByTestId('fetch-avm-button'));
    await screen.findByText(/Session AVM cap \(5\/5\) reached/i);
  });

  it('preserves listings, map overlays, and AVM values on 409 SESSION_EXPIRED from /api/explain with zero automatic property retries', async () => {
    let propertyEndpointCalls = 0;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.startsWith('/api/properties/')) {
        propertyEndpointCalls += 1;
      }
      if (url === '/api/config') {
        return jsonResponse(makeSetupNeededConfig({ missingSetupEnvVars: [] }));
      }
      if (url === '/api/regions/resolve') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        return jsonResponse(makeResolveResponse({ clientRequestSeq: body.clientRequestSeq }));
      }
      if (url === '/api/geospatial/analyze') {
        return jsonResponse(makeAustinGeospatialResponse(AUSTIN_AREA, false));
      }
      if (url === '/api/properties/search') {
        return jsonResponse(makeAustinSearchResponse(AUSTIN_AREA, false));
      }
      if (url === '/api/properties/prop-austin-1/avm') {
        return jsonResponse(makeAustinAvmResponse());
      }
      if (url === '/api/explain') {
        return jsonResponse(
          {
            error: {
              code: 'SESSION_EXPIRED',
              message: 'Session sess_austin_001 is no longer present on this server instance.',
              uiState: 'recovery',
              retryable: false,
            },
            budget: null,
          },
          409
        );
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await screen.findByLabelText(/US City, Neighborhood, or ZIP/i);

    fireEvent.change(screen.getByLabelText(/US City, Neighborhood, or ZIP/i), {
      target: { value: 'Austin, TX' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Resolve Location/i }));
    await screen.findByTestId('confirmed-area-box');
    fireEvent.click(screen.getByTestId('analyze-area-button'));

    await screen.findByTestId('property-card-prop-austin-1');
    fireEvent.click(screen.getByTestId('property-card-prop-austin-1'));
    fireEvent.click(screen.getByTestId('fetch-avm-button'));
    await waitFor(() => {
      expect(screen.getByTestId('detail-avm-price')).toHaveTextContent('$1,000,000');
    });

    const propertyCallsBeforeExplain = propertyEndpointCalls;
    expect(propertyCallsBeforeExplain).toBe(2); // 1 search + 1 AVM

    // Trigger /api/explain -> 409 SESSION_EXPIRED
    fireEvent.click(screen.getByTestId('generate-explain-button'));

    const expiredBanner = await screen.findByTestId('session-expired-banner');
    expect(expiredBanner).toHaveTextContent('Session Expired (409)');
    expect(expiredBanner).toHaveTextContent(
      'zero paid RentCast calls were repeated automatically'
    );
    expect(expiredBanner).toHaveTextContent('Click Analyze Area explicitly');

    // Listings, map center score, and AVM values remain intact
    expect(screen.getByTestId('property-card-prop-austin-1')).toBeInTheDocument();
    expect(screen.getByTestId('center-accessibility-summary')).toHaveTextContent('78.5 / 100');
    expect(screen.getByTestId('detail-avm-price')).toHaveTextContent('$1,000,000');

    // Wait briefly and assert 0 additional /api/properties/* calls were fired
    await new Promise((r) => setTimeout(r, 30));
    expect(propertyEndpointCalls).toBe(propertyCallsBeforeExplain);
  });

  it('renders AI Studio ARIA disclosure controls, keyboard navigation, and source-attribution badges in AccessibleLegends', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url === '/api/config') {
        return jsonResponse(makeSetupNeededConfig({ missingSetupEnvVars: [] }));
      }
      if (url === '/api/regions/resolve') {
        const body = JSON.parse(String(init?.body ?? '{}'));
        return jsonResponse(makeResolveResponse({ clientRequestSeq: body.clientRequestSeq }));
      }
      if (url === '/api/geospatial/analyze') {
        return jsonResponse(makeAustinGeospatialResponse(AUSTIN_AREA, false));
      }
      if (url === '/api/properties/search') {
        return jsonResponse(makeAustinSearchResponse(AUSTIN_AREA, false));
      }
      if (url === '/api/properties/prop-austin-1/avm') {
        return jsonResponse(makeAustinAvmResponse());
      }
      return jsonResponse({}, 404);
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<App />);
    await screen.findByTestId('legend-accessibility');

    const accToggle = screen.getByRole('button', {
      name: /1\. Facility Accessibility & Overlap Legend/i,
    });
    const gapToggle = screen.getByRole('button', {
      name: /2\. Asking-vs-AVM Price Gap & Range Legend/i,
    });

    expect(accToggle).toHaveAttribute('aria-expanded', 'true');
    expect(accToggle).toHaveAttribute('aria-controls', 'legend-accessibility-panel');
    expect(gapToggle).toHaveAttribute('aria-expanded', 'true');
    expect(gapToggle).toHaveAttribute('aria-controls', 'legend-price-gap-panel');

    // Source attribution badges present
    expect(screen.getByTestId('source-badge-osm-overpass')).toHaveTextContent(
      'OpenStreetMap & Overpass API (ODbL 1.0)'
    );
    expect(screen.getByTestId('source-badge-epa-frs')).toHaveTextContent(
      'US EPA FRS / Envirofacts'
    );
    expect(screen.getByTestId('source-badge-google-places')).toHaveTextContent(
      'Excluded from Scoring & AI evidence'
    );
    expect(screen.getByTestId('source-badge-rentcast-avm')).toHaveTextContent('RentCast AVM');

    // Keyboard arrow navigation moves focus between legend disclosure buttons
    accToggle.focus();
    fireEvent.keyDown(accToggle, { key: 'ArrowDown' });
    expect(gapToggle).toHaveFocus();
    fireEvent.keyDown(gapToggle, { key: 'Home' });
    expect(accToggle).toHaveFocus();

    // Disclosure toggles collapse/expand panel cleanly
    fireEvent.click(accToggle);
    expect(accToggle).toHaveAttribute('aria-expanded', 'false');
    expect(document.getElementById('legend-accessibility-panel')).toHaveAttribute('hidden');
    fireEvent.click(accToggle);
    expect(accToggle).toHaveAttribute('aria-expanded', 'true');

    // Load area + AVM and confirm source date badges update with real fetched dates
    fireEvent.change(screen.getByLabelText(/US City, Neighborhood, or ZIP/i), {
      target: { value: 'Austin, TX' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Resolve Location/i }));
    await screen.findByTestId('confirmed-area-box');
    fireEvent.click(screen.getByTestId('analyze-area-button'));
    await screen.findByTestId('property-card-prop-austin-1');
    fireEvent.click(screen.getByTestId('property-card-prop-austin-1'));
    fireEvent.click(screen.getByTestId('fetch-avm-button'));

    await waitFor(() => {
      expect(screen.getByTestId('source-badge-osm-overpass')).toHaveTextContent(
        'Date: Nov 14, 2026'
      );
      expect(screen.getByTestId('source-badge-rentcast-avm')).toHaveTextContent(
        'Date: Nov 14, 2026'
      );
    });
  });
});
