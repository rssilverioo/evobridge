# Evolution Go API audit (for an Evolution Go to Chatwoot sidecar)

**Source audited:** `github.com/evolution-foundation/evolution-go`, shallow clone at commit `9337afc` ("sync: 0.7.2 from main"), `VERSION` = `0.7.2`, committed 2026-07-03.
**Protocol lib:** `go.mau.fi/whatsmeow v0.0.0-20260630180629-b572e5bcb92b` (`go.mod:24`). I downloaded the module source to check the JSON shapes it produces.
**Clone path:** `scratchpad/research/evolution-go`. The community fork is at `scratchpad/research/evo-go-chawoot` (commit `5600f7c`, VERSION 0.6.1).

All `file:line` references are relative to the evolution-go repo root unless prefixed `whatsmeow/` (the module cache) or `fork/`.

> **Read this first: the docs disagree with the code in several places.** Trust the source.
> - The repo wiki (`docs/wiki/recursos-avancados/events-system.md:128-150`) shows a webhook body shaped like Evolution API v2: `"event":"MESSAGE"`, `"instance"`, `data.key.remoteJid`. **That shape is wrong for Go.** The real event name is `"Message"` and the data is whatsmeow's raw `Info`/`Message` (see §5).
> - The same wiki uses the field names `rabbitmqEnabled` and `natsEnabled`. The real JSON tags are `rabbitmqEnable` and `natsEnable`.
> - The official site `docs.evolutionfoundation.com.br/evolution-go/webhooks.md` says `/instance/connect` takes the *global* key in `apikey` plus an `instanceId` header. In v0.7.2 the server reads **only** the `apikey` header, and `/instance/connect` requires the **instance token** (§1).
> - Both doc sets say the global `WEBHOOK_URL` receives events from all instances. The code does not do that (§4.4).

---

## 1. Auth

**Header:** `apikey: <key>`. It is the only request header the server reads (`pkg/middleware/auth_middleware.go:22,40`). No other `GetHeader` call exists in `pkg/` or `cmd/`. CORS allows `apikey`/`ApiKey` (`pkg/routes/routes.go:49`). `Authorization: Bearer` is **not** accepted.

There are two middlewares:

| Middleware | Check | Used by |
|---|---|---|
| `AuthAdmin` (`auth_middleware.go:39-52`) | `apikey == GLOBAL_API_KEY` (plain string compare) | `/instance/create`, `GET /instance/all`, `GET /instance/info/:instanceId`, `DELETE /instance/delete/:instanceId`, `POST`/`DELETE /instance/proxy/:instanceId`, `POST /instance/forcereconnect/:instanceId`, `GET /instance/logs/:instanceId` (`routes.go:80-93`) |
| `Auth` (`auth_middleware.go:21-37`) | `apikey` must equal some row's `instances.token` (`GetInstanceByToken`, `instance_repository.go:50-58`). The instance is chosen **by the token**. There is no instanceName or instanceId in the URL. | Everything else: `/instance/connect,status,qr,pair,disconnect,reconnect,logout,:instanceId/advanced-settings`, and all of `/send/*`, `/user/*`, `/message/*`, `/chat/*`, `/group/*`, `/call/*`, `/community/*`, `/label/*`, `/unlabel/*`, `/newsletter/*`, `/polls/*` |

- **The global key does NOT work on per-instance routes.** It only would if some instance happened to be created with `token == GLOBAL_API_KEY`.
- The per-instance token is chosen by the caller at create time (`token` is required, `instance_handler.go:64`).
- `GET /instance/all` (admin key) returns every instance's `token` (§3). The sidecar can therefore take only the global key and discover the instance tokens itself.
- Error body for both 401 cases: `401 {"error":"not authorized"}`.
- WebSocket: `GET /ws?token=<GLOBAL_API_KEY>&instanceId=<id>`. The token is a query param compared to the global key (`cmd/evolution-go/main.go:248-259`).

**Cheap "test connection":**
1. `GET /server/ok` needs no auth and no license, and returns `200 {"status":"ok"}` (`pkg/server/handler/server_handler.go:13-17`, exempt from the gate at `pkg/core/c0.go:642`).
2. `GET /license/status` needs no auth (see §2).
3. Admin key: `GET /instance/all` returns `200` or `401`. It is a DB read only, but it returns the whole instance list.
4. Instance token: `GET /instance/status` returns `200` or `401`. It is in-memory and cheap.

**Version/info endpoint:** **none.**
- No route exposes the version. `version` is only logged at startup (`main.go:343`) and sent to the license server.
- Swagger (`/swagger/*any`, `routes.go:60`) has a static `@version 1.0` (`main.go:330`), which is not the build version.
- `/license/status` does not include the version.
- The response bodies give no way to tell Evolution Go apart from Evolution API v2. A practical fingerprint: `GET /server/ok` returns 200, and `GET /license/status` returns JSON with `instance_id`. Evolution API v2 has neither route.

## 2. Activation / licensing (`pkg/core/c0.go`, readable but deliberately obfuscated identifiers)

### Gate behaviour

`r.Use(core.GateMiddleware(runtimeCtx))` is registered globally, **before** every route and **before** auth (`main.go:219`). If the runtime is not activated, **every** path except the ones below gets **HTTP 503** (`c0.go:638-675`):

- Allowed paths: `/health`, `/server/ok`, `/favicon.ico`, `/license/status`, `/license/register`, `/license/activate`, `/manager*`, `/assets*`, `/passkey-ceremony*`, `/swagger*`, `/ws`.
- Also allowed: any path ending in `.svg .css .js .png .ico .woff2 .woff .ttf`.

Exact 503 body (`c0.go:663-668`):

```json
{
  "error": "service not activated",
  "code": "LICENSE_REQUIRED",
  "register_url": "http://<Host header>/manager/login",
  "message": "License required. Open the manager to activate your license."
}
```

`register_url` is built from `c.Request.Host` and `c.Request.TLS`. Behind a TLS-terminating proxy it will say `http://`. Because the gate runs before auth, an **invalid key on an unactivated server also gets 503, not 401.**

### How activation happens (`InitializeRuntime`, `c0.go:441-501`, called at `main.go:378`)

