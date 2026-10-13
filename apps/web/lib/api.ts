import type { ApiError } from '@evobridge/shared';

/** Error thrown for non-2xx API responses, carrying the server's code, hint and field errors. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
  }
}

let csrfToken: string | null = null;

export function setCsrfToken(token: string | null) {
  csrfToken = token;
}

/** Called when the API answers 401, so the shell can send the user to sign in. */
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['x-csrf-token'] = csrfToken;
  let res: Response;
  try {
    res = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  } catch {
    throw new ApiRequestError(0, 'network', 'EvoBridge is not responding. Check that the server is running.');
  }
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (data as ApiError | null)?.error;
    if (res.status === 401 && !path.startsWith('/api/auth/')) onUnauthorized?.();
    throw new ApiRequestError(res.status, err?.code ?? 'error', err?.message ?? `Request failed (${res.status})`, err?.hint, err?.fields);
  }
  const maybe = data as { csrfToken?: string } | null;
  if (maybe && typeof maybe === 'object' && typeof maybe.csrfToken === 'string') csrfToken = maybe.csrfToken;
  return data as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  del: <T>(path: string, body?: unknown) => request<T>('DELETE', path, body ?? {}),
};

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
