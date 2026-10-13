# Contributing

Thanks for helping. Bug reports, fixes and docs are all welcome.

## Setup

You need Node.js 22 and pnpm 9.

```bash
pnpm install
pnpm --filter @evobridge/server demo:providers
ALLOW_PRIVATE_NETWORKS=true pnpm --filter @evobridge/server dev
pnpm --filter @evobridge/web dev
```

## Layout

- **`apps/server`:** the Fastify API, webhook ingress, durable queue, worker and provider clients.
- **`apps/web`:** the dashboard, built with Next.js App Router and exported as static files.
- **`packages/shared`:** Zod schemas and types shared by both.
- **`docs/research`:** what Evolution Go and Chatwoot actually do, read from their source.

## Before opening a pull request

- Run `pnpm typecheck` and `pnpm test`.
- If you touched the dashboard, also run `pnpm build && pnpm test:e2e`.
- **New provider behavior needs a test** against the fake providers in `apps/server/test/mocks`. Shape the payloads after real ones: link the source in the PR, or paste a redacted real payload.
- **Don't claim support for a message type or provider version without a test for it.**
- Keep it simple. EvoBridge is one container with SQLite on purpose.

## Commit style

Write short imperative subjects: "Retry media downloads before posting a placeholder".
