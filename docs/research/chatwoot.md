# Chatwoot API audit for an Evolution Go to Chatwoot (API channel) sidecar bridge

**Source audited:** `github.com/chatwoot/chatwoot`, shallow clone of `develop` at `5e0afa93` (2026-10-13), with `package.json` reporting 4.18.0. I also fetched tag **v4.18.0**, the latest release (2026-09-18), and diffed every file cited here against it. Anything that exists only on develop, after 4.18.0, is marked **[develop only]**. All paths are relative to the repo root. Line numbers refer to develop HEAD.

**Version gates that matter**, mapped from commits to release tags with the GitHub compare API:

| Change | PR | First release |
|---|---|---|
| Account webhooks signed (`X-Chatwoot-Signature`) | #13573 | **v4.12.0** |
| API-inbox `webhook_url` and agent-bot webhooks signed (`Channel::Api#secret`) | #13892 | **v4.13.0** |
| Webhooks sent through `SafeFetch` (SSRF filter, private IPs blocked) | #14155 | **v4.14.0** |
| `SAFE_FETCH_ALLOW_PRIVATE_NETWORK` opt-out | #14548 | **v4.15.0** |
| `PATCH .../messages/:id` (status update, API inboxes) | #11387 | 4.2-era, in every current 4.x |
| `Authorization: Bearer <token>` accepted as an alternative to `api_access_token` | #15941 | **[develop only]**, merged 2026-09-22 |
| MFA-enforcement guard on token requests (`403 mfa_enrollment_required`) | n/a | **[develop only]** |

---

## 1. Auth

### 1.1 Header and token types

`app/controllers/concerns/access_token_auth_helper.rb`:

```ruby
def legacy_access_token
  request.headers[:api_access_token] || request.headers[:HTTP_API_ACCESS_TOKEN]
end
...
def authenticate_access_token!
  ensure_access_token
  render_unauthorized('Invalid Access Token') && return if @access_token.blank?
  @resource = @access_token.owner
  Current.user = @resource if allowed_current_user_type?(@resource)   # User or AgentBot only
end
```

An `AccessToken` is polymorphic and has three possible owners.

| Token owner | Where it comes from | What it can do |
|---|---|---|
| **User** (agent or administrator) | Profile settings, "Access Token". Returned in `GET /api/v1/profile` → `access_token`. | Everything under `/api/v1/accounts/:account_id/...` for the accounts the user belongs to. Pundit policies apply per role (see 1.3). |
| **AgentBot** | `POST /api/v1/accounts/:id/agent_bots` (admin), or Super Admin for global bots | Only the allow-list in `BOT_ACCESSIBLE_ENDPOINTS` (`access_token_auth_helper.rb:2-7`): `conversations#show/toggle_status/toggle_typing_status/toggle_priority/create/update/custom_attributes`, `conversations/messages#create`, `conversations/assignments#create`, `conversations/labels#index/create`. Any other endpoint returns **401** `{"error":"Access to this endpoint is not authorized for bots"}`. The account must be the bot's own account, or one where the bot is attached to an inbox (`ensure_current_account_helper.rb:29-34`). |
| **PlatformApp** | Super Admin, Platform Apps | Only `/platform/api/v1/{users,accounts,account_users,agent_bots}` (`platform_controller.rb:18-21`), and only on records the app created (`validate_platform_app_permissible`). It cannot call account APIs: `ensure_current_account` finds no user or bot and renders 401. It can read a permissible user's `access_token` through `GET /platform/api/v1/users/:id`. |

**Conclusion:** an AgentBot token is **not enough** for the bridge. It cannot create or search contacts, cannot call `contact_inboxes/filter`, cannot list conversations, and cannot `PATCH` message status. Use a **User** token. Optionally, use a dedicated "bridge" user, which occupies a seat.

Other gates that apply to all token requests:

- `api_and_webhooks_enabled?` always returns `true` when self-hosted (`app/models/account.rb:168`). On Chatwoot Cloud it is the `api_and_webhooks` feature flag (`enterprise/app/models/enterprise/account.rb:71-75`). When it is off, the response is **403** `{"error":"API access is not enabled for this account"}` (`api/v1/accounts/base_controller.rb:12-16`).
- A suspended account returns **401** `{"error":"Account is suspended"}` (`ensure_current_account_helper.rb:11`).
- [develop only] If the account has `enforce_mfa` set and the user has not enrolled in MFA, the response is **403** `{"error": "...", "error_code":"mfa_enrollment_required"}` (`concerns/mfa_enforcement_guard.rb`).

### 1.2 Test connection: `GET /api/v1/profile`

Route: `config/routes.rb:512` (`resource :profile, only: [:show, :update]`). The view is `app/views/api/v1/models/_user.json.jbuilder`. Exact keys:

```jsonc
{
  "access_token": "...",          // '' if no account has api_and_webhooks enabled
  "account_id": 1,                // the "active" account (most recent active_at)
  "available_name": "...", "avatar_url": "...", "confirmed": true,
  "display_name": null, "message_signature": null, "email": "...",
  "hmac_identifier": "...",       // only if CHATWOOT_INBOX_HMAC_KEY configured
  "id": 1, "inviter_id": null, "name": "...", "provider": "email",
  "pubsub_token": "...", "custom_attributes": {...},   // custom_attributes only if present
  "role": "administrator",        // role in the ACTIVE account only
  "ui_settings": {...}, "uid": "...", "type": "SuperAdmin" | "User" | null,
  "accounts": [
    {
      "id": 1, "name": "Acme", "status": "active", "onboarding_step": "...",
      "shopify_integration": false, "shopify_connected": false,
      // enterprise builds add: "billing_provider", "subscription_status"
      "active_at": "2026-...", 
      "role": "administrator" | "agent",
      "permissions": ["administrator"] | ["agent"] | [<custom role perms>..., "custom_role"],
      "availability": "online", "availability_status": "online", "auto_offline": true,
      "api_and_webhooks": true,
      // enterprise builds add: "custom_role_id", "custom_role": {id,name,description,permissions}
    }
  ]
}
```

(`_user.json.jbuilder:7-52`, `account_user.rb:58-60`, `enterprise/app/models/enterprise/account_user.rb:2-4`.)

This lets you list the accessible accounts with `accounts[].id`, `.name` and `.role` without asking the user for IDs. Filter on `role == "administrator"` for the setup steps. Use `status == "active"` and `api_and_webhooks` as well.

Caveats:

- With an **AgentBot** token, `/api/v1/profile` returns 401 ("not authorized for bots"), because `profiles` is not in the allow-list. The endpoint therefore also tells you that the token is a user token.
- The `type` value comes from the users table STI column. `"SuperAdmin"` is a possible value.
- `role` at the top level reflects only the active account. Always use `accounts[].role`.

### 1.3 Role requirements

