import type {
  ApiErrorCode,
  ApiErrorResponse,
  ExplainRequest,
  ExplainResponse,
  GeospatialAnalyzeRequest,
  GeospatialAnalyzeResponse,
  PropertyAvmRequest,
  PropertyAvmResponse,
  PropertySearchRequest,
  PropertySearchResponse,
  PublicRuntimeConfig,
  RegionResolveRequest,
  RegionResolveResponse,
  SessionExpandRequest,
  SessionExpandResponse,
  UiState,
} from '../../shared/types';

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: ApiErrorCode | 'NETWORK_ERROR' | 'ABORTED';
  readonly uiState: UiState;
  readonly retryable: boolean;
  readonly missingEnvVarNames: string[];
  readonly budget: ApiErrorResponse['budget'];
  readonly clientRequestSeq?: number;

  constructor(params: {
    message: string;
    status: number;
    code: ApiErrorCode | 'NETWORK_ERROR' | 'ABORTED';
    uiState?: UiState;
    retryable?: boolean;
    missingEnvVarNames?: string[];
    budget?: ApiErrorResponse['budget'];
    clientRequestSeq?: number;
  }) {
    super(params.message);
    this.name = 'ApiClientError';
    this.status = params.status;
    this.code = params.code;
    this.uiState = params.uiState ?? 'recovery';
    this.retryable = params.retryable ?? true;
    this.missingEnvVarNames = params.missingEnvVarNames ?? [];
    this.budget = params.budget ?? null;
    this.clientRequestSeq = params.clientRequestSeq;
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof ApiClientError && error.code === 'ABORTED') {
    return true;
  }
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: string }).name === 'AbortError'
  );
}

function mapCodeToUiState(code: ApiErrorCode): UiState {
  switch (code) {
    case 'UNSUPPORTED_AREA':
      return 'unsupported_area';
    case 'SETUP_NEEDED':
      return 'setup_needed';
    case 'SESSION_CAP_REACHED':
    case 'GLOBAL_QUOTA_EXHAUSTED':
    case 'BUDGET_STORE_UNAVAILABLE':
      return 'quota_exhausted';
    case 'UPSTREAM_TIMEOUT':
      return 'timeout';
    case 'NOT_FOUND':
      return 'empty';
    default:
      return 'recovery';
  }
}

async function requestJson<TResponse>(
  url: string,
  options: RequestInit & { clientRequestSeq?: number } = {}
): Promise<TResponse> {
  const { clientRequestSeq, ...fetchInit } = options;

  let response: Response;
  try {
    response = await fetch(url, {
      ...fetchInit,
      headers: {
        Accept: 'application/json',
        ...(fetchInit.body ? { 'Content-Type': 'application/json' } : {}),
        ...(fetchInit.headers ?? {}),
      },
    });
  } catch (err) {
    if (isAbortError(err)) {
      throw new ApiClientError({
        message: 'Request cancelled because a newer request superseded it.',
        status: 0,
        code: 'ABORTED',
        uiState: 'loading',
        retryable: false,
        clientRequestSeq,
      });
    }
    throw new ApiClientError({
      message: err instanceof Error ? err.message : 'Network error reaching server.',
      status: 0,
      code: 'NETWORK_ERROR',
      uiState: 'recovery',
      retryable: true,
      clientRequestSeq,
    });
  }

  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    const apiErr = (parsed ?? null) as Partial<ApiErrorResponse> | null;
    if (apiErr && apiErr.error && typeof apiErr.error.message === 'string') {
      const code = apiErr.error.code ?? 'INTERNAL_ERROR';
      throw new ApiClientError({
        message: apiErr.error.message,
        status: response.status,
        code,
        uiState: apiErr.error.uiState ?? mapCodeToUiState(code),
        retryable: apiErr.error.retryable ?? response.status >= 500,
        missingEnvVarNames: apiErr.error.missingEnvVarNames ?? [],
        budget: apiErr.budget ?? null,
        clientRequestSeq: apiErr.clientRequestSeq ?? clientRequestSeq,
      });
    }

    throw new ApiClientError({
      message: `Request failed with HTTP ${response.status}.`,
      status: response.status,
      code: response.status === 504 ? 'UPSTREAM_TIMEOUT' : 'PROVIDER_ERROR',
      uiState: response.status === 504 ? 'timeout' : 'recovery',
      retryable: true,
      clientRequestSeq,
    });
  }

  return parsed as TResponse;
}

export function fetchRuntimeConfig(signal?: AbortSignal): Promise<PublicRuntimeConfig> {
  return requestJson<PublicRuntimeConfig>('/api/config', {
    method: 'GET',
    signal,
  });
}

export function resolveRegion(
  payload: RegionResolveRequest,
  signal?: AbortSignal
): Promise<RegionResolveResponse> {
  return requestJson<RegionResolveResponse>('/api/regions/resolve', {
    method: 'POST',
    body: JSON.stringify(payload),
    signal,
    clientRequestSeq: payload.clientRequestSeq,
  });
}

export function analyzeGeospatial(
  payload: GeospatialAnalyzeRequest,
  signal?: AbortSignal
): Promise<GeospatialAnalyzeResponse> {
  return requestJson<GeospatialAnalyzeResponse>('/api/geospatial/analyze', {
    method: 'POST',
    body: JSON.stringify(payload),
    signal,
    clientRequestSeq: payload.clientRequestSeq,
  });
}

export function searchProperties(
  payload: PropertySearchRequest,
  signal?: AbortSignal
): Promise<PropertySearchResponse> {
  return requestJson<PropertySearchResponse>('/api/properties/search', {
    method: 'POST',
    body: JSON.stringify(payload),
    signal,
    clientRequestSeq: payload.clientRequestSeq,
  });
}

export function fetchPropertyAvm(
  propertyId: string,
  payload: PropertyAvmRequest,
  signal?: AbortSignal
): Promise<PropertyAvmResponse> {
  return requestJson<PropertyAvmResponse>(
    `/api/properties/${encodeURIComponent(propertyId)}/avm`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
      signal,
      clientRequestSeq: payload.clientRequestSeq,
    }
  );
}

export function expandSessionLimit(
  sessionId: string,
  payload: SessionExpandRequest,
  signal?: AbortSignal
): Promise<SessionExpandResponse> {
  return requestJson<SessionExpandResponse>(
    `/api/sessions/${encodeURIComponent(sessionId)}/expand`,
    {
      method: 'POST',
      body: JSON.stringify(payload),
      signal,
      clientRequestSeq: payload.clientRequestSeq,
    }
  );
}

export function generateExplanation(
  payload: ExplainRequest,
  signal?: AbortSignal
): Promise<ExplainResponse> {
  return requestJson<ExplainResponse>('/api/explain', {
    method: 'POST',
    body: JSON.stringify(payload),
    signal,
    clientRequestSeq: payload.clientRequestSeq,
  });
}
