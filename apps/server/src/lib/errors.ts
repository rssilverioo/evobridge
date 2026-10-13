/** An error that is safe to show to the dashboard user. */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly hint?: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const notFound = (what: string) => new AppError(404, 'not_found', `${what} not found`);
export const badRequest = (message: string, hint?: string, fields?: Record<string, string>) =>
  new AppError(400, 'bad_request', message, hint, fields);
export const conflict = (message: string, hint?: string) => new AppError(409, 'conflict', message, hint);

export type ProviderErrorKind =
  | 'blocked_url'
  | 'unreachable'
  | 'timeout'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'not_activated'
  | 'rate_limited'
  | 'bad_response'
  | 'server_error'
  | 'client_error';

/** Failure talking to Evolution Go or Chatwoot, classified so the queue knows whether to retry. */
export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly status?: number,
    readonly hint?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }

  /** Transient failures are retried with backoff; the rest go straight to the dead-letter queue. */
  get retryable(): boolean {
    return ['unreachable', 'timeout', 'rate_limited', 'server_error', 'not_activated'].includes(this.kind);
  }
}

/** Raised by handlers when an event must not be retried (bad payload, unsupported, misconfiguration). */
export class PermanentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentError';
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