1. **License already stored.** If `runtime_configs` (a table in the users DB) already holds an `api_key`, the runtime is marked active **locally, immediately**. The remote `/v1/activate` call runs in the background and is "non-blocking" (`c0.go:461-475`). After the first activation it therefore survives the license server being unreachable.
2. **No license, `GLOBAL_API_KEY` set** (it always is, since it is required by `config.go:229-230`). The server tries `POST /v1/activate` with GLOBAL_API_KEY as the license key. If the license server answers `{"status":"active"}`, that key is saved and activation succeeds. Otherwise the runtime stays inactive and prints the "License Registration Required" banner (`c0.go:476-488`, `569-579`).
3. **`EVOLUTION_OPERATOR_EMAIL` env set.** Headless auto-activation through `POST /v1/register/auto` with `{email,tier,version,instance_id}` (`c0.go:503-567`). Note that branch 2 runs instead whenever GLOBAL_API_KEY is non-empty, which per config is always. **As written, the email path is effectively unreachable.** This is an observation from the code. It is not tested.
4. **Manual flow.** The Manager (`/manager/login`) calls `GET /license/register?redirect_uri=<origin>/manager/license/callback` (from the manager bundle), which proxies `POST /v1/register/init` and returns `{"status":"pending","register_url":...}`. The user completes registration externally, then `GET /license/activate?code=...` exchanges the code (`/v1/register/exchange`), saves the key, and activates (`c0.go:700-835`).

### Phone-home

All calls go to `https://license.evolutionfoundation.com.br`. The string is obfuscated at `c0.go:39`. The HTTP client has a 10s timeout. Signed calls send `X-Api-Key` and `X-Signature` (HMAC-SHA256 of the body using the license key) (`c0.go:91-107`).

| Endpoint | When | Payload |
|---|---|---|
| `/v1/activate` | Startup | `{instance_id, version}` |
| `/v1/heartbeat` | Every **30 min** (`hbInterval`, `c0.go:373`, `839-859`) | `{instance_id, uptime_seconds, version}` plus an optional `telemetry_bundle{messages_sent,messages_recv}` (`c0.go:924-959`) |
| `/v1/deactivate` | Shutdown (SIGINT/SIGTERM) | `{instance_id}` (`c0.go:961-978`) |
| `/v1/register/init`, `/v1/register/exchange`, `/v1/register/auto` | Registration only | See above |

- `TrackMessageSent` and `TrackMessageRecv` are **never called** anywhere in v0.7.2. The message counters stay 0, so the bundle is never attached.
- `instance_id` is a UUID derived from hostname plus first-non-loopback MAC, persisted in `runtime_configs` (`c0.go:254-291`).
- A failed heartbeat **never deactivates.** It only prints a warning. There is no remote kill switch in the code, which matches the licensing FAQ ("Não há kill switch remoto").
- The old `pkg/telemetry` (posts to `log.evolution-api.com/telemetry`) exists but is **not wired** anywhere.

### How a third-party client should detect and explain this

- Any response with `status == 503 && body.code == "LICENSE_REQUIRED"` means the server is not activated.
- Show the user: "Your Evolution Go server isn't activated yet. Open `<register_url>` (or `<your-evo-url>/manager/login`), sign in with your GLOBAL_API_KEY and finish the license registration (free 'community' tier per docs). The API returns 503 to every call until then."
- `GET /license/status` (no auth) returns `{"status":"active"|"inactive","instance_id":"…","api_key":"abcdefgh...wxyz"}` (`c0.go:680-698`). Use it for a pre-flight health check that doesn't need a key.
- **Side note:** that endpoint leaks a masked license key without authentication.
- Recovery: activation persists in the DB. If the DB is wiped (fresh volume), the server returns to 503.

## 3. Instances

`instance_model.Instance` is the JSON returned by `/instance/all`, `/info`, and `/create` (`pkg/instance/model/instance_model.go:10-36`):

```go
Id               string `json:"id"`            // uuid
Name             string `json:"name"`
Token            string `json:"token"`         // per-instance apikey
Webhook          string `json:"webhook"`       // the ONE webhook URL
RabbitmqEnable   string `json:"rabbitmqEnable"`// "enabled"/"true" to activate
WebSocketEnable  string `json:"websocketEnable"`
NatsEnable       string `json:"natsEnable"`
Jid              string `json:"jid"`           // own JID once paired, e.g. "5511…:12@s.whatsapp.net" (may contain device)
Qrcode           string `json:"qrcode"`        // "data:image/png;base64,…|<code>" while pairing
Connected        bool   `json:"connected"`     // overwritten live = client.IsLoggedIn()
Expiration       int64  `json:"expiration"`
DisconnectReason string `json:"disconnect_reason"`
Events           string `json:"events"`        // comma list, e.g. "MESSAGE,SEND_MESSAGE"
OsName           string `json:"os_name"`
Proxy            string `json:"proxy"`         // blanked ("") in all/info responses
ClientName       string `json:"client_name"`
CreatedAt        time.Time `json:"createdAt"`
AlwaysOnline, RejectCall bool; MsgRejectCall string; ReadMessages, IgnoreGroups, IgnoreStatus bool
```

**List all:** `GET /instance/all` (admin) returns `{"message":"success","data":[Instance…]}` (`instance_handler.go:342-350`).
- It is filtered by `client_name = CLIENT_NAME` env (`instance_repository.go:139-147`). Instances created under another CLIENT_NAME are invisible.
- `connected` is recomputed from the live client (`instance_service.go:547-563`).
- There is no separate phone field. Derive the phone from `jid` by taking the part before `:` or `@`.

**Get one (admin):** `GET /instance/info/:instanceId` returns `{"message":"success","data":Instance}` (`instance_handler.go:363-378`).

**Status (instance token):** `GET /instance/status` returns `{"message":"success","data":{"Connected":bool,"LoggedIn":bool,"Name":"<pushName>"}}`.
- `StatusStruct` has **no json tags**, so the keys are capitalized.
- The JID field is unexported (`myJid`) and is **not** serialized (`instance_service.go:85-90,386-412`).
- "Paired and online" means `LoggedIn && Connected`.

**Create (admin):** `POST /instance/create` with body `{"name":"x","token":"<you choose>","instanceId":"<optional uuid>","proxy":{...},"advancedSettings":{...}}` (`instance_service.go:67-73`). Returns `{"message":"success","data":Instance}`.

