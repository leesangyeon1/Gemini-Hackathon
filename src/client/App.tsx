import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AMENITY_CATEGORIES,
  ANALYSIS_BOUNDS,
  DEFAULT_SOURCE_ATTRIBUTIONS,
  MANDATORY_NON_CLAIMS,
} from '../shared/constants';
import type {
  AmenityCategory,
  AnalysisArea,
  BudgetSnapshot,
  CoordinatePoint,
  ExplainResponse,
  GeospatialAnalyzeResponse,
  PreferenceProfile,
  PropertyDetailRecord,
  PropertyListingSummary,
  PublicRuntimeConfig,
  RegionCandidate,
  RegionResolveRequest,
  RegionResolveStatus,
  UiState,
} from '../shared/types';
import {
  ApiClientError,
  analyzeGeospatial,
  expandSessionLimit,
  fetchPropertyAvm,
  fetchRuntimeConfig,
  generateExplanation,
  isAbortError,
  resolveRegion,
  searchProperties,
} from './api/client';
import { AccessibleLegends } from './components/AccessibleLegends';
import { BudgetMeter } from './components/BudgetMeter';
import { MapViewport } from './components/MapViewport';
import { PreferenceControls } from './components/PreferenceControls';
import { PropertyDetailDrawer } from './components/PropertyDetailDrawer';
import { PropertyListPanel } from './components/PropertyListPanel';
import { RegionSearchBar } from './components/RegionSearchBar';
import { SetupAndDemoBanner } from './components/SetupAndDemoBanner';
import {
  candidateToAnalysisArea,
  clonePreferences,
  createClientDefaultPreferences,
  formatIsoDate,
  getActiveCategories,
} from './utils/formatters';

type MobileTab = 'map' | 'listings' | 'detail' | 'preferences';

const INITIAL_VISIBLE_CATEGORIES: Record<AmenityCategory, boolean> = {
  grocery: true,
  parks: true,
  transit: true,
  healthcare: true,
  schools: true,
  fast_food: false,
};

