import dns from 'node:dns';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, type Dispatcher, FormData, fetch } from 'undici';
import { ProviderError } from './errors.js';

/** Cloud metadata endpoints are never reachable, even with ALLOW_PRIVATE_NETWORKS. */
const ALWAYS_BLOCKED = ['169.254.169.254', 'fd00:ec2::254', '100.100.100.200'];

const PRIVATE_RANGES = new Set([
  'unspecified',
  'broadcast',
  'multicast',
  'linkLocal',
  'loopback',
  'carrierGradeNat',
  'private',
  'reserved',
  'uniqueLocal',
  'ipv4Mapped',
  'rfc6145',
  'rfc6052',
  '6to4',
  'teredo',
  'benchmarking',
  'amt',
  'as112',
  'deprecated',
  'orchid2',
  'droneRemoteIdProtocolEntityTags',
]);

export function isBlockedAddress(address: string, allowPrivate: boolean): boolean {
  if (!ipaddr.isValid(address)) return true;
  let parsed = ipaddr.parse(address);
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    parsed = (parsed as ipaddr.IPv6).toIPv4Address();
  }
  if (ALWAYS_BLOCKED.includes(parsed.toString())) return true;
  if (allowPrivate) return false;
  return PRIVATE_RANGES.has(parsed.range());
}

/** Validates the URL shape and, for IP literals, the address. Hostnames are checked at connect time. */
export function assertSafeUrl(raw: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError('blocked_url', 'Invalid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ProviderError('blocked_url', 'Only http and https URLs are allowed');
  }
  if (url.username || url.password) throw new ProviderError('blocked_url', 'URLs with credentials are not allowed');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedAddress(host, allowPrivate)) throw blockedError(host);
  if (!allowPrivate && (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal'))) {
    throw blockedError(host);
  }
  return url;
}

function blockedError(host: string): ProviderError {
  return new ProviderError(
    'blocked_url',
    `${host} is a private or local address`,
    undefined,
    'EvoBridge blocks private networks by default. If Evolution Go or Chatwoot run on the same private network, set ALLOW_PRIVATE_NETWORKS=true.',
  );
}

/**
 * DNS lookup that refuses private addresses. Running the check at connect time (not only
 * when the URL is saved) closes the DNS-rebinding gap.
 */
function guardedLookup(allowPrivate: boolean): net.LookupFunction {
  return (hostname, options, callback) => {
    dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, '', 0);
      const list = addresses as unknown as dns.LookupAddress[];
      const bad = list.find((a) => isBlockedAddress(a.address, allowPrivate));
      if (bad) {
        const e = new Error(`blocked address ${bad.address}`) as NodeJS.ErrnoException;
        e.code = 'EBLOCKED';
        return callback(e, '', 0);
      }
      if ((options as dns.LookupOptions).all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, list);
      const first = list[0];
      if (!first) return callback(new Error(`no address for ${hostname}`), '', 0);
      callback(null, first.address, first.family);
    });
  };
}

export interface HttpRequest {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  json?: unknown;
  form?: FormData;
  /** Sent byte-for-byte (used to forward webhooks without re-serializing). */
  rawBody?: string;
  timeoutMs?: number;
  /** Max response body size; protects against huge media downloads. */
  maxBytes?: number;
  /** Follow up to 5 redirects, re-checking every hop against the SSRF policy. Off by default. */
  followRedirects?: boolean;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  body: Buffer;
  json<T = unknown>(): T;
  text(): string;
}

export interface HttpClient {
  request(url: string, req?: HttpRequest): Promise<HttpResponse>;
  requestOnce(url: string, req: HttpRequest): Promise<HttpResponse>;
  readonly allowPrivate: boolean;
  close(): Promise<void>;
}