**Connect / QR (instance token):**
- `POST /instance/connect` takes the `ConnectStruct` (§4). It starts the whatsmeow client when it isn't running and returns `{"message":"success","data":{"jid":"…","webhookUrl":"…","eventString":"MESSAGE,…"}}` (`instance_handler.go:120-151`).
- `GET /instance/qr` returns `{"message":"success","data":{"qrcode":"data:image/png;base64,…","code":"<raw>"}}`. During a passkey ceremony it returns `passkeyStage` / `passkeyOpenUrl` / `passkeyCode` instead (`instance_service.go:92-102,414-496`). It can block about 3 to 5 s.
- `POST /instance/pair` with `{"phone":"55…"}` returns `{"data":{"PairingCode":"XXXX-XXXX"}}` (no json tag).

## 4. Webhooks

### 4.1 Setting the per-instance webhook

There is **no dedicated webhook endpoint.** It is set through `POST /instance/connect` with `apikey: <instance token>` (`routes.go:99`, `instance_service.go:75-83,209-300`):

```json
{
  "webhookUrl": "https://sidecar.example/hooks/evo",
  "subscribe": ["MESSAGE", "SEND_MESSAGE", "READ_RECEIPT", "CONNECTION"],
  "rabbitmqEnable": "",
  "websocketEnable": "",
  "natsEnable": "",
  "immediate": false,
  "phone": ""
}
```

**Semantics:**
- It **overwrites** `instance.Webhook`, `Events`, `RabbitmqEnable`, `NatsEnable`, `WebSocketEnable` with whatever you send. Omitted fields become `""`, which disables those channels (`instance_service.go:232-238`).
- `subscribe: []` or omitted gives `["MESSAGE"]` only. `["ALL", …]` (first element) expands to every type. Unknown names are silently dropped (`:214-228`).
- If the client is already running, the settings are hot-reloaded with no reconnect (`UpdateInstanceSettings`, `whatsmeow.go:2675-2732`). If it is not running, **it starts the client**, which begins QR pairing for unpaired instances.
- **No headers, no secret, and no enabled flag for webhooks.** `webhook: ""` or `"disabled"` turns the webhook off (`whatsmeow.go:2313`).

**Only ONE webhook URL per instance** (a single `webhook` column). Setting it replaces whatever was there.

**Reading the current config so it can be preserved:**
- Use `GET /instance/info/:id` or `/instance/all` (admin key). They return `webhook`, `events`, `rabbitmqEnable`, `websocketEnable`, and `natsEnable`. Re-send them on connect.
- With only the instance token you cannot read the webhook. `/instance/status` lacks it, and `/connect`'s response echoes only what you just set.
- Note: `POST /instance/disconnect` sets `Events = ""` (`instance_service.go:322`).
- **Gotcha:** with `Events == ""`, `strings.Split("", ",")` yields `[""]`. The "default to MESSAGE" branch (`len < 1`) is dead code, so **nothing** is delivered (`whatsmeow.go:2120-2138`). Always send an explicit `subscribe`.

### 4.2 Event names: subscription key and emitted `event`

The subscription list is in `pkg/internal/event_types/event_types.go:3-40`. The routing switch is in `whatsmeow.go:2148-2273`.

| subscribe key | `event` values emitted |
|---|---|
| `MESSAGE` | `Message` (also forwards `ButtonClick`) |
| `SEND_MESSAGE` | `SendMessage` (sends made through *this API*) |
| `READ_RECEIPT` | `Receipt` |
| `PRESENCE` | `Presence` |
| `HISTORY_SYNC` | `HistorySync` |
| `CHAT_PRESENCE` | `ChatPresence`, `Archive` |
| `CALL` | `CallOffer`, `CallAccept`, `CallTerminate`, `CallOfferNotice`, `CallRelayLatency` |
| `CONNECTION` | `Connected`, `PairSuccess`, `TemporaryBan`, `LoggedOut`, `ConnectFailure`, `Disconnected` |
| `LABEL` | `LabelEdit`, `LabelAssociationChat`, `LabelAssociationMessage` |
| `CONTACT` | `Contact`, `PushName` |
| `GROUP` | `GroupInfo`, `JoinedGroup`, plus `Message`/`SendMessage`/`Receipt` whose chat is `@g.us` even without MESSAGE |
| `NEWSLETTER` | `NewsletterJoin`, `NewsletterLeave`, plus `@newsletter` messages |
| `QRCODE` | `QRCode`, `QRTimeout`, (`QRSuccess`) |
| `BUTTON_CLICK` | `ButtonClick` |
| `PICTURE` | `Picture` |
| `USER_ABOUT` | `UserAbout` |

Some events are emitted but routed **nowhere**, so they never reach webhooks: `SendStatus` (status/story sends, queue `"sendstatus"`, `send_service.go:3334-3364`) and `OfflineSyncCompleted`. Both fall into `default: return`.

**Which event fires for what:**

| Situation | Event (`subscribe` key) | How to recognize it |
|---|---|---|
| Incoming message | `Message` (MESSAGE) | `data.Info.IsFromMe == false` |
| Message sent **from the phone** or another linked device | `Message` (MESSAGE) | `IsFromMe == true`. whatsmeow emits these, and Evolution does not filter them (`whatsmeow.go:1135-1731`). |
| Message sent **through this API** (`/send/*`) | `SendMessage` (SEND_MESSAGE) | Built synthetically in `send_service.go:2781-2893`. whatsmeow does **not** echo own sends as `Message`. |
| Delivered / read ack | `Receipt` (READ_RECEIPT) | Top-level `"state": "Delivered" \| "Read" \| "ReadSelf"`. `played`, `sender`, `retry` and the rest are dropped (`whatsmeow.go:1732-1800`). Delivered and Read are de-duplicated per id for 30 min. |
| Deleted for everyone | `Message` | `data.Message.protocolMessage.type == 0` (REVOKE) and `data.Message.protocolMessage.key.ID` = the target id. `data.Info.Edit == "7"` (sender revoke) or `"8"` (admin revoke). |
| Edit | `Message` | `data.IsEdit == true`, `data.Info.Edit == "1"`. whatsmeow unwraps `editedMessage` (`whatsmeow/types/events/events.go:~407-410`), leaving `data.Message.protocolMessage = {type: 14 (MESSAGE_EDIT), key:{ID: original}, editedMessage:{conversation \| extendedTextMessage…}}`. |
| Reaction | `Message` | `data.Message.reactionMessage{key,text}`; empty `text` means the reaction was removed. |
| View-once that could not be decrypted | `Message` | `data` is an `UndecryptableMessage` with `UnavailableType: "view_once"` (`whatsmeow.go:2051-2057`). |

