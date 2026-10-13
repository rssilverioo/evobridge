const SECRET_KEYS = /^(apikey|api_key|api_access_token|access_token|token|instancetoken|password|secret|authorization|cookie|hmac_token|secret_enc|hook_secret|password_hash|base64)$/i;

/** Deep-copies a value replacing secrets and bulky media with placeholders. Used before logging. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[depth]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_KEYS.test(k)) out[k] = typeof v === 'string' && v.length > 0 ? '[redacted]' : v;
      else out[k] = redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 2000) return `${value.slice(0, 64)}…[${value.length} chars]`;
  return value;
}

/** Hides the secret path segment of webhook URLs: /hooks/evolution/con_x/<secret> -> …/••••. */
export function redactUrl(url: string): string {
  return url.replace(/(\/hooks\/(?:evolution|chatwoot)\/[^/]+\/)[^/?#]+/, '$1••••');
}

/** Pino redaction paths for request logging. */
export const LOG_REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers.apikey',
  'req.headers.api_access_token',
  'res.headers["set-cookie"]',
];