Pundit's `NotAuthorizedError` is mapped to **HTTP 401** `{"error":"You are not authorized to do this action"}` (`concerns/request_exception_handler.rb:24-26`). It is not a 403. Agents therefore receive 401 for these endpoints:

| Action | Policy | Required role |
|---|---|---|
| Create, update or destroy an inbox, plus `reset_secret`, `rotate_hmac_token`, `set_agent_bot` | `app/policies/inbox_policy.rb:45-83` | **administrator** |
| List or show inboxes | `index?` is true, but `policy_scope` resolves to `user.assigned_inboxes`. Admins see all inboxes. Agents see only inboxes they are members of (`user.rb:164-166`). | any |
| Inbox `secret` and `hmac_token` fields in JSON | `_inbox.json.jbuilder:131-132`: `if Current.account_user&.administrator?` | **administrator** (agents simply do not get the keys) |
| Webhooks: index, create, update, destroy | `app/policies/webhook_policy.rb`, all `@account_user.administrator?` | **administrator** |
| Contacts: index, search, filter, show, create, update | `contact_policy.rb`, all `true` | any (destroy, import and export are admin-only) |
| Conversation show, and message create or update in it | `conversation_policy.rb:10`: `administrator? \|\| agent_bot? \|\| inbox_access? \|\| team_access?` | admin, or an agent who is a member of the inbox or team |

**Recommendation:** use an administrator token for setup (create the inbox, set `webhook_url`, read `secret`). At runtime, an agent token works if that user is a member of the API inbox. In practice most bridges keep the admin token.

---

## 2. Inboxes

### 2.1 List

`GET /api/v1/accounts/:account_id/inboxes` (`routes.rb:328`) returns `{"payload":[<inbox>...]}` (`views/api/v1/accounts/inboxes/index.json.jbuilder`).

Inbox fields (`app/views/api/v1/models/_inbox.json.jbuilder`):

- **Common fields:** `id`, `avatar_url`, `channel_id`, `name`, `channel_type` (`"Channel::Api"`), `greeting_enabled`, `greeting_message`, `working_hours_enabled`, `enable_email_collect`, `csat_survey_enabled`, `csat_config`, `enable_auto_assignment`, `auto_assignment_config`, `out_of_office_message`, `working_hours`, `timezone`, `callback_webhook_url` (nil for API), `allow_messages_after_resolved`, `lock_to_single_conversation`, `sender_name_type`, `business_name`, `provider`.
- **Also present (via `try`):** `hmac_mandatory`, plus null widget fields.
- **API-specific fields (lines 130-136):**

```ruby
if resource.api?
  json.hmac_token resource.channel.try(:hmac_token) if Current.account_user&.administrator?
  json.secret resource.channel.try(:secret) if Current.account_user&.administrator?
  json.webhook_url resource.channel.try(:webhook_url)
  json.inbox_identifier resource.channel.try(:identifier)
  json.additional_attributes resource.channel.try(:additional_attributes)
end
```

`GET /inboxes/:id` returns the same partial without a `payload` wrapper.

### 2.2 Create an API inbox

`POST /api/v1/accounts/:account_id/inboxes` (`inboxes_controller.rb:33-46`):

```json
{
  "name": "WhatsApp (Evolution Go)",
  "channel": {
    "type": "api",
    "webhook_url": "https://bridge.example.com/chatwoot/webhook/<instance>",
    "hmac_mandatory": false,
    "additional_attributes": {}
  },
  "lock_to_single_conversation": true,
  "allow_messages_after_resolved": true,
  "enable_auto_assignment": true,
  "greeting_enabled": false
}
```

- `channel.type` must be in `allowed_channel_types` (`%w[web_widget api email line telegram whatsapp sms]`, line 102-104; enterprise adds `voice`).
- The channel's permitted attributes are `Channel::Api::EDITABLE_ATTRS = [:webhook_url, :hmac_mandatory, { additional_attributes: {} }]` (`app/models/channel/api.rb:26`).
- Top-level inbox attributes come from `inbox_attributes` (lines 190-197): `name, avatar, greeting_enabled, greeting_message, enable_email_collect, csat_survey_enabled, enable_auto_assignment, working_hours_enabled, out_of_office_message, timezone, allow_messages_after_resolved, lock_to_single_conversation, portal_id, sender_name_type, business_name, csat_config`.
- `additional_attributes.agent_reply_time_window` (hours, must be > 0, `channel/api.rb:40-45`) only drives `can_reply?` in the UI (`conversations/message_window_service.rb:41-43`). Leave it unset for WhatsApp Web.
- The response is the full inbox partial, including `secret`, `hmac_token` and `inbox_identifier` for an admin.

### 2.3 Update `webhook_url`

`PATCH /api/v1/accounts/:account_id/inboxes/:id`:

```json
{ "channel": { "webhook_url": "https://new-url" } }
```

`type` is not needed. `update_channel` runs when `permitted_params(EDITABLE_ATTRS)[:channel]` is present (`inboxes_controller.rb:110-121, 130-133`). Gotcha: the controller converts the literal string `"null"` to nil for every parameter (line 201).

### 2.4 One `webhook_url` per inbox, and signing

- `channel_api.webhook_url` is a single string column (`app/models/channel/api.rb:11`). It is validated for length only (2048, `lib/limits.rb:4`). There is no format or SSRF validation when it is saved. That check happens at delivery time (section 8). The inbox supports **exactly one** URL, with no event filter.
- Channel columns, and what each one is for:
  - `identifier`: the Public API inbox identifier, `has_secure_token`.
  - `hmac_token`: used to verify contact identity in the Public Client API (`identifier_hash`). It is **not** used for webhook signing.
  - `hmac_mandatory`: makes `identifier_hash` mandatory on the Public API contacts endpoints.
  - `secret`: the **webhook signing secret**, from `include WebhookSecretable` (`channel/api.rb:30`, `models/concerns/webhook_secretable.rb`: `has_secure_token :secret`, `encrypts :secret if Chatwoot.encryption_configured?`). It was added in v4.13.0 (migration `20260324070828_add_secret_to_channel_api.rb`). Existing API inboxes were backfilled (`20260324070835_backfill_agent_bot_and_channel_api_secrets.rb`).
- Rotate the secret with `POST /api/v1/accounts/:id/inboxes/:inbox_id/reset_secret` (admin; returns 404 unless the inbox is an API inbox; `inbox_secret_management.rb:4-8`). It returns the inbox JSON with the new `secret`.
- The listener passes the secret (`app/listeners/webhook_listener.rb:122-128`):

```ruby
def deliver_api_inbox_webhooks(payload, inbox)
  return unless inbox.channel_type == 'Channel::Api'
  return if inbox.channel.webhook_url.blank?

  WebhookJob.perform_later(inbox.channel.webhook_url, payload, :api_inbox_webhook,
                           secret: inbox.channel.secret, delivery_id: SecureRandom.uuid)
end
```