- `protocolMessage.type` is a JSON **number**. The protobuf enum has no `MarshalJSON`, so expect `0` for revoke and `14` for edit.
- Unknown protocol messages and `APP_STATE_SYNC_KEY_SHARE` / `HISTORY_SYNC_NOTIFICATION` / etc. are dropped (`utils.go:451-513`, `whatsmeow.go:1239-1243`).

### 4.3 Retry, ordering, timeouts (`pkg/events/webhook/webhook_producer.go`)

- `POST` with `Content-Type: application/json` and **no other headers** (`:73`).
- 5 attempts, `time.Sleep(30s)` between them (and after the last). Any non-2xx counts as failure, **including 4xx**, so they get retried. After that the event is dropped (`:44-65`).
- `http.Client{}` has **no timeout** (`:75`). The docs claim 30 s, but a hanging receiver holds the goroutine forever.
- Each event is dispatched in its own goroutine (`go CallWebhook`, `go sendWebhookWithRetry`). **No ordering guarantee.** A retried event arrives 30 s or more later, out of order.
- `SendMessage` webhooks are fired with `go` *before* the HTTP response to `/send/*` returns (`send_service.go:2889`). The webhook can beat the API response. See echo suppression in §6.
- **No signature, HMAC, secret or auth header of any kind.**
  - To authenticate deliveries, put a secret in the webhook URL (path or query, e.g. `https://sidecar/hook/<random>`).
  - Then verify `body.instanceToken`, which every payload carries (§5).

### 4.4 Global `WEBHOOK_URL` (env)

`webhookProducer.Produce` posts to the global URL **and** the instance URL (`webhook_producer.go:43-48`). However, `Produce` is only called when `instance.Webhook != "" && != "disabled"` (`whatsmeow.go:2313-2320`), and only for events allowed by **that instance's** `Events`. The consequences:

- An instance with no per-instance webhook sends **nothing** to the global URL. This contradicts the docs.
- If the sidecar is both the global URL and the instance URL, it gets **every event twice.**

### 4.5 Other transports (each independent, all can fire alongside the webhook)

`sendToQueueOrWebhook` (`whatsmeow.go:2285-2321`) runs RabbitMQ, then NATS, then WebSocket, then webhook. **If an earlier channel returns an error, the function `return`s and later channels, including the webhook, are skipped.**

- **WebSocket:** `ws(s)://host/ws?token=<GLOBAL_API_KEY>&instanceId=<id>`. It is gate-exempt and requires the instance's `websocketEnable: "enabled"`. Frames look like `{"queue":"<id>.message","payload":"<the same JSON string as the webhook body>"}` (`websocket_producer.go:105-136`).
  - **Upside:** this lets a sidecar receive events **without replacing an existing webhook.**
  - **Downside 1:** at-most-once, no buffering.
  - **Downside 2:** only one socket per instanceId (`AddClient` overwrites).
  - **Downside 3:** a write error suppresses the webhook for that event.
- **RabbitMQ/NATS:** global and per-instance queues (`AMQP_*`, `NATS_*` env). Out of scope here.

## 5. Webhook payload shapes

### 5.1 Envelope (all events)

The envelope is built in `whatsmeow.go:2073-2098`:

```json
{
  "event": "Message",
  "data": { "...": "..." },
  "instanceId": "<instance uuid>",
  "instanceToken": "<instance token>",
  "instanceName": "<instance name>"
}
```

- `Receipt` and `Presence` add a top-level `"state"`.
- `instanceToken` is the instance's API key, so the payload itself is a secret. Protect the receiver's logs.

### 5.2 `Message` data

`data` is `json.Marshal(*events.Message)` from whatsmeow, converted to a map, with these changes:
- `RawMessage` deleted (`:1604`).
- `JPEGThumbnail` removed from image, video and document messages (`:1606-1624`).
- Extra keys `quoted`, `isQuoted`, `referral`, `groupData`.
- Media `base64` or `mediaUrl` injected into `Message`.

Go structs (whatsmeow `types/message.go:27-41,96-113`, `types/events/events.go:312-337`):

```go
type MessageSource struct {           // embedded -> fields flattened into "Info"
  Chat JID; Sender JID; IsFromMe bool; IsGroup bool
  AddressingMode AddressingMode       // "pn" | "lid" | ""
  SenderAlt JID; RecipientAlt JID
  BroadcastListOwner JID; BroadcastRecipients []BroadcastRecipient
}
type MessageInfo struct { MessageSource; ID string; ServerID int; Type string; PushName string;
  Timestamp time.Time; Category string; Multicast bool; MediaType string; Edit EditAttribute;
  MsgBotInfo …; MsgMetaInfo …; VerifiedName *VerifiedName; DeviceSentMeta *DeviceSentMeta }
type Message struct { Info MessageInfo; Message *waE2E.Message; IsEphemeral, IsViewOnce, IsViewOnceV2,
  IsViewOnceV2Extension, IsDocumentWithCaption, IsLottieSticker, IsBotInvoke, IsEdit bool;
  SourceWebMsg *…; UnavailableRequestID string; RetryCount int; NewsletterMeta *…; RawMessage (deleted) }
```

How these serialize:
- `JID` uses `MarshalText` and becomes a string like `"5511999999999@s.whatsapp.net"`, `"123456789012345@lid"`, or `"1203…@g.us"`. An empty JID becomes `""`.
- `Timestamp` is RFC3339 (`"2026-10-13T12:34:56-03:00"`).
- `Info` keys are **PascalCase**. `Message` keys are **protobuf camelCase**, from the `json:"…"` tags in `proto/waE2E/WAWebProtobufsE2E.pb.go`.
- `[]byte` fields (`mediaKey`, `fileSHA256`, `fileEncSHA256`, and so on) are standard base64 strings.

Example incoming text message (illustrative, assembled from the structs):

```json
{
  "event": "Message",
  "instanceId": "9b1c…", "instanceToken": "tok…", "instanceName": "vendas",
  "data": {
    "Info": {
      "Chat": "5511999999999@s.whatsapp.net",
      "Sender": "5511999999999@s.whatsapp.net",
      "SenderAlt": "123456789012345@lid",
      "RecipientAlt": "",
      "IsFromMe": false, "IsGroup": false, "AddressingMode": "lid",
      "ID": "3EB0C5A277F7F9B6C599", "ServerID": 0,
      "Type": "text", "PushName": "Maria", "MediaType": "", "Edit": "",
      "Timestamp": "2026-10-13T12:34:56-03:00", "Category": "", "Multicast": false,
      "DeviceSentMeta": null, "VerifiedName": null
    },
    "Message": { "conversation": "Olá!" },
    "IsEphemeral": false, "IsViewOnce": false, "IsEdit": false, "IsDocumentWithCaption": false,
    "RetryCount": 0, "UnavailableRequestID": ""
  }
}
```

