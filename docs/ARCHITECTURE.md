# EvoBridge architecture

EvoBridge connects Evolution Go (WhatsApp) instances to Chatwoot API-channel inboxes. This document records the design and the decisions behind it. The API facts it relies on were verified against source code, not docs; see [`docs/research`](research/).

## Goals, in priority order

1. Install with one `docker compose up -d`, no external database or queue.
2. Connect a WhatsApp instance to an inbox from the dashboard, without copying IDs or editing webhooks by hand.
3. Never lose, duplicate or loop a message.
4. Keep provider credentials safe.
5. A calm, fast dashboard.
6. Code a newcomer can read in an afternoon.

## Shape

One Node.js process, one SQLite file.

```
                 ┌──────────────────────── EvoBridge (one process) ────────────────────────┐
 Browser ──────▶ │ Fastify ─ /api/*      dashboard API (session cookie + CSRF header)      │
                 │         ─ /*          static dashboard (Next.js static export)           │
 Evolution Go ─▶ │         ─ /hooks/evolution/:connectionId/:secret ─┐                      │
 Chatwoot ─────▶ │         ─ /hooks/chatwoot/:connectionId/:secret ──┤ verify, enqueue, 200 │
                 │                                                    ▼                      │
                 │   jobs table (durable queue) ──▶ worker ──▶ handlers ──▶ provider clients │
                 │   SQLite (WAL): users, sessions, providers, connections, contacts,        │
                 │                 message_links, jobs, events                               │
                 └──────────────────────────────────────────────────────────────────────────┘
```

- **Monorepo:** `apps/server` (Fastify, TypeScript), `apps/web` (Next.js App Router, `output: 'export'`), `packages/shared` (Zod schemas and DTO types used by both).
- **Why a static export instead of a Next.js server:** a single process is the only writer to SQLite, there is one port to expose, and the image stays small. The dashboard is a client app talking to `/api`. Dynamic pages use query strings (`/connections/view?id=…`) because static export can't generate unknown paths.
- **Persistence:** SQLite through Kysely, WAL mode, versioned migrations bundled in code. Kysely has a PostgreSQL dialect, and the schema uses only portable types (TEXT timestamps, INTEGER booleans, TEXT JSON), so moving to Postgres later is a dialect swap plus a migration review, not a rewrite.

## Webhook ingress

Both providers call a URL that contains the connection id and a random 32-byte secret.

| | Evolution Go | Chatwoot |
|---|---|---|
| Signature | none exists | `X-Chatwoot-Signature: sha256=HMAC(secret, "<ts>.<raw body>")` since v4.13, verified when the inbox secret is known (admin token) |
| Extra check | `instanceToken` in the body must match the connection's instance | timestamp within 5 minutes |
| Retries | 5 attempts, 30 s apart, unordered | **none**, 5 s timeout |

The handler validates, stores the payload (encrypted) as a job with a unique dedupe key, and answers `200` immediately. Chatwoot's 5 s timeout and lack of retries make synchronous processing a known source of lost and duplicated agent replies in other bridges.

## Provisioning (the "Connect" button)

An ordered list of idempotent steps, stored on the connection so a failed run can resume:

1. **validate**: both providers answer, the instance exists, the Chatwoot account role is `administrator`, and a public URL is set.
2. **register**: the connection row exists (created up front, so retries reuse it).
3. **chatwoot_inbox**: create the API inbox, or reuse the chosen one. Read its webhook signing `secret`.
4. **evolution_webhook**: `POST /instance/connect` with the instance token. Evolution Go has **one** webhook URL per instance, and this call overwrites the URL, subscriptions and the RabbitMQ/NATS/WebSocket flags. EvoBridge re-sends the existing flags, merges subscriptions (theirs ∪ `MESSAGE, SEND_MESSAGE, READ_RECEIPT, CONNECTION`), and, if another URL was configured, requires explicit consent and then **forwards every event to that previous URL**, so the other consumer keeps working.
5. **chatwoot_callback**: `PATCH` the inbox `webhook_url` (same consent and forwarding rule if it pointed elsewhere).
6. **reachability**: EvoBridge calls its own public URL and checks the request comes back to this process.
7. **health**: the instance is logged in, and the inbox and webhook match what was set.
8. **activate**: the connection starts processing.