- Signing happens in `lib/webhooks/trigger.rb:54-63`:

```ruby
def request_headers(body)
  headers = { 'Content-Type' => 'application/json', 'Accept' => 'application/json' }
  headers['X-Chatwoot-Delivery'] = @delivery_id if @delivery_id.present?
  if @secret.present?
    ts = Time.now.to_i.to_s
    headers['X-Chatwoot-Timestamp'] = ts
    headers['X-Chatwoot-Signature'] = "sha256=#{OpenSSL::HMAC.hexdigest('SHA256', @secret, "#{ts}.#{body}")}"
  end
  headers
end
```

**How to verify:** compute `hex(HMAC_SHA256(secret, "<X-Chatwoot-Timestamp>.<raw body bytes>"))`, prepend `"sha256="`, and constant-time compare it with `X-Chatwoot-Signature`. Reject requests where `|now - ts| > 300s`; PR #13573 recommends that window. Verify against the **raw** body, because `body = @payload.to_json`.

`X-Chatwoot-Delivery` is a per-event UUID. For API inboxes it is effectively unique per event, because there are no retries (see below).

On Chatwoot older than 4.13 there are no signature headers for API inboxes. The bridge should accept a "no secret configured" mode, plus a URL token such as `/webhook/<random>`, as a fallback.

---

## 3. Account webhooks compared with the inbox `webhook_url`

### 3.1 Account webhook API (admin only)

From `routes.rb:428` (`resources :webhooks, only: [:index, :create, :update, :destroy]`) and `webhooks_controller.rb`:

- `GET /api/v1/accounts/:id/webhooks` returns `{"payload":{"webhooks":[...]}}`.
- `POST /api/v1/accounts/:id/webhooks` with `{"webhook": {"url": "...", "name": "...", "subscriptions": [...], "inbox_id": 3}}` returns `{"payload":{"webhook":{...}}}`.
- `PATCH /api/v1/accounts/:id/webhooks/:webhook_id` takes the same body. `DELETE` returns 200.
- Webhook JSON (`_webhook.json.jbuilder`): `id, name, url, account_id, subscriptions, secret, inbox{id,name}?`.
- Valid subscriptions are `ALLOWED_WEBHOOK_EVENTS` (`app/models/webhook.rb:32-34`): `conversation_status_changed conversation_updated conversation_created contact_created contact_updated message_created message_updated webwidget_triggered inbox_created inbox_updated conversation_typing_on conversation_typing_off`. The list must be non-empty and contain no unknown values.
- `url` must be unique per account and match `http(s)` (`webhook.rb:28`).
- Signed with the per-webhook `secret` since v4.12.0, using the same `Trigger` headers.

**Gotcha:** the `inbox_id` on an account webhook does **not** filter delivery. `deliver_account_webhooks` iterates `account.webhooks.account_type` and checks only `subscriptions.include?(payload[:event])` (`webhook_listener.rb:110-120`). Nothing reads `webhook.inbox_id`, and the `inbox_type` enum value is never used. An account webhook therefore receives events from **every inbox**.

### 3.2 Which mechanism to use

**Use the API inbox `webhook_url`.** The reasons:

1. It is scoped to the inbox. `deliver_webhook_payloads` calls both the account hooks and `deliver_api_inbox_webhooks` (`webhook_listener.rb:130-133`).
2. On a delivery failure, Chatwoot marks the agent's message as **failed** in the UI. Account webhooks do not do this (`trigger.rb:65-75, 100-102`):

```ruby
def handle_error(error)
  return unless SUPPORTED_ERROR_HANDLE_EVENTS.include?(@payload[:event])   # message_created, message_updated
  return unless message
  case @webhook_type
  when :agent_bot_webhook then update_conversation_status(message)
  when :api_inbox_webhook then update_message_status(error)               # -> status 'failed', external_error = error.message
  end
end
```

3. It needs no extra admin-only webhook record. The URL is set on the inbox.

Downsides: you cannot choose the events, and deliveries are not retried, as the delivery semantics below explain.

**Delivery semantics** (`trigger.rb`, `webhook_job.rb`):

- A single POST from the Sidekiq `medium` queue. `execute` rescues every `StandardError` and only re-raises for agent-bot 429/500, so **API-inbox webhooks are never retried**.
- Any non-2xx response is an error (`SafeFetch::Fetcher#fetch`: `raise SafeFetch::HttpError ... unless response.is_a?(Net::HTTPSuccess)`).
- Timeout: `WEBHOOK_TIMEOUT` installation config, default **5s**, applied to both open and read (`trigger.rb:118-123`, `config/installation_config.yml:82`).
- **Consequence:** reply with 2xx immediately, then process asynchronously. If WhatsApp sending fails afterwards, `PATCH` the message status to `failed` (section 5.3).
- Ordering between events is not guaranteed: these are separate Sidekiq jobs.

### 3.3 Events delivered to the API inbox `webhook_url`

These are all methods in `WebhookListener` that call `deliver_webhook_payloads`:

| Event | Payload base |
|---|---|
| `message_created` | `message.webhook_data` (only if `webhook_sendable?`) |
| `message_updated` | `message.webhook_data` (only if `webhook_sendable?`) |
| `conversation_created` | `conversation.webhook_data` |
| `conversation_status_changed` | `conversation.webhook_data` + `changed_attributes` |
| `conversation_updated` | `conversation.webhook_data` + `changed_attributes` |
| `conversation_typing_on` / `conversation_typing_off` | `{event, user: user.webhook_data, conversation: conversation.webhook_data, is_private}` (lines 96-108) |
| `webwidget_triggered` | contact_inbox data (widget only, not relevant here) |

These go to account webhooks only: `contact_created`, `contact_updated`, `inbox_created`, `inbox_updated`.

`webhook_sendable?` is defined as `incoming? || outgoing? || template?` (`models/concerns/message_filter_helpers.rb:8-10`). **Activity messages are never sent. Private notes are sent** (as outgoing with `private: true`).

### 3.4 Exact `message_created` / `message_updated` payload

From `app/models/message.rb:182-198`:

```ruby
def webhook_data
  data = {
    account: account.webhook_data,                 # {id, name}
    additional_attributes: additional_attributes,
    content_attributes: content_attributes,
    content_type: content_type,                    # STRING: "text", "input_csat", ...
    content: webhook_content,                      # markdown hard breaks normalized
    conversation: conversation.webhook_data,
    created_at: created_at,                        # ISO8601 datetime (not unix)
    id: id,
    inbox: inbox.webhook_data,                     # {id, name}
    message_type: message_type,                    # STRING: "incoming" | "outgoing" | "template"
    private: private,
    sender: sender.try(:webhook_data),
    source_id: source_id
  }
  data[:attachments] = attachments.map(&:push_event_data) if attachments.present?
  data
end
```

Plus `event: "message_created"` (`webhook_listener.rb:31`).