**Text:**
- `Message.conversation` (string), or `Message.extendedTextMessage.text`.
- `extendedTextMessage.contextInfo.{stanzaID, participant, quotedMessage, mentionedJID[]}` for replies and mentions (`WAWebProtobufsE2E.pb.go:8103,9015-9019`).
- `Info.Type` is `"text"` for text and `"media"` for media. `Info.MediaType` is something like `"image"`, `"ptt"`, `"document"`, `"video"`, `"sticker"`.

**Media:**

| Message type | Fields |
|---|---|
| `imageMessage` | `{URL, mimetype, caption, fileSHA256, fileLength, height, width, mediaKey, fileEncSHA256, directPath, mediaKeyTimestamp, contextInfo, …}` (`:8739-8767`) |
| `videoMessage` | Same, plus `seconds` |
| `audioMessage` | `{URL, mimetype ("audio/ogg; codecs=opus"), seconds, PTT (bool, capital), mediaKey, directPath, …}` (`:15356-15360`) |
| `documentMessage` | `{URL, mimetype, title, fileName, caption, …}` (`:15521-15538`) |
| `stickerMessage` | — |

- A document with a caption is unwrapped by whatsmeow, and `IsDocumentWithCaption` is set to `true`.

**How media is delivered:**
- Controlled by env `WEBHOOK_FILES` (default **true**, `config.go:238-241`). When it is true, Evolution downloads and decrypts the media inline before the webhook fires (5 min timeout, `whatsmeow.go:1370-1594`). There are two modes:
  - `MINIO_ENABLED=true`: uploads to S3/MinIO as `evolution-go-medias/<msgID><ext>` and adds `data.Message.mediaUrl` (a **7-day presigned** GET URL whose host is `MINIO_ENDPOINT`, `pkg/storage/minio/media_storage.go:~108`) and `data.Message.mimetype`.
  - Otherwise: adds `data.Message.base64` (raw standard base64, no `data:` prefix).
- Both keys sit **at the `Message` level**, next to `imageMessage`. They are not inside it.
- The mimetype is forced by type: image is `image/jpeg`, audio is `audio/ogg`, video is `video/mp4`, a sticker is converted to `image/png`, and a document uses its own mimetype.
- If the download fails, the webhook is still sent **without** base64 or mediaUrl. The fallback is `/message/downloadmedia` (§7).
- Large media produce very large webhook bodies in base64 mode. Size your receiver's body limit.
- In `SendMessage` webhooks, `base64` is added only when `WEBHOOK_FILES` is on, and MinIO is not used there (`send_service.go:2827-2871`).

**Other fields:**
- `fromMe`: `data.Info.IsFromMe`.
- Message id: `data.Info.ID`.
- Chat: `data.Info.Chat`.
- Sender: `data.Info.Sender` (may carry a device suffix, which is stripped; see below).
- `pushName`: `data.Info.PushName`. It is the sender's name. For `IsFromMe` it is your own name.

**Groups:**
- `Info.IsGroup = true`, `Info.Chat = "<id>@g.us"`, `Info.Sender` = the participant.
- `data.groupData` is a full `types.GroupInfo` (subject, participants, …). It is fetched with an **extra network call per group message** (`whatsmeow.go:1596-1602`).

**Quoted:** `data.isQuoted = true` and `data.quoted = {"stanzaID":"…","quotedMessage":{…}}`. This is set for text, image, audio, document and video only (`whatsmeow.go:1336-1364`).

**Filters applied before the webhook:**
- Instance `ignoreGroups` / `ignoreStatus` or env `EVENT_IGNORE_GROUP` / `EVENT_IGNORE_STATUS` drop `@g.us` / `@broadcast` messages entirely (`:1165-1183`).
- `readMessages: true` auto-marks incoming messages as read.

### 5.3 JID vs LID

Evolution post-processes `Info` (`whatsmeow.go:1185-1224`, `cleanSenderID` at `:2886-2895`):

- **Incoming DM in LID mode.** whatsmeow gives `Sender=x@lid`, `SenderAlt=<pn>@s.whatsapp.net` (from the `sender_pn` attribute, `whatsmeow/message.go:155-167`). Evolution **swaps** them: `Sender` becomes the PN, `Chat` becomes the PN (if Chat was `@lid`), and `SenderAlt` becomes the LID. So `Info.Chat` is a phone JID and `Info.SenderAlt` is the LID.
- **Incoming DM in PN mode:** `Sender`/`Chat` are the PN and `SenderAlt` is the LID (when provided).
- **Group in LID mode:** `Sender` (participant `@lid`) is swapped with the `participant_pn` PN. `Chat` stays `@g.us`.
- **`IsFromMe` DM (sent from the phone).** whatsmeow sets `Sender` = own JID, `Chat` = the recipient (may be `@lid`), and `RecipientAlt` = the recipient's PN (`peer_recipient_pn`) or LID (`whatsmeow/message.go:126-144`). `SenderAlt` is empty, so **Evolution does NOT swap.** For fromMe messages in a LID chat, `Info.Chat` stays `xxx@lid`.
  - The adapter must map the conversation by `IsFromMe && Chat ends "@lid"`, then use `Info.RecipientAlt`. `Info.DeviceSentMeta.DestinationJID` is another fallback.
- Device suffixes (`5511…:12@s.whatsapp.net`) are stripped from `Sender`/`SenderAlt` only. `Chat` is not touched.
- If WhatsApp omits the `sender_pn`/`participant_pn` attribute, you get a bare `@lid` with no PN in the payload.
  - Evolution does not query the LID store in the webhook path.
  - `POST /user/check {"number":["5511…"]}` returns `data.Users[].{Query,IsInWhatsapp,JID,RemoteJID,LID,VerifiedName}`, with `LID` from `Store.LIDs.GetLIDForPN` (`pkg/user/service/user_service.go:50-75,236-283`). This maps **PN to LID only.** There is **no API for LID to PN.**
  - The sidecar should persist a LID-to-PN map learned from `SenderAlt`/`RecipientAlt`.

### 5.4 `SendMessage` data (API sends)

Built at `send_service.go:2781-2825`:

```json
{
  "event": "SendMessage",
  "data": {
    "Info": {
      "Chat": "5511…@s.whatsapp.net", "Sender": "<own jid with device>",
      "IsFromMe": true, "IsGroup": false,
      "ID": "<msg id>", "ServerID": 123,
      "Type": "ExtendedTextMessage",
      "Timestamp": "…", "…": "…"
    },
    "Message": { "extendedTextMessage": { "text": "…", "contextInfo": {} } },
    "MessageContextInfo": { "stanzaID": "", "participant": "", "quotedMessage": { "conversation": "" } }
  },
  "instanceId": "…", "instanceToken": "…", "instanceName": "…"
}
```

- `Info.Type` here is the Go type name (`ExtendedTextMessage`, `ImageMessage`, `AudioMessage`, `DocumentMessage`, …), unlike the `"text"`/`"media"` values on incoming events.

### 5.5 `Receipt` data

`events.Receipt` (`whatsmeow/types/events/events.go:433-442`) gives `data = {"Chat","Sender","IsFromMe","IsGroup",…,"MessageIDs":["…"],"Timestamp":"…","Type":"" | "read" | "read-self","MessageSender":""}`, plus the top-level `"state"`.

### 5.6 `Connected` data

`data.status = "open"`, `data.jid` (own JID), `data.pushName` (`whatsmeow.go:902-905`). `LoggedOut` adds `data.reason`.

## 6. Sending

All send routes use `Auth` (instance token). The prefix is **`/send/…`. There is no `/message/sendText`** (that is Evolution API v2).

The `number` field passes through the `ValidateNumberFieldWithFormatJid` middleware (`jid_validation_middleware.go:322-449`). When `formatJid` is true (the default), it runs `utils.CreateJID` (`pkg/utils/utils.go:52-125`):
- Strings already containing `@s.whatsapp.net`, `@g.us`, `@lid`, `@broadcast` or `@newsletter` pass untouched.
- Otherwise it strips `+ ( ) space`, treats `-…` with 24 or more chars, or 18 or more digits, as a group, and applies MX/AR fixes.
- **BR fix:** for 13-digit `55`+DDD≥31 numbers whose first local digit is ≥7, the 9th digit is **removed** (`formatBRNumber`, `:149-189`).
- It then returns `+<digits>@s.whatsapp.net` (the `+` is stripped before sending, `send_service.go:2755`).
- With `CHECK_USER_EXISTS=true` (default, `config.go:277-281`), each send also runs `IsOnWhatsApp` and uses the returned JID. If the number is not on WhatsApp, the result is a 500 with `"number X is not registered on WhatsApp"` (`send_service.go:514-563`). Groups, `@lid` and newsletters skip that check.
- **Recommendation:** send the exact JID received (`5511…@s.whatsapp.net`, `…@lid`, `…@g.us`).

### `POST /send/text`

Body (`send_service.go:75-90`):

```json
{
  "number": "5511999999999@s.whatsapp.net",
  "text": "Olá",
  "id": "",
  "delay": 0,
  "mentionedJid": [],
  "mentionAll": false,
  "formatJid": true,
  "quoted": {"messageId": "3EB0…", "participant": "5511…@s.whatsapp.net"},
  "forwardingScore": null
}
```

- `id` is optional and lets **you choose the WhatsApp message id** (`send_service.go:2361-2366`). See the echo-suppression tip below.
- `delay` is in ms. It shows "composing" for that long.
- Required: `number` and `text` (otherwise 400 `"phone number is required"` / `"message body is required"`, `send_handler.go:61-69`).
- Text is always sent as `extendedTextMessage`.
- Quote: set `quoted.messageId` and `quoted.participant`. A placeholder empty quoted body is used (`send_service.go:2389-2396`).

### `POST /send/media`

`MediaStruct` (`send_service.go:107-120`):

```json
{
  "number": "…",
  "type": "image|video|ptv|audio|document",
  "url": "https://… OR raw base64",
  "caption": "",
  "filename": "doc.pdf",
  "id": "", "delay": 0,
  "mentionedJid": [], "mentionAll": false,
  "formatJid": true,
  "quoted": {"messageId": "", "participant": ""},
  "forwardingScore": null
}
```

- **JSON body:** `url` and `type` are required (`send_handler.go:237-280`).
  - If `url` does not start with `http(s)://`, it is decoded as **raw standard base64**. A `data:…;base64,` prefix fails with 400 `"invalid base64 encoding"` (`:262-268`).
  - Remote URLs are fetched with `http.Get`, with no timeout and no size cap (`send_service.go:1241`).
- **multipart/form-data:** fields `number`, `type`, `caption`, `filename`, `id`, `delay`, `mentionAll`, `mentionedJid` (repeat or comma-separated), `quoted.messageId`, `quoted.participant`, and file field **`file`** (`send_handler.go:150-235`).
- **There is no `mimetype` field.** The mime type is sniffed with `gabriel-vasile/mimetype`.
- Type rules:

| `type` | Rule |
|---|---|
| `image` | Only jpeg/png/webp; webp is labelled jpeg |
| `video`, `ptv` | Only `video/mp4` |
| `document` | Any mime; a PDF gets a page-1 thumbnail if `pdftoppm` exists; a non-empty caption wraps it in `documentWithCaptionMessage` |
| `audio` | **Always converted to Opus and always sent as a voice note** (`PTT: true`) through `ffmpeg` (or `API_AUDIO_CONVERTER` if set). There is **no option to send a plain audio file** (`send_service.go:1285-1303,1416-1444`). Send as `document` to get a file attachment. |

- `filename` is used only for documents.
- Newsletters reject documents.

### Response of every send

`200 {"message":"success","data":MessageSendStruct}`, where `MessageSendStruct = {Info: types.MessageInfo, Message: *waE2E.Message, MessageContextInfo}` (`send_service.go:376-380`). The message id is in **`data.Info.ID`**, plus `data.Info.ServerID` and `Timestamp`.

Errors are `400 {"error":"…"}` for validation and `500 {"error":"…"}` for everything else, including "not registered", "client disconnected" and "no active session found". Sends retry internally: up to 3 attempts, with a reconnect and 2 to 4 s backoff on disconnection (`send_service.go:422-459,604-656`).

### Echo suppression tip