When an API can't do something (non-admin token, unactivated Evolution Go, private URL blocked by Chatwoot's SSRF filter), the step ends in `action_required` with concrete instructions, never in a false success.

## Message engine

### Queue

- A `jobs` table holds every event with `dedupe_key UNIQUE`. The same provider event can't be queued twice: Evolution Go retries, sends duplicates to the global and instance URL, and Chatwoot occasionally emits `message_created` twice.
- Jobs that share an `ordering_key` (connection + chat) run one at a time, oldest first, so a chat's messages arrive in order. A job that keeps failing stops blocking its chat after 3 attempts.
- Retries use exponential backoff with jitter (2 s doubling, capped at 10 min, 10 attempts) and honor `Retry-After`. Failures classified as permanent (bad payload, 4xx that won't change) skip retries.
- Exhausted jobs are marked `dead`: this is the dead-letter queue. They show in Events & Logs and can be replayed.
- Jobs are leased (`locked_until`). On boot, expired leases go back to `queued`, which together with idempotent handlers gives at-least-once processing that survives restarts.

### WhatsApp → Chatwoot

1. Normalize the payload (`providers/evolution-go/normalize.ts`). Evolution Go sends whatsmeow structs, not the Evolution API v2 shape.
2. Resolve the chat. LID handling: for incoming DMs Evolution Go already swaps `@lid` for the phone JID. For messages sent from the phone, `Chat` can stay `@lid`, with the phone in `RecipientAlt`. A LID→phone map is learned from those fields. **A phone number is never guessed.**
3. Find or create the Chatwoot contact and conversation:
   - `source_id`: the phone digits for 1:1 chats, which keeps Chatwoot campaigns compatible, or the full JID for `@lid` and groups. It is looked up with `contact_inboxes/filter`.
   - A phone or identifier taken by another inbox: Chatwoot keeps both unique per account. EvoBridge finds that contact (trying both Brazilian 9th-digit forms) and attaches the inbox to it.
   - Conversation: reuse the most recent one, which reopens it on the next incoming message (`reopenConversation`), or start a new one if the last is resolved.
4. Create the message:
   - `source_id = WAID:<whatsapp id>`.
   - Incoming → `incoming`. Typed on the phone, or sent through the Evolution Go API by another system → `outgoing`. Because a `source_id` is set, Chatwoot's own rule, and EvoBridge's, will never send it back.
   - Media is uploaded as `attachments[]`. When it can't be fetched, a visible placeholder is posted instead of dropping the message.
5. Record `message_links` (WhatsApp id ↔ Chatwoot id) for replies, deletes and receipts.

### Chatwoot → WhatsApp

1. Act only on what Chatwoot itself would send to a native channel: `message_created`, `message_type` `outgoing` or `template`, `private == false`, empty `source_id`, `content_type != voice_call`. Separately, `message_updated` with `content_attributes.deleted` becomes a delete-for-everyone.
2. Resolve the WhatsApp chat from `conversation.contact_inbox.source_id`.
3. **Pre-generate the WhatsApp message id** and store the link *before* sending. Evolution Go fires its `SendMessage` webhook before the HTTP response returns, so the id must already be known to recognize the echo.
4. Send:
   - Text through `/send/text`, with Markdown converted to WhatsApp formatting and the agent name optionally prefixed.
   - Attachments are downloaded from Chatwoot and uploaded to `/send/media` as multipart, so Evolution Go never needs to reach Chatwoot's storage.
   - Replies carry `quoted`.
5. On permanent failure, `PATCH` the Chatwoot message status to `failed` with the reason, so the agent sees it in the conversation.

### Loop and duplicate prevention, all together

| Layer | Stops |
|---|---|
| Unique `dedupe_key` per provider event | Retries and duplicate deliveries |
| Pre-generated WhatsApp id + `message_links` before send | Echo of EvoBridge's own sends (`SendMessage` / `IsFromMe`) |
| `source_id = WAID:…` on everything EvoBridge creates in Chatwoot | Chatwoot → WhatsApp echo |
| Only `outgoing`/`template`, non-private, empty `source_id` | Notes, incoming copies, activity messages |
| One connection per instance and per inbox (unique indexes) | Two bridges feeding each other |
| Per-chat serial processing | Duplicate contacts and conversations from bursts |

### Receipts and status

WhatsApp `Delivered`/`Read` receipts for agent messages become Chatwoot status updates (`PATCH …/messages/:id {status}`, API inboxes only, forward-only transitions).

## Security

- **Admin account:** a single admin, created once on first run. Setup is refused once a user exists, and the check runs in the same transaction as the insert.
- **Passwords:** Argon2id (19 MiB, t=2). The password rule is shared by the form and the server.
- **Sessions:**
  - Random 256-bit token in an `HttpOnly`, `SameSite=Lax` cookie, marked `Secure` behind HTTPS. Only the token's SHA-256 is stored.
  - Sliding 30-day expiry.
  - A password change signs out other sessions.
- **CSRF:** every state-changing `/api` request needs an `x-csrf-token` header that matches the session. With `SameSite=Lax`, that blocks cross-site forms and fetches.
- **Rate limiting:** login and setup have a tight limit, the API a general one. The webhook endpoints are excluded, because providers burst.
- **Encryption at rest:**
  - Provider keys, instance tokens, webhook secrets and retained payloads use AES-256-GCM.
  - The key comes from `ENCRYPTION_KEY`, or is generated on first boot into the data volume (`encryption.key`, mode 600).
- **Secrets never leave the server.** The dashboard only ever receives masked previews, and logs are redacted, including the webhook secret path segment.
- **SSRF:**
  - Provider URLs are checked when saved and again at connect time, through a guarded DNS lookup that closes the rebinding gap. That covers private, loopback, link-local, CGNAT and reserved ranges.
  - `ALLOW_PRIVATE_NETWORKS=true` opts in for providers on the same private network.
  - Cloud metadata addresses stay blocked regardless.
- **Message content:** not stored in event logs by default. Payloads are kept encrypted only for the retention window, so failed events can be replayed.

## Connection states

| State | Meaning (from real checks) |
|---|---|
| Configuring | Provisioning hasn't completed |
| Connected | Instance logged in, inbox and webhooks in place, no recent failures |
| Degraded | Works, but something needs attention: the webhook URL changed outside EvoBridge, recent dead jobs, or a public URL problem |
| Disconnected | The WhatsApp instance is not logged in |
| Error | Credentials rejected, Evolution Go not activated, or the inbox is gone |
| Paused | Stopped by the admin; incoming events are acknowledged and ignored |

A health loop re-checks providers and connections every 60 seconds.

## Known limitations (v1)

- **Audio in Chatwoot 4.x:** Chatwoot can show audio at 00:00 until the page is reloaded (chatwoot#14644, a server-side race). EvoBridge sends correct `audio/ogg` metadata, but can't fix it from outside.
- **Agent audio:** Evolution Go always sends `audio` as a voice note, converting with its own ffmpeg.
- **No edits from Chatwoot:** Chatwoot has no message edit API. Edits made on WhatsApp are posted as a reply marked "edited".
- **Private networks on Chatwoot ≥ 4.14:** Chatwoot only delivers webhooks to private IPs when `SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true` is set on its rails and sidekiq containers.
- **Groups:** off by default per connection. When enabled, the sender's name and number prefix each message.