The payload does **not** include `status`, `echo_id`, a top-level `conversation_id`, or `sender_type`. `echo_id` exists only in the REST response and the ActionCable `push_event_data` (`message.rb:148-158`).

**`sender`** (`*.webhook_data`):

- User: `{id, name, email, type: "user"}` (`user.rb:184-191`)
- AgentBot: `{id, name, type: "agent_bot"}` (`agent_bot.rb:59-65`)
- Captain assistant (enterprise): `{id, name, avatar_url, description, created_at, type: "captain_assistant"}` (`enterprise/app/models/captain/assistant.rb:145-179`)
- Contact: `{account, additional_attributes, avatar, custom_attributes, email, id, identifier, name, phone_number, thumbnail, blocked, contact_type}` (`contact.rb:159-174`). This has **no `type` key**. `contact_type` is [develop only].
- `null` for system or automation messages without a sender.

**`conversation`** (`app/presenters/conversations/event_data_presenter.rb:2-30`) has these keys: `additional_attributes, can_reply, channel ("Channel::Api"), contact_inbox, id (= display_id, the number used in URLs), inbox_id, messages, labels, meta, status ("open"|"resolved"|"pending"|"snoozed"), custom_attributes, snoozed_until, unread_count, first_reply_created_at, priority, waiting_since, agent_last_seen_at, contact_last_seen_at, last_activity_at, timestamp, created_at, updated_at, account`.

- `contact_inbox` is the raw ContactInbox record serialized: `id, contact_id, inbox_id, source_id, created_at, updated_at, hmac_verified, pubsub_token`. Use **`conversation.contact_inbox.source_id`** to find the WhatsApp chat.
- `meta` contains `sender` (the contact's `push_event_data`: `additional_attributes, custom_attributes, email, id, identifier, name, phone_number, thumbnail, blocked, type:"contact"`), plus `assignee`, `assignee_type`, `team` and `hmac_verified`.
- `messages` holds `[last chat message push_event_data]`. In **this** nested object `message_type` is an **integer** (`message_type_before_type_cast`). Do not confuse it with the top-level string.

**`attachments[]`** (`app/models/attachment.rb`, `push_event_data` plus metadata):

- Base fields: `{id, message_id, file_type, account_id}`. `file_type` is one of `"image"|"audio"|"video"|"file"|"location"|"fallback"|"share"|"story_mention"|"contact"|"ig_reel"|"ig_post"|"ig_story"|"embed"`.
- image, video and file add `extension, content_type, data_url, thumb_url, file_size, width, height`.
- audio adds the same, plus `transcribed_text`. `data_url` is `url_for(file)`.
- location adds `coordinates_lat, coordinates_long, fallback_title, data_url`.
- contact adds `fallback_title, meta`.
- `data_url` is a Rails URL, `<FRONTEND_URL>/rails/active_storage/blobs/redirect/<signed>/<filename>`. It **redirects** to the storage URL, which needs no auth. The bridge must follow redirects and must be able to reach `FRONTEND_URL` (`config/environments/production.rb:105`).
- `attachment.meta` (including `is_voice_message`) is **not** in the payload.

`content_attributes` keys that may appear (`message.rb:112-114`): `in_reply_to` (Chatwoot message id), `in_reply_to_external_id` (the `source_id` of the quoted message, filled automatically, see 5.1), `deleted`, `external_created_at`, `external_error`, `automation_rule_id`, `items`, `submitted_values`, `translations`, `is_unsupported`, `forwarded_message_id`, `external_echo`, and any arbitrary keys you posted.

### 3.5 Classifying events

Chatwoot's own rule for native channels is in `app/services/base/send_on_channel_service.rb:42-51`:

```ruby
def outgoing_message?
  message.outgoing? || message.template?
end

def invalid_message?
  # private notes aren't send to the channels
  # we should also avoid the case of message loops, when outgoing messages are created from channel
  message.private? || outgoing_message_originated_from_channel? || message.content_type == 'voice_call'
end
# outgoing_message_originated_from_channel? == message.source_id.present?
```

**Mirror this rule exactly:** send to WhatsApp only when `event == "message_created"`, `message_type` is `outgoing` or `template`, `private == false`, `source_id` is empty, and `content_type != "voice_call"`.

| Case | How to recognise it |
|---|---|
| Agent reply (send it) | `message_created`, `message_type:"outgoing"`, `private:false`, `sender.type:"user"`, `source_id:null` |
| Private note (skip) | `private:true` (`message_type` is `outgoing`) |
| Bridge-created customer message (skip) | `message_type:"incoming"`. Set `source_id` too, and it has `sender` = contact (no `type` key). |
| Bridge-created echo of a message sent from the phone, created as `outgoing` (skip) | `outgoing` with `source_id` set. Always set `source_id` on everything the bridge creates. |
| Agent bot or Captain message (send it, it is customer-visible) | `outgoing`, `sender.type` is `"agent_bot"` or `"captain_assistant"` |
| Automation or macro message | `outgoing`, `content_attributes.automation_rule_id` present. It is customer-visible, so send it. |
| Campaign | `additional_attributes.campaign_id` |
| Template messages (greeting, out-of-office, CSAT, auto-resolve) | `message_type:"template"`. Greeting and out-of-office apply to every channel (`message_templates/hook_execution_service.rb`). `email_collect` is web-widget only. CSAT has `content_type:"input_csat"`, and `content` already includes the survey link (`message_content_presenter.rb:10-28`). Native channels send templates, so send them. |
| Activity messages ("Conversation was resolved by…") | Never delivered |
| Typing | `conversation_typing_on/off`, `is_private:true` for typing in a note. Your own Public API typing comes back with `user` = contact (no `type`). |

**Formatting:** `content` is the agent's **Markdown** source (`**bold**`, `_it_`, `` ` ``). Only CommonMark hard breaks are normalized (`messages/webhook_content_normalizer.rb`). Converting to WhatsApp formatting is the bridge's job. Evolution API converts `**x**`→`*x*`, `*x*`→`_x_`, `~~x~~`→`~x~`.

**`message_updated` noise you will receive** (handle these idempotently):

- Your own `PATCH` status updates (sent, delivered, read, failed). They have no status field in the payload, so ignore them.
- On enterprise builds (the default image, unless `DISABLE_ENTERPRISE`), **every audio attachment** fires `message.send_update_event` after commit (`enterprise/app/models/enterprise/concerns/attachment.rb`, `broadcast_message_update_for_audio`). An agent's audio reply therefore produces `message_created` and then `message_updated`, and so does every incoming audio the bridge posts.
- Deletions (section 6).
- Translations, CSAT submissions, and others.

---

## 4. Contacts and conversations

### 4.1 Application API compared with the Public Client API

**Application API** (`/api/v1/accounts/:id/...`, user token):

- Full control: contact search and filter, `identifier`, `phone_number`, `source_id` lookup, `message_type: incoming` **and** `outgoing` (for messages sent from the phone), `source_id` on messages, `content_attributes` (`in_reply_to_external_id`), `PATCH` status, and attachments with `is_voice_message`.
- **This is what Evolution API's Chatwoot integration uses.** Its source is `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts` in EvolutionAPI/evolution-api:
  - `inboxes.create({channel:{type:'api', webhook_url}})` (line ~194-205)
  - `contacts.create({inbox_id, name, identifier: jid, phone_number:'+'+digits, avatar_url})` (~322-333)
  - `POST /contacts/filter` with `phone_number equal_to` (~504)
  - `contacts.listConversations` filtered by `inbox_id` and `status !== 'resolved'` (~813-850)
  - `conversations.create({contact_id, inbox_id, status?})` (~864)
  - multipart `messages` with `message_type`, `source_id: 'WAID:'+key.id`, `content_attributes` with `in_reply_to`/`in_reply_to_external_id` (~1076-1104)
  - loop prevention with `source_id.startsWith('WAID:')` (~1444-1446)
  - The **only** Public API call is for read receipts: `POST /public/api/v1/inboxes/{inbox_identifier}/contacts/{source_id}/conversations/{id}/update_last_seen` (~2434-2441).

**Public Client API** (`/public/api/v1/inboxes/:inbox_identifier/...`, no auth, `routes.rb:663-681`):

- Messages: `create` accepts only `content`, `echo_id` and `attachments[]`, and is always `incoming` (`public/api/v1/inboxes/messages_controller.rb:51-68`). It accepts **no `source_id`, no `content_attributes`/`in_reply_to`, no outgoing echo, and no status updates**.
- Contacts are addressed only by the `source_id` you assigned (`POST contacts` accepts `source_id`, `identifier`, `email`, `name`, `avatar_url`, `phone_number`, `custom_attributes`).
- No contact search.
- If `hmac_mandatory` is true, every contact call needs `identifier_hash = HMAC_SHA256(hmac_token, identifier)` (`public/.../contacts_controller.rb:31-48`).
- Errors in `messages#create` are not rescued (they surface as 500s or `RecordInvalid` 422s).

**Verdict:** use the Application API, which is what existing bridges use and the more robust choice. Use the Public API only, if at all, for `update_last_seen`. An alternative for read receipts is `PATCH` status `read` per message.

### 4.2 Contact lookup

**a) By the bridge's own key (recommended): `source_id` on the API inbox.** `contact_inboxes` has `UNIQUE (inbox_id, source_id)` (`contact_inbox.rb:18`), and no format validation is applied for `Channel::Api` (`valid_source_id_format?` only checks Twilio and WhatsApp).