export function createHttpClient(opts: { allowPrivate: boolean; userAgent: string }): HttpClient {
  const dispatcher: Dispatcher = new Agent({
    connect: { lookup: guardedLookup(opts.allowPrivate), timeout: 10_000 },
    headersTimeout: 30_000,
    bodyTimeout: 60_000,
  });

  return {
    allowPrivate: opts.allowPrivate,
    async close() {
      await dispatcher.close();
    },
    async request(rawUrl, req = {}) {
      let current = rawUrl;
      for (let hop = 0; ; hop++) {
        const res = await this.requestOnce(current, req);
        const location = res.headers.get('location');
        if (!req.followRedirects || res.status < 300 || res.status >= 400 || !location) return res;
        if (hop >= 5) throw new ProviderError('bad_response', 'Too many redirects');
        current = new URL(location, current).toString();
        // Redirects switch to GET without a body, like browsers do for 301/302/303.
        req = { ...req, method: 'GET', json: undefined, form: undefined, rawBody: undefined, headers: stripAuth(req.headers) };
      }
    },
    async requestOnce(rawUrl: string, req: HttpRequest): Promise<HttpResponse> {
      const url = assertSafeUrl(rawUrl, opts.allowPrivate);
      const headers: Record<string, string> = { 'user-agent': opts.userAgent, accept: 'application/json', ...req.headers };
      let body: string | FormData | undefined;
      if (req.json !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(req.json);
      } else if (req.form) {
        body = req.form;
      } else if (req.rawBody !== undefined) {
        body = req.rawBody;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), req.timeoutMs ?? 20_000);
      try {
        const res = await fetch(url, {
          method: req.method ?? 'GET',
          headers,
          body,
          dispatcher,
          signal: controller.signal,
          redirect: 'manual',
        });
        const body2 = await readLimited(res, req.maxBytes ?? 10 * 1024 * 1024);
        return {
          status: res.status,
          headers: res.headers as unknown as Headers,
          body: body2,
          text: () => body2.toString('utf8'),
          json: <T>() => {
            try {
              return JSON.parse(body2.toString('utf8')) as T;
            } catch {
              throw new ProviderError('bad_response', `Expected JSON from ${url.host}, got ${res.headers.get('content-type') ?? 'unknown content'}`, res.status);
            }
          },
        };
      } catch (err) {
        throw toNetworkError(err, url);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Never forward provider credentials to a redirect target (e.g. S3 behind Chatwoot). */
function stripAuth(headers: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!headers) return headers;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (!['apikey', 'api_access_token', 'authorization', 'cookie'].includes(k.toLowerCase())) out[k] = v;
  }
  return out;
}

async function readLimited(res: Awaited<ReturnType<typeof fetch>>, maxBytes: number): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > maxBytes) {
    await res.body?.cancel();
    throw new ProviderError('bad_response', `Response too large (${declared} bytes, limit ${maxBytes})`, res.status);
  }
  if (!res.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.length;
    if (size > maxBytes) {
      await res.body.cancel();
      throw new ProviderError('bad_response', `Response larger than ${maxBytes} bytes`, res.status);
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function toNetworkError(err: unknown, url: URL): ProviderError {
  if (err instanceof ProviderError) return err;
  const e = err as { name?: string; code?: string; cause?: { code?: string; message?: string } };
  const code = e.cause?.code ?? e.code;
  if (e.name === 'AbortError') return new ProviderError('timeout', `${url.host} did not answer in time`);
  if (code === 'EBLOCKED' || e.cause?.message?.startsWith('blocked address')) return blockedError(url.hostname);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new ProviderError('unreachable', `Could not resolve ${url.hostname}`, undefined, 'Check the URL spelling and DNS.');
  if (code === 'ECONNREFUSED') return new ProviderError('unreachable', `Connection refused by ${url.host}`, undefined, 'Is the service running and the port correct?');
  if (code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return new ProviderError('timeout', `Timed out connecting to ${url.host}`);
  if (code?.startsWith('ERR_TLS') || code === 'CERT_HAS_EXPIRED' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return new ProviderError('unreachable', `TLS error talking to ${url.host} (${code})`, undefined, 'The certificate is invalid or self-signed.');
  }
  return new ProviderError('unreachable', `Could not reach ${url.host}${code ? ` (${code})` : ''}`);
}

/** Maps HTTP status codes from providers onto error kinds. */
export function statusError(status: number, provider: string, detail?: string, retryAfter?: string | null): ProviderError {
  const suffix = detail ? `: ${detail}` : '';
  if (status === 401) return new ProviderError('unauthorized', `${provider} rejected the credentials${suffix}`, status);
  if (status === 403) return new ProviderError('forbidden', `${provider} denied access${suffix}`, status);
  if (status === 404) return new ProviderError('not_found', `${provider} returned 404${suffix}`, status);
  if (status === 429) {
    const secs = Number(retryAfter);
    return new ProviderError('rate_limited', `${provider} is rate limiting requests`, status, undefined, Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined);
  }
  if (status >= 500) return new ProviderError('server_error', `${provider} returned ${status}${suffix}`, status);
  return new ProviderError('client_error', `${provider} returned ${status}${suffix}`, status);
}

export { FormData };
