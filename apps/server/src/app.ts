import fs from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import Fastify, { type FastifyInstance, LogController } from 'fastify';
import { hasZodFastifySchemaValidationErrors, jsonSchemaTransform, serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Config } from './config.js';
import type { Ctx } from './context.js';
import { AppError, ProviderError } from './lib/errors.js';
import { LOG_REDACT_PATHS, redactUrl } from './lib/redact.js';
import { apiRoutes } from './routes/api.js';
import { hookRoutes } from './routes/hooks.js';

export function createLogger(config: Pick<Config, 'logLevel' | 'isDev'>) {
  return {
    level: config.logLevel,
    redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' },
    serializers: {
      req: (req: { method: string; url: string; ip?: string }) => ({ method: req.method, url: redactUrl(req.url), ip: req.ip }),
    },
    ...(config.isDev && process.stdout.isTTY ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } } : {}),
  };
}

/** Builds the HTTP app around an existing context. Separate from boot so tests can inject. */
export async function buildApp(ctx: Ctx, app: FastifyInstance): Promise<FastifyInstance> {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    // Providers burst; webhooks are authenticated by secret instead.
    allowList: (req) => req.url.startsWith('/hooks/') || req.url === '/healthz',
  });

  await app.register(swagger, {
    openapi: {
      info: { title: 'EvoBridge internal API', version: ctx.config.version, description: 'API used by the EvoBridge dashboard. Session cookie + x-csrf-token header.' },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/api/docs' });

  app.setErrorHandler((err, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      const fields: Record<string, string> = {};
      for (const issue of err.validation) {
        const key = issue.instancePath.replace(/^\//, '').replace(/\//g, '.') || 'body';
        fields[key] ??= issue.message ?? 'Invalid value';
      }
      return reply.code(400).send({ error: { code: 'validation', message: Object.values(fields)[0] ?? 'Invalid request', fields } });
    }
    if (err instanceof AppError) {
      return reply.code(err.status).send({ error: { code: err.code, message: err.message, hint: err.hint, fields: err.fields } });
    }
    if (err instanceof ProviderError) {
      return reply.code(502).send({ error: { code: `provider_${err.kind}`, message: err.message, hint: err.hint } });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status === 429) return reply.code(429).send({ error: { code: 'rate_limited', message: 'Too many requests. Try again in a minute.' } });
    if (status < 500) return reply.code(status).send({ error: { code: 'bad_request', message: (err as Error).message } });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong on the server. Check the EvoBridge logs.' } });
  });

  app.get('/healthz', async () => {
    await ctx.db.selectFrom('settings').select('key').limit(1).execute();
    return { ok: true, version: ctx.config.version };
  });

  await app.register(async (scope) => hookRoutes(scope, ctx));
  await app.register(async (scope) => apiRoutes(scope, ctx));

  // Dashboard: static export. Unknown paths fall back to the app shell (client routing).
  if (fs.existsSync(path.join(ctx.config.webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: ctx.config.webDir, wildcard: false, extensions: ['html'] });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/') || req.url.startsWith('/hooks/')) {
        return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
      }
      const clean = req.url.split('?')[0]!.replace(/\/+$/, '');
      const candidate = path.join(ctx.config.webDir, `${clean}.html`);
      if (clean && candidate.startsWith(ctx.config.webDir) && fs.existsSync(candidate)) return reply.sendFile(`${clean.slice(1)}.html`);
      return reply.sendFile('index.html');
    });
  } else {
    app.get('/', async () => ({ ok: true, message: 'Dashboard not built. Run `pnpm build` or use `pnpm dev`.' }));
  }

  return app;
}

export function newFastify(config: Config): FastifyInstance {
  return Fastify({
    logger: createLogger(config),
    trustProxy: config.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
    logController: new LogController({ disableRequestLogging: true }),
  });
}