```
POST /api/v1/accounts/:id/contact_inboxes/filter
{ "inbox_id": 3, "source_id": "5511999999999@s.whatsapp.net" }
```

This returns the contact JSON directly, with no wrapper, including `contact_inboxes[]`. It returns `404` with an empty body if nothing is found (`contact_inboxes_controller.rb:4-9`, `views/.../contact_inboxes/filter.json.jbuilder`). It requires `show?` on the inbox, so the user must be an admin or an inbox member.

**b) Search (fuzzy):** `GET /api/v1/accounts/:id/contacts/search?q=<str>&page=1` (`contacts_controller.rb:24-32`):

```ruby
'name ILIKE :search OR email ILIKE :search OR phone_number ILIKE :search OR contacts.identifier LIKE :search',
search: "%#{params[:q].strip}%"
```

- It is a substring match, case-sensitive for `identifier`. **URL-encode `+` as `%2B`**, otherwise it becomes a space and is stripped.
- Response: `{"meta":{"count","current_page","has_more"},"payload":[contact...]}`, with 15 results per page.
- Rate-limited (section 6).
- Always re-check for an exact match on the client side.

**c) Exact filter:** `POST /api/v1/accounts/:id/contacts/filter`

```json
{ "payload": [ { "attribute_key": "phone_number", "filter_operator": "equal_to",
                 "values": ["+5511999999999"], "query_operator": null } ] }
```

`Contacts::FilterService#filter_values` normalizes the phone to `"+" + digits` (`app/services/contacts/filter_service.rb:21-30`). `identifier` is `text_case_insensitive` and its value is lowercased. Operators come from `lib/filters/filter_keys.yml`. The base relation is `resolved_contacts`. That means contacts with an email, phone or identifier; with the `crm_v2` flag it means only `contact_type: lead` contacts (filter_service.rb:32-34).

### 4.3 Create a contact

`POST /api/v1/accounts/:id/contacts` (`contacts_controller.rb:85-92, 165-183`):

```json
{
  "inbox_id": 3,
  "source_id": "5511999999999@s.whatsapp.net",
  "name": "Maria",
  "phone_number": "+5511999999999",
  "identifier": "5511999999999@s.whatsapp.net",
  "avatar_url": "https://...",
  "email": null,
  "additional_attributes": {}, "custom_attributes": {}
}
```

The permitted keys are `name identifier email phone_number avatar avatar_url blocked additional_attributes custom_attributes` (plus `company_id` with the companies feature). `inbox_id` and `source_id` are read separately to build the ContactInbox through `ContactInboxBuilder`. A missing `source_id` on an API inbox becomes `SecureRandom.uuid` (`contact_inbox_builder.rb:24-25`). `avatar_url` is fetched asynchronously (`Avatar::AvatarFromUrlJob`).

Response:

```json
{"payload":{"contact":{...,"contact_inboxes":[{"source_id","inbox":{...}}]},"contact_inbox":{"inbox":{...},"source_id":"..."}}}
```

Validation (`app/models/contact.rb:51-56`):

```ruby
validates :email, allow_blank: true, uniqueness: { scope: [:account_id], case_sensitive: false }, format: Devise.email_regexp
validates :identifier, allow_blank: true, uniqueness: { scope: [:account_id] }
validates :phone_number, allow_blank: true, uniqueness: { scope: [:account_id] },
          format: { with: /\A\+[1-9]\d{1,14}\z/ }
```

- **E.164 strict:** the number needs a leading `+` and 2-15 digits, with no spaces, dashes or parentheses. No normalization is applied (only `email` is downcased).
- **`phone_number` and `identifier` are UNIQUE per account.** If the number already exists, for example from another inbox such as the official WhatsApp channel or an older Evolution integration, you get `422 {"message":"Phone number has already been taken","attributes":["phone_number"]}` (`render_record_invalid`, `request_exception_handler.rb:58-64`).
- The bridge must therefore look the contact up first. If found, it should attach the inbox with `POST /api/v1/accounts/:id/contacts/:contact_id/contact_inboxes {"inbox_id":3,"source_id":"<jid>"}`. This returns `{"source_id","inbox":{...}}` (`contacts/contact_inboxes_controller.rb`, `_contact_inbox.json.jbuilder`). The builder is idempotent for the same contact, inbox and source (`first_or_create!`).
- Brazil caveat: WhatsApp JIDs may omit the mobile 9th digit. Normalize the number, or try both variants, before the uniqueness and lookup steps. Evolution has `mergeBrazilianContacts` for this.
- Contacts with no email, phone or identifier and no conversations are purged by `stale_without_conversations` (`contact.rb`). Always set `identifier` or `phone_number`.
- If the `email_continuity_on_api_channel` feature is enabled and a contact has an email, agent replies are **also emailed** (`messages/send_email_notification_service.rb:29-38`). Avoid setting `email` unless you want that.