The `SendMessage` webhook can arrive **before** the `/send/*` HTTP response. Two ways to deal with it:
- **Pre-generate the id.** The format must be a valid WA id, e.g. `"3EB0"` + 18 uppercase hex chars, matching whatsmeow's `GenerateMessageID` pattern. Pass it as `id`, record it as "sent by bridge", and ignore `SendMessage` and any `Message`/`IsFromMe` event with that id.
- Or simply don't subscribe to `SEND_MESSAGE`. Phone-originated messages still arrive as `Message`/`IsFromMe`.

### Other routes

- **Mark as read:** `POST /message/markread` with `{"number":"<chat jid>","id":["<msgId>",…]}` returns `{"data":{"timestamp":"0001-01-01 …"}}` (`message_service.go:62-65,309-334`).
  - It uses the chat JID as both chat and sender, which is fine for DMs. In groups the sender should be the participant, so receipts may be wrong there.
  - `POST /message/markplayed` sends a voice-note "played" receipt.
- **Delete for everyone:** `POST /message/delete` with `{"chat":"<jid>","messageId":"…"}`. It uses `BuildRevoke(chat, EmptyJID, id)`, so it only works for your **own** messages (`message_service.go:80-83,467-495`). Response: `{"data":{"messageId":…}}`.
- **Edit:** `POST /message/edit` with `{"chat":"…","messageId":"…","message":"new text"}`. Text only (`:85-89,497-526`).
- **React:** `POST /message/react` with `{"number","reaction","id","fromMe","participant"}`.
- **Presence/typing:** `POST /message/presence` with `{"number","state":"composing|paused","isAudio","delay"}`.

**Rate limiting:** none in the server (no middleware or limiter in the source). The only throttles are WhatsApp's own. Each send costs an extra `IsOnWhatsApp` usync when `CHECK_USER_EXISTS=true`. Do your own pacing.

## 7. Media download

`POST /message/downloadmedia` (instance token) takes `{"message": <waE2E.Message JSON>}`, i.e. the `data.Message` object from the webhook as-is.
- It works because `mediaKey`, `directPath`, `URL`, `fileEncSHA256` and `fileSHA256` survive as base64 strings. Only `JPEGThumbnail` is stripped.
- It returns `200 {"message":"success","data":{"base64":"data:<mime>;base64,<…>","timestamp":"…"}}`. The value is a **data URL**, not raw base64 (`message_service.go:72-74,363-449`, `message_handler.go:~245-262`).
- Supports image, audio, document, video and sticker at top level. Unwrap `documentWithCaptionMessage`, `viewOnce` and similar yourself.
- WhatsApp CDN URLs expire after a few weeks, so download promptly.
- It also creates `files/user_<id>/` as a side effect.
- **Alternative:** keep `WEBHOOK_FILES=true` and read `data.Message.base64` or `data.Message.mediaUrl`.

## 8. Chatwoot in upstream, license, trademark

- **Chatwoot:** `grep -ril chatwoot` over the whole upstream repo (Go, docs, manager bundle) finds **nothing.** There is no Chatwoot code upstream. `docker/stack-evocrm.yml` refers to their own "EvoCRM", which is a different thing.
- **LICENSE** (`LICENSE:1-17`), quoted exactly:

> Evolution Go is licensed under the Apache License 2.0, with the following additional conditions:
>
> 1. Evolution Go may be utilized commercially, including as a backend service for other applications or as an application development platform for enterprises. Should the conditions below be met, a commercial license must be obtained from the producer:
>
>    a. **LOGO and copyright information**: In the process of using Evolution Go's frontend components, you may not remove or modify the LOGO or copyright information in the Evolution Go console or applications. This restriction is inapplicable to uses of Evolution Go that do not involve its frontend components.
>
>    b. **Usage Notification Requirement**: If Evolution Go is used as part of any project, including closed-source systems (e.g., proprietary software), the user is required to display a clear notification within the system that Evolution Go is being utilized. This notification should be visible to system administrators and accessible from the system's documentation or settings page. Failure to comply with this requirement may result in the necessity for a commercial license, as determined by the producer.
>
> Please contact suporte@evofoundation.com.br to inquire about licensing matters.
>
> Apart from the specific conditions mentioned above, all other rights and restrictions follow the Apache License 2.0.

  It is followed by the full Apache-2.0 text, "Copyright 2026 Evolution Foundation", and "© 2026 Evolution Foundation".

- **NOTICE** (`NOTICE:7-11`):

> Trademark notice
> "Evolution Foundation", "Evolution" and "Evolution Go" are trademarks of Evolution Foundation. The Evolution Go logo, wordmark, and visual identity are governed by the Trademark and Brand Assets Policy included in this repository (TRADEMARKS.md).

- **TRADEMARKS.md** (v1.0, 2026.05.06), the key clauses:

> 2.1. You may truthfully refer to Evolution Go to describe that your software is based on, compatible with, or derived from this project, provided that such use does not imply endorsement by Evolution Foundation.
>
> 2.3. You may use Evolution Go marks in nominative ways, such as "based on Evolution Go", provided that the use is accurate and does not create confusion.
>
> 4.2. **Modified UI must remove Evolution Go brand assets.** If you distribute or publicly host a modified user interface or user experience (including changes to branding or visual identity), you must: (a) remove and replace all Evolution Go trademarks and brand assets from the user interface, product name display, and related marketing materials for that distribution; and (b) choose a name and branding that are clearly distinct from Evolution Go.
>
> 4.3. **No endorsement.** You may not use Evolution Go trademarks or brand assets in a way that implies Evolution Foundation sponsors, endorses, or is affiliated with your distribution, except for unmodified official builds.
>
> 5. Any use not expressly permitted by this policy requires prior written permission from Evolution Foundation.

  §3 also lists "Evolution" alone as a protected mark, along with the palette #00ffa7 and others.

**What this means for the project (my reading, not legal advice):**
- A sidecar that only talks to the HTTP API and contains no Evolution Go code is not a derivative work under Apache-2.0.
- Name it something distinct, without "Evolution" in the project name, logo or colors.
- Describe it nominatively, e.g. "Chatwoot bridge for Evolution Go (unofficial, not affiliated)".
- Condition 1.b ("Usage Notification") binds whoever *uses Evolution Go* in a project. Mentioning Evolution Go in the README or settings page is cheap compliance for your users.

## 9. Community fork `marcelolimajw/evo-go-chawoot` (`internal/chatwoot`, v0.6.1)

This is an in-process integration that patches the Go server. Mounted routes: `POST /chatwoot/webhook[/:instanceName]` with **no auth**, plus `/chatwoot/manager` and `/chatwoot/ui`. The fork keeps the license gate. Real-world lessons:

- **Echo suppression is two-layered.**
  1. Every WhatsApp-originated message is created in Chatwoot with `external_id = source_id = "WAID:<waMsgId>"`. Chatwoot `message_created` webhooks whose external_id starts with `WAID:` are ignored (`fork/internal/chatwoot/api/handler.go:261-264`).
  2. After the bridge sends a Chatwoot agent message to WhatsApp, it PATCHes the CW message to `external_id: "WAID:<id>"` (`handler.go:410-415`, `client.go:297-309`).

  Backups:
  - A content-keyed echo cache, `"<convId>:<content>"`, valid for 10 s.
  - A 2-min de-duplication on the CW message id (Chatwoot sometimes delivers `message_created` twice).
  - Ignoring `message_created` whose content is a "message was deleted" notice.
- **fromMe (phone-sent) messages** are posted to Chatwoot as `message_type: "outgoing"`, `private: true`, prefixed `"📲 Enviado pelo aparelho:\n"` (`service.go:89,259-263,590`). Private notes are never relayed back to WhatsApp.
- **ID mapping** is a persisted JSON file mapping CW id to `{wa_id, participant, chat}` and WA id to CW id (`mapping.go`), capped at roughly 5000 entries. It is needed for:
  - Revokes: a WA REVOKE deletes the mapped CW message. If no mapping exists, it does nothing, to avoid a "deleted" bubble.
  - CW deletes: a `message_updated` with `content_attributes.deleted` triggers a WA revoke.
  - Replies: `content_attributes.in_reply_to` (CW id) is mapped to a WA `quoted.messageId` + `participant`.
- **source_id / contact identity:**
  - The contact's `identifier` is the full JID.
  - The `contact_inbox.source_id` is **digits only** for DMs (`chatwootSourceID`, `service.go:671-698`), and the full JID for `@g.us`/`@lid`.
  - Why: Chatwoot campaigns on API inboxes look up `source_id = phone.gsub(/\D/,'')`. A JID source_id makes campaigns open duplicate conversations.
  - `source_id` cannot be updated through the Chatwoot API (only set at create), so the fork sends it on both `POST /contacts` and `POST /conversations` (`fork/AGENTS.md:54-110`).
  - It reuses the last conversation, including resolved ones, through `GET /contacts/:id/conversations`.
  - It retries contact lookup with and without the BR 9th digit.
- **LID handling:**
  - Chat target resolution goes in this order: PN Sender (non-fromMe DM), then `Store.GetAltJID`, then the raw `@lid`.
  - For CW to WA, `source_id`s starting with `147…` (15 or more digits) are treated as `@lid`.
  - For a sidecar without access to the store, rely on `SenderAlt`/`RecipientAlt` (§5.3).
- **Chatwoot 4.x audio/video bug** ([#14511](https://github.com/chatwoot/chatwoot/issues/14511), closed without a fix; [#14644](https://github.com/chatwoot/chatwoot/issues/14644), open).
  - The problem: native attachments race. The first load returns 404 and the player is stuck at 00:00 until refresh. The fork says this is confirmed up to v4.16.x, and the fix PRs (#13675/#14758) are unmerged.
  - The workaround: upload audio/video to MinIO and post a **text** message `"▶️ **Mensagem de voz** [ ](<url>)"`, plus a dashboard-injected JS player (`fork/Extras/chatwoot/`, through super_admin "Dashboard Scripts", Tampermonkey, or nginx `sub_filter`).
  - Images and stickers stay native attachments (multipart `attachments[]`).
  - The fork changed MinIO to **public permanent URLs**. Upstream uses 7-day presigned URLs, which would break this trick after a week.
  - OGG/Opus does not play on iOS Safari.
- **Other details the fork handles:**
  - Unwrapping newer wrappers that whatsmeow doesn't (e.g. `botForwardedMessage`).
  - Forwarded detection through `contextInfo.isForwarded`.
  - An `[Editado]` prefix for edits.
  - A group sender header `**phone - Name:**`.
  - Converting webp stickers to png.
  - Locations as Google Maps links.
  - vCards with `ITEM1.TEL` lines.
  - Mention resolution (`@name` to `mentionedJid`).
  - Inbox-id mismatch filtering.
  - An agent signature `*Name:*\n` prefix.

## 10. Adapter checklist (derived)

1. Probe `GET /server/ok`. If any call returns 503 with `code: LICENSE_REQUIRED`, show the activation explanation and `register_url`.
2. Admin key: call `GET /instance/all` to get id, name, token, jid and connected, and to read the current `webhook`, `events` and `*Enable` values.
3. Attach: `POST /instance/connect` with the **instance token**, re-sending the existing `rabbitmqEnable`/`websocketEnable`/`natsEnable`.
   - If another webhook consumer already exists, prefer the **WebSocket tap**, or make the sidecar a fan-out proxy. Don't clobber the existing webhook.
   - Put a random secret in the webhook path and check `instanceToken` in the body.
4. Subscribe at least `MESSAGE` and `CONNECTION`, plus `READ_RECEIPT` for ticks. Add `SEND_MESSAGE` only if you need API-sent mirrors. Never leave `subscribe` empty after a disconnect.
5. Dispatch on `event`. For `Message`:
   - Revoke: `protocolMessage.type == 0`. Edit: `IsEdit` / `type == 14`. Reactions: `reactionMessage`.
   - Otherwise it is content. Use `Info.IsFromMe` to decide private-note vs incoming. Use `Info.ID` as the WAID.
6. Resolve the contact phone:
   - Not fromMe: `Info.Chat`/`Sender` is already the PN after the swap.
   - fromMe with `Chat` ending `@lid`: use `Info.RecipientAlt`.
   - Persist a LID-to-PN map.
7. Media: read `Message.base64` (`WEBHOOK_FILES`) or `Message.mediaUrl` (MinIO). Fall back to `/message/downloadmedia` with `{"message": data.Message}`.
8. Send:
   - `/send/text` and `/send/media`, with `number` set to the exact JID.
   - Media `url` is either http(s) or raw base64 without a `data:` prefix.
   - `audio` always becomes a voice note.
   - Pass your own `id` so echoes can be suppressed.
   - Read `data.Info.ID` from the response.
9. Tolerate out-of-order and late (30 s or more) duplicate deliveries. Respond 2xx fast. There is no receiver timeout on Evolution's side.
