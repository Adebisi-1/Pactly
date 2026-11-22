/**
 * Typed fetch client for `/api/*` (proxied to the backend by
 * `vite.config.ts`, prefix stripped, so the browser never hits CORS). The
 * one place a non-2xx response is turned into a typed {@link ApiError}
 * carrying the backend's own `{code, message, details?}` envelope (AD-11)
 * -- every screen catches this shape, never a raw `Response`.
 */

export interface ApiErrorEnvelope {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(envelope: ApiErrorEnvelope, status: number) {
    super(envelope.message);
    this.name = "ApiError";
    this.code = envelope.code;
    this.status = status;
    this.details = envelope.details;
  }
}

function authHeaders(token?: string): HeadersInit | undefined {
  return token ? { authorization: `Bearer ${token}` } : undefined;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError({ code: "NETWORK", message: "Connection dropped. Your deposit is untouched." }, 0);
  }

  if (!response.ok) {
    const envelope = await response
      .json()
      .catch(() => ({ code: "unknown_error", message: "Connection dropped. Your deposit is untouched." }));
    throw new ApiError(envelope as ApiErrorEnvelope, response.status);
  }

  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

export function apiGet<T>(path: string, token?: string): Promise<T> {
  return request<T>(path, { headers: authHeaders(token) });
}

export function apiPost<T>(path: string, body: unknown, token?: string): Promise<T> {
  return request<T>(path, { method: "POST", headers: authHeaders(token), body: JSON.stringify(body) });
}

export function apiPut<T>(path: string, body: unknown, token?: string): Promise<T> {
  return request<T>(path, { method: "PUT", headers: authHeaders(token), body: JSON.stringify(body) });
}

/** A file download (`GET .../export`) -- the same typed error boundary as
 * `request`, but the body is a blob rather than JSON. */
export interface DownloadResult {
  blob: Blob;
  filename: string | undefined;
}

export async function apiDownload(path: string, token?: string): Promise<DownloadResult> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, { headers: authHeaders(token) });
  } catch {
    throw new ApiError({ code: "NETWORK", message: "Connection dropped. Your deposit is untouched." }, 0);
  }
  if (!response.ok) {
    const envelope = await response
      .json()
      .catch(() => ({ code: "unknown_error", message: "The export could not be built." }));
    throw new ApiError(envelope as ApiErrorEnvelope, response.status);
  }
  const disposition = response.headers.get("content-disposition") ?? "";
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1];
  return { blob: await response.blob(), filename };
}