### 4.4 Conversations

Create: `POST /api/v1/accounts/:id/conversations` (`conversations_controller.rb:41-46, 194-226`, `conversation_builder.rb`):

```json
{
  "inbox_id": 3,
  "contact_id": 42,
  "source_id": "5511999999999@s.whatsapp.net",
  "status": "open",
  "assignee_id": null, "team_id": null,
  "additional_attributes": {}, "custom_attributes": {},
  "message": { "content": "...", "message_type": "incoming" }
}
```

- With `inbox_id` and `contact_id`, it builds or finds the ContactInbox using **`source_id`** (a random UUID if omitted). With only `source_id` (and `inbox_id`), it looks up `@inbox.contact_inboxes.find_by!(source_id:)`.
- `status` is one of `open|resolved|pending|snoozed` (`conversation.rb:86`). If the contact is `blocked`, the conversation is created `resolved`. If the inbox has an active bot, it starts `pending`.
- `message` is optional and is passed to `MessageBuilder`. Note that it runs with `Current.user`.
- The response is the conversation partial (`views/api/v1/conversations/partials/_conversation.json.jbuilder`): `id` (display_id), `inbox_id`, `status`, `meta.sender`, `messages`, `uuid`, `account_id`, and so on. It does **not** include `contact_inbox.source_id`.

`lock_to_single_conversation` (inbox column, default `false`), from `conversation_builder.rb:10-14`:

```ruby
def look_up_exising_conversation
  return unless @contact_inbox.inbox.lock_to_single_conversation?
  @contact_inbox.conversations.last      # ANY status, incl. resolved
end
```

- When `true`, `POST /conversations` returns the **last conversation of that ContactInbox** instead of creating one.
- **This only works if you pass a stable `source_id`.** Without it, a new random-UUID ContactInbox is created for every call, so the conversation is always new.
- An `incoming` message posted into a resolved conversation **reopens** it (`message.rb:412-452`): it becomes `open!`, or `pending!` if the inbox has an active bot. For API inboxes, `Current.executed_by` is set to the contact. Snoozed conversations are opened. **Muted conversations are not reopened.**
- When `false`, every `POST /conversations` creates a new conversation. The bridge must find the open one itself:
  - `GET /api/v1/accounts/:id/conversations?inbox_id=3&source_id=<jid>&status=all` (`ConversationFinder#filter_by_source_id`, `filter_by_status`). The default status is `open`, and `all` disables the filter. Results are paginated 25 per page (`CONVERSATION_RESULTS_PER_PAGE`). The response is `{"data":{"meta":{"mine_count","assigned_count","unassigned_count","all_count"},"payload":[conversation...]}}` (`views/api/v1/accounts/conversations/index.json.jbuilder`).
  - Or `GET /api/v1/accounts/:id/contacts/:contact_id/conversations`, which returns `{"payload":[conversation...]}` with the **25 most recent** across all inboxes (`contacts/conversations_controller.rb:6-12`). Ordering is `created_at desc` in 4.18.0 and `last_activity_at desc` [develop]. Filter by `inbox_id` and `status != "resolved"` on the client side, which is what Evolution does.
- Reopen explicitly: `POST /api/v1/accounts/:id/conversations/:display_id/toggle_status {"status":"open"}`. A user is set as assignee if that user is an agent (`handle_human_open`).

**Recommendation:** use the WhatsApp JID as `source_id` and resolve the contact with `contact_inboxes/filter`. Then either set `lock_to_single_conversation: true` (WhatsApp-like single thread) or query `conversations?inbox_id&source_id&status=all` and choose a non-resolved one. Cache JID to `conversation_id` with a lock; Evolution uses a 5s lock and a 30min cache to avoid duplicate conversations under bursts.

---

## 5. Messages

### 5.1 Create

`POST /api/v1/accounts/:id/conversations/:conversation_display_id/messages` (`conversations/messages_controller.rb:8-14`, `builders/messages/message_builder.rb`). `message_params` (line 161-176):

```ruby
{ account_id:, inbox_id:, message_type: message_type, content: @params[:content], private: @private,
  sender: sender, content_type: @params[:content_type], content_attributes: content_attributes.presence,
  items: @items, in_reply_to: @in_reply_to, echo_id: @params[:echo_id], source_id: @params[:source_id] }
  .merge(external_created_at)   # params[:external_created_at] -> content_attributes.external_created_at
  .merge(automation_rule_id).merge(campaign_id).merge(template_params)
```

Fields:

- **`message_type`**: string, default `'outgoing'`. **`'incoming'` is allowed only in API inboxes**; elsewhere it raises `'Incoming messages are only allowed in Api inboxes'` (line 127-133).
- **Sender** (line 135-137, 155-159): for `incoming`, the sender is `conversation.contact`. For `outgoing`, it is the token's user, or an AgentBot if you pass `sender_type: "AgentBot", sender_id: <id>` (the bot must belong to the account or be global). That is useful for "sent from phone" echoes, so they are not attributed to a human agent or counted in first-reply metrics.
- **`private`**: boolean (cast in develop; in 4.18 the column casts `"false"` correctly anyway).
- **`content`**: at most 150,000 characters (`message.rb:80`).
- **`content_type`**: one of `text input_text input_textarea input_email input_select cards form article incoming_email input_csat integrations sticker voice_call` (`message.rb:89-103`). An invalid value raises and returns 422.
- **`content_attributes`**: a hash, or a JSON string (multipart), parsed by `safe_parse_json`. **Arbitrary keys are persisted**, because the column is serialized JSON, and echoed back in webhooks.
- Quoting, when the bridge creates a reply that quotes something:
  - `content_attributes.in_reply_to` takes a Chatwoot message id.
  - **`content_attributes.in_reply_to_external_id`** takes the quoted message's `source_id`. `Messages::InReplyToMessageBuilder` resolves it to `in_reply_to` within the same conversation (`builders/messages/in_reply_to_message_builder.rb:12-22`).
  - For agent replies, the webhook carries both `in_reply_to` and `in_reply_to_external_id`, which gives you the WhatsApp message id to quote directly.