export const App: React.FC = () => {
  // Runtime config & demo mode
  const [config, setConfig] = useState<PublicRuntimeConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(true);
  const [configError, setConfigError] = useState<string | null>(null);
  const [useSyntheticDemo, setUseSyntheticDemo] = useState(false);

  // Region input & resolution
  const [query, setQuery] = useState('');
  const [radiusMeters, setRadiusMeters] = useState<number>(ANALYSIS_BOUNDS.defaultAreaRadiusMeters);
  const [resolveStatus, setResolveStatus] = useState<RegionResolveStatus | null>(null);
  const [resolveMessage, setResolveMessage] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<RegionCandidate[]>([]);
  const [confirmedArea, setConfirmedArea] = useState<AnalysisArea | null>(null);
  const [isResolving, setIsResolving] = useState(false);

  // Preferences & map layer visibility
  const [preferences, setPreferences] = useState<PreferenceProfile>(createClientDefaultPreferences);
  const [visibleCategories, setVisibleCategories] = useState<Record<AmenityCategory, boolean>>(
    INITIAL_VISIBLE_CATEGORIES
  );
  const [showPlacesContext, setShowPlacesContext] = useState(false);

  // Area analysis, geospatial & property listings state
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionExpiredMessage, setSessionExpiredMessage] = useState<string | null>(null);
  const [budget, setBudget] = useState<BudgetSnapshot | null>(null);
  const [geospatialData, setGeospatialData] = useState<GeospatialAnalyzeResponse | null>(null);
  const [listings, setListings] = useState<PropertyListingSummary[]>([]);
  const [areaUiState, setAreaUiState] = useState<UiState>('ready');
  const [areaError, setAreaError] = useState<{ message: string; retryable: boolean } | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isReScoring, setIsReScoring] = useState(false);
  const [isExpanding, setIsExpanding] = useState(false);

  // Selected property, on-demand AVM & grounded explanation state
  const [selectedPropertyId, setSelectedPropertyId] = useState<string | null>(null);
  const [propertyDetailsById, setPropertyDetailsById] = useState<Record<string, PropertyDetailRecord>>({});
  const [avmFromCacheById, setAvmFromCacheById] = useState<Record<string, boolean>>({});
  const [avmDisclaimersById, setAvmDisclaimersById] = useState<Record<string, string[]>>({});
  const [isFetchingAvm, setIsFetchingAvm] = useState(false);
  const [avmError, setAvmError] = useState<string | null>(null);

  const [explainByPropertyId, setExplainByPropertyId] = useState<Record<string, ExplainResponse>>({});
  const [isExplaining, setIsExplaining] = useState(false);
  const [explainError, setExplainError] = useState<string | null>(null);

  // Mobile layout & live status announcement
  const [mobileTab, setMobileTab] = useState<MobileTab>('map');
  const [liveAnnouncement, setLiveAnnouncement] = useState('');

  // Monotonic sequence counters & AbortControllers to prevent stale overwrites
  const seqCounterRef = useRef(0);
  const regionSeqRef = useRef(0);
  const analyzeSeqRef = useRef(0);
  const avmSeqRef = useRef(0);
  const explainSeqRef = useRef(0);

  const regionAbortRef = useRef<AbortController | null>(null);
  const analyzeAbortRef = useRef<AbortController | null>(null);
  const avmAbortRef = useRef<AbortController | null>(null);
  const explainAbortRef = useRef<AbortController | null>(null);

  const selectedPropertyIdRef = useRef<string | null>(null);
  selectedPropertyIdRef.current = selectedPropertyId;

  const nextSeq = () => {
    seqCounterRef.current += 1;
    return seqCounterRef.current;
  };

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigError(null);
    const controller = new AbortController();
    try {
      const cfg = await fetchRuntimeConfig(controller.signal);
      setConfig(cfg);
      if (cfg.defaultPreferences) {
        setPreferences(clonePreferences(cfg.defaultPreferences));
      }
      setRadiusMeters(cfg.analysisBounds.defaultAreaRadiusMeters);
    } catch (err) {
      if (!isAbortError(err)) {
        setConfigError(err instanceof Error ? err.message : 'Failed to load /api/config.');
      }
    } finally {
      setConfigLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadConfig();
    return () => {
      regionAbortRef.current?.abort();
      analyzeAbortRef.current?.abort();
      avmAbortRef.current?.abort();
      explainAbortRef.current?.abort();
    };
  }, [loadConfig]);

  const handleToggleSyntheticDemo = (enabled: boolean) => {
    regionAbortRef.current?.abort();
    analyzeAbortRef.current?.abort();
    avmAbortRef.current?.abort();
    explainAbortRef.current?.abort();

    setUseSyntheticDemo(enabled);
    setSessionExpiredMessage(null);
    setGeospatialData(null);
    setListings([]);
    setSelectedPropertyId(null);
    setPropertyDetailsById({});
    setExplainByPropertyId({});
    setAreaError(null);
    setAvmError(null);
    setExplainError(null);
    setLiveAnnouncement(
      enabled
        ? 'Switched to labeled synthetic demo mode. Fixtures do not reflect live market coverage.'
        : 'Exited synthetic demo mode.'
    );
  };

  const handleResolveRegion = async (
    request: Omit<RegionResolveRequest, 'clientRequestSeq' | 'useSyntheticDemo'>
  ) => {
    regionAbortRef.current?.abort();
    const controller = new AbortController();
    regionAbortRef.current = controller;
    const seq = nextSeq();
    regionSeqRef.current = seq;

    setIsResolving(true);
    setAreaError(null);

    try {
      const res = await resolveRegion(
        {
          ...request,
          useSyntheticDemo,
          clientRequestSeq: seq,
        },
        controller.signal
      );

      if (seq !== regionSeqRef.current) {
        return;
      }

      setResolveStatus(res.status);
      setResolveMessage(res.message);
      setCandidates(res.candidates ?? []);

      if (res.status === 'resolved' && res.selectedArea) {
        setConfirmedArea({
          ...res.selectedArea,
          radiusMeters,
        });
        setLiveAnnouncement(
          `Confirmed US area: ${res.selectedArea.label}. Click Analyze Area to load listings and accessibility layers.`
        );
      } else if (res.status === 'ambiguous') {
        setConfirmedArea(null);
        setLiveAnnouncement(
          `Multiple US locations matched (${res.candidates.length}). Please select the intended candidate.`
        );
      } else {
        setConfirmedArea(null);
        setAreaUiState('unsupported_area');
        setLiveAnnouncement('Unsupported non-US location. Please choose a US location.');
      }
    } catch (err) {
      if (isAbortError(err) || seq !== regionSeqRef.current) {
        return;
      }
      const apiErr = err instanceof ApiClientError ? err : null;
      if (apiErr?.uiState === 'unsupported_area') {
        setResolveStatus('unsupported_area');
        setResolveMessage(apiErr.message);
        setCandidates([]);
        setConfirmedArea(null);
      } else {
        setAreaUiState(apiErr?.uiState ?? 'recovery');
        setAreaError({
          message: apiErr?.message ?? 'Failed to resolve region.',
          retryable: apiErr?.retryable ?? true,
        });
      }
    } finally {
      if (seq === regionSeqRef.current) {
        setIsResolving(false);
      }
    }
  };

  const handleSelectCandidate = (candidate: RegionCandidate) => {
    if (!candidate.isUsLocation) {
      setResolveStatus('unsupported_area');
      setResolveMessage('Selected candidate is outside the United States.');
      setConfirmedArea(null);
      return;
    }
    const area = candidateToAnalysisArea(candidate, radiusMeters);
    setResolveStatus('resolved');
    setResolveMessage(`Confirmed ${candidate.displayName}. Click Analyze Area to proceed.`);
    setCandidates([]);
    setConfirmedArea(area);
    setLiveAnnouncement(`Selected ${candidate.displayName}. Click Analyze Area to proceed.`);
  };

  const handleRadiusChange = (nextRadius: number) => {
    setRadiusMeters(nextRadius);
    setConfirmedArea((prev) => {
      if (!prev) return null;
      const latDelta = nextRadius / 111_320;
      const cosLat = Math.max(0.15, Math.cos((prev.centerLat * Math.PI) / 180));
      const lngDelta = nextRadius / (111_320 * cosLat);
      return {
        ...prev,
        radiusMeters: nextRadius,
        boundingBox: {
          minLat: Number((prev.centerLat - latDelta).toFixed(6)),
          maxLat: Number((prev.centerLat + latDelta).toFixed(6)),
          minLng: Number((prev.centerLng - lngDelta).toFixed(6)),
          maxLng: Number((prev.centerLng + lngDelta).toFixed(6)),
        },
      };
    });
  };

  const runAnalysisForArea = async (area: AnalysisArea) => {
    analyzeAbortRef.current?.abort();
    avmAbortRef.current?.abort();
    explainAbortRef.current?.abort();

    const controller = new AbortController();
    analyzeAbortRef.current = controller;
    const seq = nextSeq();
    analyzeSeqRef.current = seq;

    setIsAnalyzing(true);
    setSessionExpiredMessage(null);
    setAreaUiState('loading');
    setAreaError(null);
    setAvmError(null);
    setExplainError(null);
    setSelectedPropertyId(null);
    setPropertyDetailsById({});
    setExplainByPropertyId({});

    const geoPromise = analyzeGeospatial(
      {
        analysisArea: area,
        preferences,
        gridResolution: ANALYSIS_BOUNDS.defaultGridResolution,
        overlapThreshold: ANALYSIS_BOUNDS.defaultOverlapThreshold,
        useSyntheticDemo,
        clientRequestSeq: seq,
      },
      controller.signal
    );

    const searchPromise = searchProperties(
      {
        sessionId: sessionId ?? undefined,
        analysisArea: area,
        limit: ANALYSIS_BOUNDS.maxListingsPerSearch,
        preferences,
        useSyntheticDemo,
        clientRequestSeq: seq,
      },
      controller.signal
    );

    const [geoOutcome, searchOutcome] = await Promise.allSettled([geoPromise, searchPromise]);

    if (seq !== analyzeSeqRef.current) {
      return;
    }

    let nextGeo: GeospatialAnalyzeResponse | null = null;
    if (geoOutcome.status === 'fulfilled') {
      nextGeo = geoOutcome.value;
      setGeospatialData(nextGeo);
    }

    if (searchOutcome.status === 'fulfilled') {
      const searchRes = searchOutcome.value;
      setSessionId(searchRes.sessionId);
      setBudget(searchRes.budget);
      setListings(searchRes.listings);
      setAreaUiState(
        searchRes.listings.length === 0
          ? 'empty'
          : nextGeo?.centerAccessibility.completeness === 'partial'
            ? 'partial'
            : searchRes.uiState
      );
      setLiveAnnouncement(
        `Loaded ${searchRes.listings.length} active residential listings for ${area.label}.`
      );
    } else if (!isAbortError(searchOutcome.reason)) {
      const err = searchOutcome.reason;
      const apiErr = err instanceof ApiClientError ? err : null;
      if (apiErr?.budget) {
        setBudget(apiErr.budget);
      }
      setListings([]);
      setAreaUiState(apiErr?.uiState ?? 'recovery');
      setAreaError({
        message: apiErr?.message ?? 'Failed to fetch listings for this area.',
        retryable: apiErr?.retryable ?? true,
      });
    }

    if (geoOutcome.status === 'rejected' && !isAbortError(geoOutcome.reason)) {
      const err = geoOutcome.reason;
      const apiErr = err instanceof ApiClientError ? err : null;
      if (!areaError && searchOutcome.status === 'fulfilled') {
        setAreaUiState('partial');
        setAreaError({
          message:
            apiErr?.message ??
            'Geospatial amenity analysis failed or timed out; listings remain available.',
          retryable: true,
        });
      }
    }

    if (seq === analyzeSeqRef.current) {
      setIsAnalyzing(false);
    }
  };

  const handleAnalyzeArea = () => {
    if (!confirmedArea) return;
    void runAnalysisForArea(confirmedArea);
  };

  const handleAnalyzeViewportCenter = async (center: CoordinatePoint, targetRadius: number) => {
    regionAbortRef.current?.abort();
    const controller = new AbortController();
    regionAbortRef.current = controller;
    const seq = nextSeq();
    regionSeqRef.current = seq;

    setIsResolving(true);
    try {
      const res = await resolveRegion(
        {
          bounds: {
            centerLat: center.lat,
            centerLng: center.lng,
            radiusMeters: targetRadius,
          },
          useSyntheticDemo,
          clientRequestSeq: seq,
        },
        controller.signal
      );
      if (seq !== regionSeqRef.current) return;
      setResolveStatus(res.status);
      setResolveMessage(res.message);
      if (res.status === 'resolved' && res.selectedArea) {
        setConfirmedArea(res.selectedArea);
        setIsResolving(false);
        await runAnalysisForArea(res.selectedArea);
      }
    } catch (err) {
      if (!isAbortError(err) && seq === regionSeqRef.current) {
        const apiErr = err instanceof ApiClientError ? err : null;
        setAreaError({
          message: apiErr?.message ?? 'Failed to resolve viewport center.',
          retryable: apiErr?.retryable ?? true,
        });
      }
    } finally {
      if (seq === regionSeqRef.current) {
        setIsResolving(false);
      }
    }
  };

  const handleApplyPreferencesAndRescore = async () => {
    if (!confirmedArea) return;
    analyzeAbortRef.current?.abort();
    const controller = new AbortController();
    analyzeAbortRef.current = controller;
    const seq = nextSeq();
    analyzeSeqRef.current = seq;

    setIsReScoring(true);
    setAreaError(null);

    try {
      const evaluatePoints = listings
        .slice(0, ANALYSIS_BOUNDS.maxEvaluatePoints)
        .map((l) => ({ id: l.id, lat: l.latitude, lng: l.longitude }));

      const geoRes = await analyzeGeospatial(
        {
          analysisArea: confirmedArea,
          preferences,
          gridResolution: ANALYSIS_BOUNDS.defaultGridResolution,
          overlapThreshold: ANALYSIS_BOUNDS.defaultOverlapThreshold,
          evaluatePoints,
          useSyntheticDemo,
          clientRequestSeq: seq,
        },
        controller.signal
      );

      if (seq !== analyzeSeqRef.current) return;

      setGeospatialData(geoRes);
      setListings((prev) =>
        prev.map((l) => ({
          ...l,
          accessibility: geoRes.pointEvaluations[l.id] ?? l.accessibility,
        }))
      );
      setPropertyDetailsById((prev) => {
        const updated = { ...prev };
        for (const [id, detail] of Object.entries(updated)) {
          if (geoRes.pointEvaluations[id]) {
            updated[id] = { ...detail, accessibility: geoRes.pointEvaluations[id] };
          }
        }
        return updated;
      });
      setLiveAnnouncement(
        `Re-scored accessibility (${geoRes.centerAccessibility.score.toFixed(1)}/100) without calling RentCast.`
      );
    } catch (err) {
      if (!isAbortError(err) && seq === analyzeSeqRef.current) {
        const apiErr = err instanceof ApiClientError ? err : null;
        setAreaError({
          message: apiErr?.message ?? 'Failed to re-score geospatial preferences.',
          retryable: apiErr?.retryable ?? true,
        });
      }
    } finally {
      if (seq === analyzeSeqRef.current) {
        setIsReScoring(false);
      }
    }
  };

  const handleSelectProperty = (propertyId: string) => {
    avmAbortRef.current?.abort();
    explainAbortRef.current?.abort();
    avmSeqRef.current = nextSeq();
    explainSeqRef.current = nextSeq();
    setIsFetchingAvm(false);
    setIsExplaining(false);
    setAvmError(null);
    setExplainError(null);
    setSelectedPropertyId(propertyId);
    setMobileTab('detail');
  };

  const triggerSessionExpiredRecovery = (serverMessage?: string) => {
    const detail = serverMessage ? ` (${serverMessage})` : '';
    const notice =
      `Your server session expired after an idle, restart, or revision window${detail}. ` +
      'Existing listings, map overlays, and AVM values are preserved, and zero paid RentCast calls were repeated automatically. ' +
      'Click Analyze Area explicitly if you want to start a fresh session.';
    setSessionExpiredMessage(notice);
    setLiveAnnouncement(notice);
  };

  const handleFetchAvm = async (propertyId: string) => {
    const activeListing = listings.find((l) => l.id === propertyId);
    const activeSessionId = sessionId ?? 'sess_demo_local';

    avmAbortRef.current?.abort();
    const controller = new AbortController();
    avmAbortRef.current = controller;
    const seq = nextSeq();
    avmSeqRef.current = seq;

    setIsFetchingAvm(true);
    setAvmError(null);

    try {
      const res = await fetchPropertyAvm(
        propertyId,
        {
          sessionId: activeSessionId,
          propertySnapshot: activeListing
            ? {
                formattedAddress: activeListing.formattedAddress,
                city: activeListing.city,
                state: activeListing.state,
                zipCode: activeListing.zipCode,
                latitude: activeListing.latitude,
                longitude: activeListing.longitude,
                propertyType: activeListing.propertyType,
                bedrooms: activeListing.bedrooms,
                bathrooms: activeListing.bathrooms,
                squareFootage: activeListing.squareFootage,
                lotSize: activeListing.lotSize,
                yearBuilt: activeListing.yearBuilt,
                askingPrice: activeListing.askingPrice,
                listingLastSeenAt: activeListing.listingLastSeenAt,
              }
            : undefined,
          useSyntheticDemo,
          clientRequestSeq: seq,
        },
        controller.signal
      );

      if (seq !== avmSeqRef.current || selectedPropertyIdRef.current !== propertyId) {
        return;
      }

      setSessionId(res.sessionId);
      setBudget(res.budget);
      setPropertyDetailsById((prev) => ({
        ...prev,
        [propertyId]: {
          ...res.property,
          accessibility: res.property.accessibility ?? activeListing?.accessibility ?? null,
        },
      }));
      setAvmFromCacheById((prev) => ({ ...prev, [propertyId]: res.fromCache }));
      setAvmDisclaimersById((prev) => ({ ...prev, [propertyId]: res.disclaimers ?? [] }));

      setListings((prev) =>
        prev.map((item) =>
          item.id === propertyId
            ? {
                ...res.property,
                accessibility: res.property.accessibility ?? item.accessibility,
              }
            : item
        )
      );
      setLiveAnnouncement(
        `Loaded RentCast AVM comparison for ${res.property.formattedAddress}.`
      );
    } catch (err) {
      if (isAbortError(err) || seq !== avmSeqRef.current) {
        return;
      }
      const apiErr = err instanceof ApiClientError ? err : null;
      if (apiErr?.budget) {
        setBudget(apiErr.budget);
      }
      if (apiErr?.code === 'SESSION_EXPIRED' || apiErr?.status === 409) {
        triggerSessionExpiredRecovery(apiErr.message);
        setAvmError(
          'Server session expired. Existing data is preserved and zero RentCast calls were repeated automatically.'
        );
        return;
      }
      setAvmError(apiErr?.message ?? 'Unable to fetch RentCast AVM for this property.');
    } finally {
      if (seq === avmSeqRef.current && selectedPropertyIdRef.current === propertyId) {
        setIsFetchingAvm(false);
      }
    }
  };

  const handleExpandSession = async () => {
    if (!sessionId) return;
    setIsExpanding(true);
    try {
      const seq = nextSeq();
      const res = await expandSessionLimit(sessionId, {
        userConfirmed: true,
        clientRequestSeq: seq,
      });
      setBudget(res.budget);
      setLiveAnnouncement(res.message);
    } catch (err) {
      const apiErr = err instanceof ApiClientError ? err : null;
      if (apiErr?.code === 'SESSION_EXPIRED' || apiErr?.status === 409) {
        triggerSessionExpiredRecovery(apiErr.message);
        return;
      }
      setAreaError({
        message: apiErr?.message ?? 'Failed to expand session AVM allowance.',
        retryable: false,
      });
    } finally {
      setIsExpanding(false);
    }
  };

  const handleGenerateExplain = async (propertyId: string) => {
    const activeProperty =
      propertyDetailsById[propertyId] ?? listings.find((l) => l.id === propertyId) ?? null;
    const activeSessionId = sessionId ?? 'sess_demo_local';

    explainAbortRef.current?.abort();
    const controller = new AbortController();
    explainAbortRef.current = controller;
    const seq = nextSeq();
    explainSeqRef.current = seq;

    setIsExplaining(true);
    setExplainError(null);

    try {
      const activeDetail = propertyDetailsById[propertyId];
      const activeSummary = listings.find((l) => l.id === propertyId);
      const propertyContext: PropertyDetailRecord | undefined = activeDetail
        ? activeDetail
        : activeSummary
          ? { ...activeSummary, contraryEvidence: [] }
          : undefined;

      const res = await generateExplanation(
        {
          sessionId: activeSessionId,
          propertyId,
          preferences,
          propertyContext,
          accessibilityContext:
            activeProperty?.accessibility ?? geospatialData?.centerAccessibility ?? undefined,
          environmentalRecords: geospatialData?.environmentalLayer.records.slice(0, 20),
          useSyntheticDemo,
          clientRequestSeq: seq,
        },
        controller.signal
      );

      if (seq !== explainSeqRef.current || selectedPropertyIdRef.current !== propertyId) {
        return;
      }

      setExplainByPropertyId((prev) => ({
        ...prev,
        [propertyId]: res,
      }));
      setLiveAnnouncement('Grounded explanation generated.');
    } catch (err) {
      if (isAbortError(err) || seq !== explainSeqRef.current) {
        return;
      }
      const apiErr = err instanceof ApiClientError ? err : null;
      if (apiErr?.code === 'SESSION_EXPIRED' || apiErr?.status === 409) {
        triggerSessionExpiredRecovery(apiErr.message);
        setExplainError(
          'Server session expired. Existing data is preserved and zero RentCast calls were repeated automatically.'
        );
        return;
      }
      setExplainError(apiErr?.message ?? 'Failed to generate explanation.');
    } finally {
      if (seq === explainSeqRef.current && selectedPropertyIdRef.current === propertyId) {
        setIsExplaining(false);
      }
    }
  };

  const selectedProperty = useMemo(() => {
    if (!selectedPropertyId) return null;
    return (
      propertyDetailsById[selectedPropertyId] ??
      listings.find((l) => l.id === selectedPropertyId) ??
      null
    );
  }, [selectedPropertyId, propertyDetailsById, listings]);

  const activeCategoryCount = useMemo(() => getActiveCategories(preferences).length, [preferences]);

  return (
    <div className="app-root">
      <header className="app-header">
        <div className="header-inner">
          <div>
            <h1 className="app-title">
              Foreal-Estate
              {useSyntheticDemo && (
                <span className="pill pill-demo">SYNTHETIC DEMO FIXTURE — NOT LIVE COVERAGE</span>
              )}
            </h1>
            <p className="app-subtitle">
              Explainable US Location Accessibility &amp; Asking-vs-AVM Comparison (Any US City, ZIP,
              or Bounded Area)
            </p>
          </div>
          <div className="header-badges">
            <span className="pill pill-neutral">Straight-Line Geodesic Math</span>
            <span className="pill pill-neutral">AVM ≠ Appraisal</span>
          </div>
        </div>
      </header>

      <div className="sr-only" role="status" aria-live="polite">
        {liveAnnouncement}
      </div>

      <main className="app-main">
        <SetupAndDemoBanner
          config={config}
          configLoading={configLoading}
          configError={configError}
          useSyntheticDemo={useSyntheticDemo}
          onToggleSyntheticDemo={handleToggleSyntheticDemo}
          onRetryConfig={() => void loadConfig()}
        />

        {sessionExpiredMessage && (
          <section
            className="banner banner-session-expired"
            role="alert"
            aria-live="assertive"
            data-testid="session-expired-banner"
          >
            <div className="banner-content">
              <div className="banner-heading">
                <span className="pill pill-session-expired">Session Expired (409)</span>
                <strong>Session-Expiry Recovery — Context Preserved</strong>
              </div>
              <p className="muted-sm">{sessionExpiredMessage}</p>
            </div>
            <div className="banner-actions">
              {confirmedArea && (
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={handleAnalyzeArea}
                  disabled={isAnalyzing}
                >
                  Analyze Area (Start Fresh Session)
                </button>
              )}
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setSessionExpiredMessage(null)}
              >
                Dismiss
              </button>
            </div>
          </section>
        )}

        <div className="top-workspace-row">
          <RegionSearchBar
            query={query}
            radiusMeters={radiusMeters}
            resolveStatus={resolveStatus}
            resolveMessage={resolveMessage}
            candidates={candidates}
            confirmedArea={confirmedArea}
            isResolving={isResolving}
            isAnalyzing={isAnalyzing}
            useSyntheticDemo={useSyntheticDemo}
            onQueryChange={setQuery}
            onRadiusChange={handleRadiusChange}
            onResolve={handleResolveRegion}
            onSelectCandidate={handleSelectCandidate}
            onAnalyzeArea={handleAnalyzeArea}
          />

          <BudgetMeter
            config={config}
            budget={budget}
            sessionId={sessionId}
            isExpanding={isExpanding}
            useSyntheticDemo={useSyntheticDemo}
            onExpandSession={handleExpandSession}
          />
        </div>

        {/* Mobile Tab Switcher (< 1024px) */}
        <nav className="mobile-tabs" aria-label="Workspace sections">
          {(
            [
              ['map', 'Map'],
              ['listings', `Listings (${listings.length})`],
              ['detail', 'Selected Home'],
              ['preferences', 'Preferences'],
            ] as Array<[MobileTab, string]>
          ).map(([tabKey, label]) => (
            <button
              key={tabKey}
              type="button"
              className={`mobile-tab-btn ${mobileTab === tabKey ? 'mobile-tab-active' : ''}`}
              aria-pressed={mobileTab === tabKey}
              onClick={() => setMobileTab(tabKey)}
            >
              {label}
            </button>
          ))}
        </nav>

        {/* Main Responsive Workspace Grid */}
        <div className="workspace-grid">
          <div className={`workspace-col-left ${mobileTab === 'map' ? 'mobile-visible' : 'mobile-hidden'}`}>
            <MapViewport
              mapsBrowserKey={config?.mapsBrowserKey ?? null}
              analysisArea={geospatialData?.analysisArea ?? confirmedArea}
              influenceFetchRadiusMeters={geospatialData?.influenceFetchRadiusMeters ?? null}
              centerAccessibility={geospatialData?.centerAccessibility ?? null}
              preferences={preferences}
              visibleCategories={visibleCategories}
              showPlacesContext={showPlacesContext}
              amenities={geospatialData?.amenities ?? []}
              gridOverlap={geospatialData?.gridOverlap ?? null}
              environmentalLayerStatus={geospatialData?.environmentalLayer.status ?? null}
              environmentalRecords={geospatialData?.environmentalLayer.records ?? []}
              displayOnlyPlacesContext={geospatialData?.displayOnlyPlacesContext ?? []}
              listings={listings}
              selectedPropertyId={selectedPropertyId}
              onSelectProperty={handleSelectProperty}
              onAnalyzeViewportCenter={(center, r) => void handleAnalyzeViewportCenter(center, r)}
            />

            <AccessibleLegends
              activeCategoryCount={activeCategoryCount}
              maxObservedOverlap={geospatialData?.gridOverlap.maxOverlapCount ?? 0}
              sourceDates={{
                osmOverpass: geospatialData ? formatIsoDate(geospatialData.fetchedAt) : null,
                epaFrs: geospatialData ? formatIsoDate(geospatialData.fetchedAt) : null,
                googlePlaces:
                  geospatialData && geospatialData.displayOnlyPlacesContext.length > 0
                    ? formatIsoDate(geospatialData.fetchedAt)
                    : null,
                rentCastAvm: selectedProperty?.avmFetchedAt
                  ? formatIsoDate(selectedProperty.avmFetchedAt)
                  : null,
              }}
            />
          </div>

          <div
            className={`workspace-col-right ${
              mobileTab === 'listings' || mobileTab === 'detail' || mobileTab === 'preferences'
                ? 'mobile-visible'
                : 'mobile-hidden'
            }`}
          >
            <div className={mobileTab === 'preferences' ? 'mobile-visible' : 'mobile-hidden-panel'}>
              <PreferenceControls
                preferences={preferences}
                visibleCategories={visibleCategories}
                showPlacesContext={showPlacesContext}
                placesContextAvailable={(geospatialData?.displayOnlyPlacesContext.length ?? 0) > 0}
                hasAnalyzedArea={Boolean(confirmedArea && geospatialData)}
                isReScoring={isReScoring}
                onChangePreferences={setPreferences}
                onToggleCategoryLayer={(cat) =>
                  setVisibleCategories((prev) => ({ ...prev, [cat]: !prev[cat] }))
                }
                onTogglePlacesContext={setShowPlacesContext}
                onResetDefaults={() => {
                  setPreferences(
                    config?.defaultPreferences
                      ? clonePreferences(config.defaultPreferences)
                      : createClientDefaultPreferences()
                  );
                  setVisibleCategories(INITIAL_VISIBLE_CATEGORIES);
                }}
                onApplyAndRescore={() => void handleApplyPreferencesAndRescore()}
              />
            </div>

            <div className={mobileTab === 'listings' ? 'mobile-visible' : 'mobile-hidden-panel'}>
              <PropertyListPanel
                listings={listings}
                selectedPropertyId={selectedPropertyId}
                uiState={areaUiState}
                errorMessage={areaError?.message ?? null}
                retryable={areaError?.retryable ?? false}
                isSyntheticDemo={useSyntheticDemo || Boolean(geospatialData?.isSyntheticDemo)}
                externalityPenaltyWeight={preferences.optionalExternalityPenaltyWeight ?? 0}
                onSelectProperty={handleSelectProperty}
                onRetrySearch={handleAnalyzeArea}
              />
            </div>

            <div className={mobileTab === 'detail' ? 'mobile-visible' : 'mobile-hidden-panel'}>
              <PropertyDetailDrawer
                property={selectedProperty}
                environmentalRecords={geospatialData?.environmentalLayer.records ?? []}
                geospatialFetchedAt={geospatialData?.fetchedAt ?? null}
                externalityPenaltyWeight={preferences.optionalExternalityPenaltyWeight ?? 0}
                isFetchingAvm={isFetchingAvm}
                avmError={avmError}
                avmFromCache={
                  selectedPropertyId ? Boolean(avmFromCacheById[selectedPropertyId]) : false
                }
                avmDisclaimers={
                  selectedPropertyId ? avmDisclaimersById[selectedPropertyId] ?? [] : []
                }
                explainResponse={
                  selectedPropertyId ? explainByPropertyId[selectedPropertyId] ?? null : null
                }
                isExplaining={isExplaining}
                explainError={explainError}
                isSyntheticDemo={useSyntheticDemo}
                onFetchAvm={(id) => void handleFetchAvm(id)}
                onGenerateExplain={(id) => void handleGenerateExplain(id)}
              />
            </div>
          </div>
        </div>
      </main>

      <footer className="app-footer">
        <div className="footer-inner">
          <div className="footer-section">
            <strong>Mandatory Guardrails &amp; Non-Claims</strong>
            <ul>
              {(geospatialData?.nonClaims ?? MANDATORY_NON_CLAIMS).map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
          <div className="footer-section">
            <strong>Data Sources &amp; Attributions</strong>
            <ul>
              {(
                geospatialData?.sourceAttributions ??
                config?.attributions ??
                DEFAULT_SOURCE_ATTRIBUTIONS
              ).map((attr, i) => (
                <li key={i}>{attr}</li>
              ))}
            </ul>
            <p className="muted-xs">
              Active categories: {AMENITY_CATEGORIES.filter((c) => preferences.weights[c] > 0).length}
              /{AMENITY_CATEGORIES.length} (`fast_food` weight: {preferences.weights.fast_food})
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
};

export default App;