- **`source_id`** (text): stored as given. Indexed by `index_messages_on_source_id (source_id)`, which is **NOT unique** (`message.rb:38`). Chatwoot does **not** deduplicate, so dedup is the bridge's job, either with a local store or by checking first.
  - There is no "find message by source_id" endpoint.
  - `GET .../messages` returns `source_id` per message.
  - Use a prefix convention such as `WAID:<id>`, as Evolution does.
  - Setting it is what prevents the webhook echo loop described in 3.5.
- **`echo_id`**: echoed back only in the HTTP response (`_message.json.jbuilder:4`) and in ActionCable. It is not in webhooks.
- **`external_created_at`**: stored in `content_attributes.external_created_at`. It does **not** change `created_at`, so ordering is by arrival.
- **`is_voice_message`**: boolean param (`message_builder.rb:16, 71-75`). It sets `attachment.meta.is_voice_message = true` for audio attachments.
- **Attachments**:
  - Multipart `attachments[]` (files). `file_type` is derived from `content_type` (`helpers/file_type_helper.rb`): `image/jpeg|jpg|png|gif|bmp|webp` → image; `video/ogg|mp4|webm|quicktime` → video; anything containing `audio/` → audio; everything else → file.
  - Alternatively, **signed blob ids** as strings (`attachments: ["<signed_id>"]`), used with direct uploads (`file_type_by_signed_id`).
  - At most **15 attachments** per message (`NUMBER_OF_PERMITTED_ATTACHMENTS`, `message.rb:46, 453-455`).
  - **Size and type are validated only for WebWidget inboxes** (`attachment.rb`, `should_validate_file?`: `return unless message.inbox.channel_type == 'Channel::WebWidget'`). For API inboxes Chatwoot imposes no size limit. Your reverse proxy does: the stock `deployment/nginx_chatwoot.conf` sets `client_max_body_size 0`, but many installs default to 1 MB. `MAXIMUM_FILE_UPLOAD_SIZE` (default 40 MB) applies to widget uploads and SafeFetch downloads.
- **Flood guard**: at most `CONVERSATION_MESSAGE_PER_MINUTE_LIMIT` (default **200**) messages per conversation per minute (`message.rb:295-304`, `lib/limits.rb:14-16`). Beyond that you get `422 {"error":"Validation failed: Too many messages"}`. The controller rescues `StandardError` and returns 422 with `{"error": e.message}`.

Response (`views/api/v1/models/_message.json.jbuilder`):

```json
{ "id": 123, "content": "...", "inbox_id": 3, "echo_id": "...", "conversation_id": 7,
  "message_type": 0,            // INTEGER here (0 incoming,1 outgoing,2 activity,3 template)
  "content_type": "text", "status": "sent", "content_attributes": {}, "created_at": 1760000000,
  "private": false, "source_id": "WAID:...", "sender": {...push_event_data, "type":"contact"},
  "attachments": [ ... ] }
```

### 5.2 Upload helpers

These matter for the audio problem in section 7.

- `POST /api/v1/accounts/:id/upload` takes multipart `attachment`, or `external_url` (image or video only, via SafeFetch content-type allow-list). It returns `{"file_url","blob_id": "<signed_id>"}` and uploads **synchronously** (`ActiveStorage::Blob.create_and_upload!`, `upload_controller.rb:39-49`). It is **throttled to 60 requests per hour per account**.
- `POST /api/v1/accounts/:id/conversations/:cid/direct_uploads` is the standard ActiveStorage direct upload (`conversations/direct_uploads_controller.rb`). You send `{blob:{filename, byte_size, checksum(base64 md5), content_type}}` and get back `signed_id` plus a `direct_upload{url, headers}` to `PUT` the bytes to. It has no Rack::Attack throttle.

### 5.3 Status updates

`PATCH /api/v1/accounts/:id/conversations/:cid/messages/:message_id` (`messages_controller.rb:2, 16-19, 92-96`):

```json
{ "status": "delivered", "external_error": null }
```

- `status` is one of `sent|delivered|read|failed`. This is **only for API inboxes**; elsewhere it returns 403 `{"error":"Message status update is only allowed for API inboxes"}`.
- `Messages::StatusUpdateService` (`services/messages/status_update_service.rb:36-45`) allows only forward transitions, plus any transition to or from `failed`. A `read` message cannot go back to `delivered`, and that request is silently ignored.
- `external_error` is kept only for `failed`.
- It triggers `message_updated` to your own webhook.
- The response is the message partial.
- Alternatively, `POST /public/api/v1/inboxes/{identifier}/contacts/{source_id}/conversations/{cid}/update_last_seen` enqueues `Conversations::UpdateMessageStatusJob`, which marks prior outgoing messages read in bulk.
- `POST .../messages/:id/retry` re-queues a `failed` message. For API inboxes it **keeps** `source_id` (`messages_controller.rb:69-82`), and the webhook fires again.

---

## 6. Deletion, edit events and rate limits

### 6.1 Deletion and edit

- An agent deletes a message with `DELETE /api/v1/accounts/:id/conversations/:cid/messages/:id` (`messages_controller.rb:21-28`). It **updates** the row: content becomes the I18n text `conversations.messages.deleted` ("This message was deleted"), `content_type` becomes `text`, `content_attributes` becomes `{deleted: true}` (develop keeps `forwarded_message_id`), and all attachments are destroyed.
- This produces **`message_updated`** with `content_attributes.deleted == true`. The original `id` and `source_id` are kept, so you can map it to a WhatsApp delete-for-everyone. Evolution uses exactly this signal (`body.event === 'message_updated' && body.content_attributes?.deleted`).
- **There is no edit endpoint for message content** in the Application API. `update` only changes `status`. Agents cannot edit sent messages, so no edit event exists.
- There is no hard-delete event. `DELETE /conversations/:id` (admin) emits no message events.

### 6.2 Rate limits

From `config/initializers/rack_attack.rb`. These are enabled in production by default (`ENABLE_RACK_ATTACK`, default true, line 407) and use Redis.

| Throttle | Limit | Key |
|---|---|---|
| `req/ip` (all requests) | `RACK_ATTACK_LIMIT`, default **3000/min** in code (line 128). `.env.example` suggests 300. | IP |
| `/api/v1/accounts/:account_id/contacts/search` | `RATE_LIMIT_CONTACT_SEARCH`, default **100/min** (line 332) | account |
| `/api/v1/accounts/:account_id/upload` | **60/hour** (line 326), hard-coded | account |
| `/conversations/:id/transcript` | 1000/h | account |
| `DELETE /conversations/:id` | 60/min | account |
| `/conversations/meta` | 30/min | user or token |
| Widget APIs | various | not relevant |

- No specific throttle applies to contacts filter or create, conversations, messages, `contact_inboxes/filter`, or `/public/api/v1/...`. They are bound only by `req/ip` and the per-conversation flood guard (200/min).
- Throttled requests get `429` from Rack::Attack.
- `127.0.0.1` and `::1` are always safelisted. Add more with `RACK_ATTACK_ALLOWED_IPS` (comma-separated). This is useful when the bridge sits next to Chatwoot.
- Behind a reverse proxy `req.ip` may be the proxy's address, depending on trusted proxies, so all clients can end up sharing one bucket.
- **Prefer `contacts/filter` or `contact_inboxes/filter` over `contacts/search`**, because of the search throttle and the exact-match semantics.

---

## 7. Audio showing 00:00 (#14511, #14644)

- **#14511** (v4.13.0, local disk): **closed by the reporter (`israeleijtec`) on 2026-05-25, without a fix PR**.
- **#14644** (v4.14.x, S3/B2, `Channel::Api`): **still OPEN**. A comment confirms it on **v4.18.0**.
- The candidate frontend fix, **PR #13675** ("fix: retry loading audio attachments", which extends `useLoadWithRetry` to audio), is **still open and unmerged**. In current source `useLoadWithRetry` is used only by `Image.vue`, and `components-next/message/chips/Audio.vue` has no retry.

**Root cause** is a race, not the codec:

1. The message row commits, and `message.created` is broadcast over ActionCable (enqueued on commit).
2. ActiveStorage uploads the file in the attachment's `after_commit`. For S3 this is a synchronous upload inside the request, measured at about 1.5s in the #14644 comment.
3. A browser that already has the conversation open requests `/rails/active_storage/blobs/redirect/...` (or `/disk/...`) before the object exists and gets **404**.
4. The `<audio>` element shows `00:00 / 00:00` and never retries. After a reload the file plays.

Facts from the issues:

- It is deterministic: a conversation that is open when the message arrives fails 0/15 times out of 15. One opened later works about 15/15.
- It also affects audio recorded by agents.
- The enterprise `broadcast_message_update_for_audio` re-broadcast does not fix it.

Separately, `Audio.vue:55-82` already handles WebM/Opus blobs with `duration = Infinity` (the `resolveStreamingDuration` seek trick). Format is therefore not the cause of the 00:00.

There is **no `is_recorded_audio` param in Chatwoot**. The real param is `is_voice_message` (`message_builder.rb:16, 71-75`). It only sets `attachment.meta.is_voice_message`, which the WhatsApp Cloud sender uses to send OGG as a voice note (`whatsapp_cloud_service.rb:170`). It is not in webhook payloads. `is_recorded_audio` is an Evolution API concept.

Recommended workarounds for the bridge:

1. **Upload the blob first, then create the message referencing it.** Use `POST .../conversations/:cid/direct_uploads`, `PUT` the bytes, then `POST .../messages` with `attachments: ["<signed_id>"]` (JSON body). You can also use `POST /api/v1/accounts/:id/upload` and then `attachments: [blob_id]`, but that is throttled to 60/h. The object then exists in storage **before** the message row and its broadcast, which removes the race for bridge-created incoming audio.
   - This is inferred from the code path (`process_attachments` accepts signed-id strings, and `file_type_by_signed_id`). I have not tested it live.
   - It does not help for agent-recorded audio. For that, the only fixes are server-side: PR #13675, or the `ActiveStorage::Blobs::RedirectController` "wait for fresh blob" initializer posted in #14644.
2. **Send correct MIME types and extensions.** WhatsApp PTT is OGG/Opus, so use `content_type: audio/ogg` with filename `*.ogg`. #14644 had `extension: mp3` with `content_type: audio/opus`, which is inconsistent. Chrome and Firefox play `audio/ogg` (Opus). **Safari does not play OGG/Opus**, so if Safari agents matter, transcode to MP3 (`audio/mpeg`, `.mp3`). For API inboxes the dashboard recorder itself produces **MP3** (`ReplyBox.vue:468-478`: `if (this.isAPIInbox) return AUDIO_FORMATS.MP3`). Agent voice replies therefore arrive as `audio/mpeg`, and the bridge must convert them to OGG/Opus to deliver them as WhatsApp PTT.
3. Pass `is_voice_message=true` for PTT, for semantics and future-proofing. It has no visible effect on API inboxes today.

---

## 8. SSRF and URL restrictions on `webhook_url`

- **Since v4.14.0**, `Webhooks::Trigger#perform_request` uses `SafeFetch.fetch` (`lib/webhooks/trigger.rb:41-52`). Before that it used `RestClient`, which had no SSRF filter.
- **By default, private and loopback destinations are blocked at delivery time.** `SafeFetch::Fetcher#perform_request` (`lib/safe_fetch/fetcher.rb:46-50`):

```ruby
def perform_request(&)
  return SafeFetch::PrivateNetworkRequest.new(options).perform(&) if SafeFetch.allow_private_network?
  SsrfFilter.public_send(options.method, options.url, **options.request_options, &)
end
```

- `ssrf_filter` 1.5.0 blocks these IPv4 ranges: `0.0.0.0/8, 10/8, 100.64.0.0/10` (**this includes Tailscale/CGNAT**), `127/8, 169.254/16, 172.16/12, 192.0.0/24, 192.0.2/24, 192.168/16, 198.18/15, 198.51.100/24, 203.0.113/24, 224/4, 240/4, 255.255.255.255`. For IPv6 it blocks `::1, fc00::/7, fe80::/10, ff00::/8`, and others. Hostnames are resolved, and **all** resolved IPs must be public: `raise PrivateIPAddress, "Hostname '#{hostname}' has no public ip addresses"`. Only `http` and `https` are allowed, with at most 10 redirects. Docker service names such as `http://bridge:8080` resolve to private IPs and are **blocked**.
- **When blocked, the failure is silent apart from the UI:** the exception is caught by `execute`, logged as `"Exception: Invalid webhook URL ..."`, and for `message_created`/`message_updated` the agent's message is marked **failed** with `external_error` set to the ssrf_filter message.
- **The opt-out (v4.15.0+)** is the env var `SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true` (`lib/safe_fetch.rb:36-38`, `.env.example:287-289`): "Keep disabled by default. Self-hosted installations can enable this to allow SafeFetch requests to private network URLs." This is global: it also relaxes SafeFetch for avatar and attachment downloads. **v4.14.0 to 4.14.2 have no opt-out.** A private-network bridge cannot receive webhooks on those versions unless it is exposed on a public IP or hostname.
- Chatwoot Cloud cannot reach private bridges at all.
- Bridge docs should tell self-hosters to set `SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true` on both the `rails` and `sidekiq` containers. Webhooks run in Sidekiq, so the variable must be present there. Otherwise expose the bridge via a public URL.

---

## Things I could not determine from source

- Whether direct-upload-first fully eliminates the audio 404 on S3 backends. This is inferred from the code path, not tested live.
- How Marcel content-type detection reclassifies an uploaded `audio/ogg` Opus file. ActiveStorage may override the declared `content_type` after analysis.
