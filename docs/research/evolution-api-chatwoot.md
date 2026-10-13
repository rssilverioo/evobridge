# Evolution API v2 (Node): how the built-in Chatwoot integration behaves

Studied: `github.com/EvolutionAPI/evolution-api` (it now redirects to `evolution-foundation/evolution-api`). Shallow clone, HEAD `fa09d37` (2026-05-06), package version **2.3.7**.
Clone: `scratchpad/research/evolution-api`.

Path abbreviations used below:
- **SVC** = `src/api/integrations/chatbot/chatwoot/services/chatwoot.service.ts` (2714 lines)
- **IMP** = `src/api/integrations/chatbot/chatwoot/utils/chatwoot-import-helper.ts`
- **CTL** = `.../chatwoot/controllers/chatwoot.controller.ts`, **RTR** = `.../chatwoot/routes/chatwoot.router.ts`, **DTO** = `.../chatwoot/dto/chatwoot.dto.ts`, **SCH** = `.../chatwoot/validate/chatwoot.schema.ts`, **PG** = `.../chatwoot/libs/postgres.client.ts`
- **BAI** = `src/api/integrations/channel/whatsapp/whatsapp.baileys.service.ts`
- **CHS** = `src/api/services/channel.service.ts`, **INST** = `src/api/controllers/instance.controller.ts`

The goal was to learn its behaviour, not to reuse its code. Nothing below is copied code, only descriptions plus a few short identifiers.

---

## 0. License, NOTICE and trademark terms

**LICENSE** (top of file): *"Evolution API is licensed under the Apache License 2.0, with the following additional conditions:"*
1. Commercial use is allowed. A commercial license is required from the producer when either of these conditions applies:
   - a. **LOGO and copyright information**: "In the process of using Evolution API's frontend components, you may not remove or modify the LOGO or copyright information in the Evolution API console or applications. This restriction is inapplicable to uses of Evolution API that do not involve its frontend components."
   - b. **Usage Notification Requirement**: "If Evolution API is used as part of any project, including closed-source systems (e.g., proprietary software), the user is required to display a clear notification within the system that Evolution API is being utilized. This notification should be visible to system administrators and accessible from the system's documentation or settings page. Failure to comply with this requirement may result in the necessity for a commercial license, as determined by the producer."
   - Contact: suporte@evofoundation.com.br. "Apart from the specific conditions mentioned above, all other rights and restrictions follow the Apache License 2.0."

**NOTICE**:
> Evolution API — Copyright 2026 Evolution Foundation. This product includes software developed by Evolution Foundation (https://evolutionfoundation.com.br).
> Trademark notice: "Evolution Foundation", "Evolution" and "Evolution API" are trademarks of Evolution Foundation. The Evolution API logo, wordmark, and visual identity are governed by the Trademark and Brand Assets Policy included in this repository (TRADEMARKS.md).
> Third-party attributions: This product includes software derived from CodeChat WhatsApp API (https://github.com/code-chat-br/whatsapp-api), originally licensed under MIT. The CodeChat project implemented the Baileys library … which Evolution API also uses.

**TRADEMARKS.md** (v1.0, 2026-05-06):
- §2.1 and §2.3: you may truthfully and nominatively say your software is "based on / compatible with" Evolution API, as long as you don't imply endorsement.
- §3 protects these: the names "Evolution Foundation", "Evolution" and "Evolution API"; the logo and wordmark; the copyright line; the official palette (#0a0a0a, #00ffa7, …); the typography; and the 10px radius.

**What this means for an MIT bridge.** Re-implementing behaviour you learned from reading is not a derivative work, so Apache's NOTICE obligations apply only if code is actually copied. A sidecar that only talks to Evolution Go over HTTP does not incorporate Evolution API, so condition (b) should not apply to it. Avoid "Evolution" or "Evo" in the product name, logo or colours. Write "compatible with Evolution Go" instead. Also don't replicate the bot contact's default branding: SVC:239-240 defaults the organization to `EvolutionAPI` and the logo to an evolution-api.com favicon. (This is a reading of the license, not legal advice.)

---

## 1. Setup and provisioning

### 1.1 Configuration fields
These are in DTO:3-21, SCH:22-43 and the Prisma model `Chatwoot` (`prisma/postgresql-schema.prisma:216-239`). There is one row per instance.

| field | meaning | default / required |
|---|---|---|
| `enabled` | on/off | required (SCH:42) |
| `accountId` | Chatwoot account id | required |
| `token` | `api_access_token` of a Chatwoot **user** (agent/admin), not an agent-bot token. IMP:446-450 resolves the user from the `access_tokens` table to attribute imported outgoing messages. | required |
| `url` | Chatwoot base URL. CTL:18 validates it with `isURL(require_tld:false)`. | required |
| `nameInbox` | Inbox **name**. Afterwards the inbox is found **by name** (SVC:909), so renaming it in Chatwoot breaks the link. | defaults to instanceName (CTL:36-38). When created via instance create, it is `instanceName.split('-cwId-')[0]` (SVC:122, INST:236). |
| `signMsg` | Prefix agent name on outgoing WhatsApp text | required |
| `signDelimiter` | Separator between signature and text. The string literal `\n` is turned into a real newline (SVC:1458-1460). | `\n`; forced null when signMsg=false (CTL:33) |
| `reopenConversation` | Reuse the existing conversation even when it is resolved | required, default false |
| `conversationPending` | New conversations, and reopened non-open ones, get status `pending` | required, default false |
| `mergeBrazilContacts` | Merge the BR contact pair "with 9" and "without 9" | false |
| `importContacts`, `importMessages`, `daysLimitImportMessages` | History import through **direct Chatwoot Postgres access** | instance-create defaults: true/true/60 (INST:241-244) |
| `autoCreate` | Create the inbox, bot contact and init conversation | instance-create default: true (`!== false`, INST:247) |
| `organization`, `logo` | Name and avatar of the bot contact "123456" | `EvolutionAPI` / evolution favicon |
| `number` | Phone number for pairing code. Sent as `init:<number>`. | optional |
| `ignoreJids` | Array. The special entries `@g.us` (all groups) and `@s.whatsapp.net` (all 1:1) work as wildcards, or list exact JIDs (SVC:1966-1994). | [] |

**Global env** (`src/config/env.config.ts:812-823`, `env.example:212-217`):
- `CHATWOOT_ENABLED`
- `CHATWOOT_MESSAGE_DELETE`: mirror WhatsApp revokes into Chatwoot.
- `CHATWOOT_MESSAGE_READ`: when an agent replies, mark the last inbound WhatsApp message as read.
- `CHATWOOT_BOT_CONTACT`: default true.
- `CHATWOOT_IMPORT_DATABASE_CONNECTION_URI`: Chatwoot's Postgres. It enables import, labels, lost-message sync, the source_id rewrite and the duplicate check.
- `CHATWOOT_IMPORT_PLACEHOLDER_MEDIA_MESSAGE`

**HTTP API** (RTR:9-41, mounted at `/chatwoot` in `chatbot.router.ts:19`):
- `POST /chatwoot/set/:instanceName` and `GET /chatwoot/find/:instanceName` are guarded.
- `POST /chatwoot/webhook/:instanceName` has **no guard** (RTR:32). Anyone who knows the instance name can post forged webhooks.
- Responses include the computed `webhook_url = ${SERVER_URL}/chatwoot/webhook/${encodeURIComponent(instanceName)}` (CTL:43-46).

### 1.2 What `autoCreate` does (SVC:113-131 then `initInstanceChatwoot` SVC:168-291)
1. It persists the configuration (SVC:114).
2. `GET /api/v1/accounts/{acc}/inboxes`. If no inbox has the name `nameInbox`, it runs `POST /api/v1/accounts/{acc}/inboxes` with `{name, channel:{type:'api', webhook_url}}`. **webhook_url = `${SERVER_URL}/chatwoot/webhook/<instanceName>`**, which points back at Evolution itself (SVC:118-123, 194-205). An existing inbox with the same name is reused without changing its webhook (SVC:213-222).
3. If `CHATWOOT_BOT_CONTACT` is on (default), it finds or creates a **contact with phone `+123456`** in that inbox. The contact's name is `organization` and its avatar is `logo` (SVC:231-241).
4. With `qrcode=true` (always true from `create`), it creates a conversation with that contact and posts an **outgoing** message `init`, or `init:<number>` (SVC:251-287).

**Why the bot contact "123456" exists.** It is an in-Chatwoot control panel for the WhatsApp session:
- The `init` message posted in step 4 fires Chatwoot's webhook back to Evolution. `receiveWebhook` sees `chatId === '123456'` with an outgoing message and runs it as a command (SVC:1376-1442).
- Commands are `init` / `iniciar[:number]` (connect, which produces a QR or pairing code), `status`, `clearcache` and `disconnect` / `desconectar` (logout).
- The QR image, pairing code, "connected", "status: closed", "QR limit reached" and import progress messages are all posted into that conversation as **incoming** messages from the bot contact (SVC:2447-2524, `createBotQr` SVC:1121-1192, `createBotMessage` SVC:994-1048).
- This lets an agent connect WhatsApp without leaving Chatwoot.

### 1.3 Chatwoot endpoints it calls
This list covers the REST calls via `@figuro/chatwoot-sdk` and `chatwootRequest`, and the direct `axios` multipart uploads.

| Purpose | Endpoint | Where |
|---|---|---|
| list inboxes | `GET /api/v1/accounts/{a}/inboxes` | SVC:184, 900 |
| create API inbox | `POST /api/v1/accounts/{a}/inboxes` | SVC:199 |
| create contact | `POST /api/v1/accounts/{a}/contacts` (`inbox_id,name,identifier,avatar_url,phone_number`) | SVC:331 |
| update contact | `PUT /api/v1/accounts/{a}/contacts/{id}` | SVC:379 |
| search contact (groups, identifier) | `GET /api/v1/accounts/{a}/contacts/search?q=` | SVC:437, 497 |
| filter contacts by phone or identifier | `POST /api/v1/accounts/{a}/contacts/filter` | SVC:502-508, 454 |
| merge contacts | `POST /api/v1/accounts/{a}/actions/contact_merge` | SVC:525, 543 |
| contact's conversations | `GET /api/v1/accounts/{a}/contacts/{id}/conversations` | SVC:813, 982 |
| get conversation | `GET /api/v1/accounts/{a}/conversations/{id}` | SVC:676, 2425 |
| create conversation | `POST /api/v1/accounts/{a}/conversations` (`contact_id,inbox_id[,status:'pending']`) | SVC:864, 258 |
| toggle status | `POST /api/v1/accounts/{a}/conversations/{id}/toggle_status` (`pending`) | SVC:832 |
| create message (JSON) | `POST /api/v1/accounts/{a}/conversations/{id}/messages` | SVC:946 |
| create message (multipart) | same URL, `attachments[]`, `content`, `message_type`, `source_id`, `content_attributes`, `source_reply_id`, header `api_access_token` | SVC:1070-1118 |
| delete message | `DELETE /api/v1/accounts/{a}/conversations/{c}/messages/{m}` | SVC:2347 |
| mark seen (read receipts) | `POST /public/api/v1/inboxes/{inbox_identifier}/contacts/{source_id}/conversations/{id}/update_last_seen` | SVC:2434-2441 |

**Direct SQL against Chatwoot's Postgres** (only when the import URI is set):
- `tags` / `taggings`: label every contact with the inbox name (SVC:391-426).
- `labels`, `contacts`, `contact_inboxes`, `conversations` and `messages` bulk inserts for history (IMP:96-169, 274-326, 377-437).
- `UPDATE messages SET source_id='WAID:<id>', status=0, created_at=NOW()` on agent messages after they are sent (IMP:570-576).
- `SELECT … FROM messages WHERE source_id = ANY(...)` to check for duplicates (IMP:179-207).
- the lost-message scan (SVC:2667-2673).

The `NOW()` rewrite is the root cause of the "**timestamps shifted -3h**" issues (#1495, #1954). The community fix is `ALTER DATABASE … SET timezone TO 'GMT'`. **Lesson: never write Chatwoot's DB directly.**

---

## 2. Inbound: WhatsApp to Chatwoot

### 2.1 Wiring from the WhatsApp pipeline (Baileys)
- The Baileys socket is created with **`emitOwnEvents: false`** (BAI:658). Messages sent through the API are **not** re-emitted as `messages.upsert`. Messages typed on the **phone** or another linked device still arrive as upsert with `fromMe=true`.
- `messages.upsert` (BAI:1082) works like this:
  - It skips decrypt-failure stubs (BAI:1088-1104).
  - Edits (`protocolMessage` / `editedMessage`) are routed to `eventWhatsapp('messages.edit')` (BAI:1124-1130).
  - It then keeps only `type` `notify`/`append` that have a message (BAI:1166).
  - It builds `messageRaw = prepareMessage(received)`, calls `chatwootService.eventWhatsapp(MESSAGES_UPSERT, …, messageRaw)` (BAI:1325-1341) **before** saving to the DB, and copies the returned Chatwoot `id/inbox_id/conversation_id` into the Message row (`chatwootMessageId` etc., BAI:1337-1340).
  - Only **after** that does it swap `remoteJid := remoteJidAlt` for LID, and only for the outgoing webhook (BAI:1478-1480). Chatwoot therefore receives the raw key with `addressingMode`, `remoteJidAlt` and `participantAlt`.
- Messages sent by API calls (not from Chatwoot), such as n8n or Typebot via `/message/sendText`, go through `sendMessageWithTyping`. With `isIntegration=false` they call `eventWhatsapp(SEND_MESSAGE)` (BAI:2439-2444), so **they appear in Chatwoot as outgoing**. Messages that originate *from* Chatwoot pass `isIntegration=true` and are **not** mirrored back.
- Other hooks:
  - `messages.update` with `READ` on a fromMe message calls `eventWhatsapp('messages.read')` (BAI:1589-1596).
  - `update.message===null && status===undefined` (revoke) calls `MESSAGES_DELETE` (BAI:1655-1666).
  - `contacts.upsert` updates the name and avatar of the matching Chatwoot contact (BAI:871-886).
  - Connection, QR and status events go to the bot conversation (BAI:342-347, 395-403, 451-456, 500-506).
  - History sync is handled at BAI:2019-2031, with the day limit at BAI:955.
  - On `open` it starts `syncChatwootLostMessages` plus a cron at :00 and :30 (BAI:4706-4732).

### 2.2 `eventWhatsapp` filters, in order (SVC:1950-2047)
1. `ignoreJids` (wildcards `@g.us` and `@s.whatsapp.net`, or exact JIDs) (SVC:1966-1994).
2. `status@broadcast` is dropped (SVC:1998).
3. `ephemeralMessage` is unwrapped (SVC:2002-2006).
4. The text is extracted (`getConversationMessage`, SVC:1760-1948), then **WhatsApp markdown is converted to Chatwoot markdown**: `*b*`→`**b**`, `_i_`→`*i*`, `~s~`→`~~s~~` (SVC:2009-2014).
5. Text containing `/survey/responses/` plus `http` (the Chatwoot CSAT link echoed back) is dropped (SVC:2016-2018).
6. If there is no text, no media, no reaction and no interactive button, the message is **silently dropped** ("no body message found", SVC:2044-2047). Unhandled types are lost this way: `templateMessage` (#2666), polls, button replies and others.

### 2.3 Contact lookup and creation
- **Phone lookup** (`findContact`, SVC:477-521):
  - 1:1 chats use `POST contacts/filter` with `phone_number equal_to` across number variants joined with OR (SVC:611-630).
  - The variants come from `getNumbers` (SVC:592-605). For `+55` numbers they cover both the **with-9** (14 chars incl. `+`) and **without-9** (13 chars) forms.
  - Groups use `contacts/search?q=<groupJid>` and match on `identifier === groupJid` (SVC:496-500, 519).
- **Picking among several matches** (`findContactInContactList`, SVC:559-590):
  - If there are exactly 2 matches, `mergeBrazilContacts` is on and the number is +55, it calls `contact_merge` with base = 14-char (with 9) and mergee = 13-char (without 9) (SVC:541-557, 564-569).
  - Otherwise it prefers the contact whose phone equals the **longest** variant (the one with 9), then any match.
- **Create** (`createContact`, SVC:293-363):
  - 1:1 contacts get `{inbox_id, name: pushName||phone, identifier: <jid>, avatar_url}` plus `phone_number: +<digits>` whenever the jid contains `@` (SVC:311-321).
  - Groups get `identifier = groupJid`, no phone, and the name `"<subject> (GROUP)"` (SVC:322-329, 737).
  - On **HTTP 422** (identifier already taken) it falls back to `findContactByIdentifier` (search, then `filter identifier equal_to`) and reuses that contact (SVC:349-357, 428-475).
  - With the DB URI configured it then labels the contact with the inbox name (SVC:345).
- **Identifier convention:** `identifier` is the full JID (`5511...@s.whatsapp.net` or `...@g.us`). For `@lid` messages it uses the phone JID taken from `remoteJidAlt`, never the LID (SVC:633-635, 801).
- **Name and avatar refresh:**
  - On every inbound non-fromMe message, the contact's avatar is compared to WhatsApp's by **file name** and updated if it differs. The name is updated if it is empty or equals the bare number (SVC:775-792).
  - Every message also queries the WhatsApp profile picture (SVC:769). Group participants get the same treatment (SVC:739-766).
  - fromMe messages never overwrite the name: `nameContact = chatId` when fromMe (SVC:727).

### 2.4 LID (`@lid`) handling
- `isLid = key.addressingMode === 'lid'`. In 1:1 chats the **phone JID = `key.remoteJidAlt`**. In groups the participant is `key.participantAlt` (except for fromMe) (SVC:633-635, 736, 2089-2092, 2271-2274).
- "Upgrade" pass on every message (SVC:644-666):
  - It looks up a contact by phone. If its `identifier !== remoteJid`, it PUTs `identifier = phoneJid, phone_number = +digits`.
  - If that PUT fails, for example because another contact already owns the identifier, it calls `contact_merge`. The aim is to fold old LID-identified duplicates into the phone contact.
- **Known holes:**
  - If `remoteJidAlt` is **absent**, `phoneNumber.split` throws, the conversation is never created and **100% of that contact's messages are lost** (issue #1872, fix PR #2718 falls back to the LID).
  - `createContact` sets `phone_number = +<lid digits>` whenever the jid has `@` (SVC:319-321). A LID-only contact therefore becomes a "random number" contact, a duplicate that can't be replied to (#2071, #2302, #1166).
  - The conversation cache key uses the raw `remoteJid` (the LID) while the Chatwoot `identifier` is the phone JID. The resolved-cache invalidation (SVC:1318-1326, keyed by `meta.sender.identifier`) therefore misses LID chats. This is an inference from the code.

### 2.5 Picking, creating and reopening the conversation (`createConversation`, SVC:632-885)
- **Cache:** the key is `<instance>:createConversation-<remoteJid>`, holding the conversation id with a **TTL of 1800 s** (SVC:637, 850, 875).
  - On a cache hit it still runs `GET conversations/{id}` on every message. If the conversation is gone (deleted in Chatwoot), it drops the cache and recurses (SVC:671-693).
  - The cache also holds `getProvider` and `getInbox`, the latter with no TTL (SVC:61-79, 887-918).
  - The `/clearcache` command or a config save wipes it (CHS:359-362).
- **Lock:** the key is `<instance>:lock:createConversation-<remoteJid>` with a TTL of 30 s.
  - Concurrent callers poll every **300 ms for up to 5 s** and take the cached id as soon as it appears.
  - The owner checks the cache again after acquiring the lock and releases the lock in `finally` (SVC:638-639, 695-724, 877-880).
  - This is the fix for "a burst of messages from a new contact creates N conversations".
- **Selection** (SVC:813-853) uses `GET contacts/{id}/conversations` and keeps the conversations in **this inbox**:
  - `reopenConversation = true`: it takes the **first** conversation in this inbox **whatever its status**, resolved included. If `conversationPending` is on and that conversation's status `!== 'open'`, it toggles it to `pending`. The message is then posted into it; Chatwoot itself reopens a resolved conversation when an incoming message arrives (Chatwoot-side behaviour, not verified in Chatwoot code here). Net effect: **one conversation per contact per inbox, forever**.
  - `reopenConversation = false`: it takes a conversation in this inbox whose status `!== 'resolved'`, so open, pending or snoozed. If there is none, it **creates a new conversation**, with `status:'pending'` if `conversationPending` is on (SVC:855-867).
  - When Chatwoot fires `conversation_status_changed → resolved` and reopen is off, the cache key is deleted so the next message creates a fresh conversation (SVC:1318-1326).
- **Known complaints:**
  - The pending flag pushed already-open conversations back to pending. This was fixed by adding the `status !== 'open'` guard (#354).
  - Conversations reopen even with the option disabled (#751), and new messages don't appear as Open (#2002).
  - A deleted contact never gets a new conversation until the cache is cleared (#1718).

### 2.6 How messages are created
- `message_type = fromMe ? 'outgoing' : 'incoming'` (SVC:2056). **Messages sent from the phone or another API client appear as outgoing**, attributed to the token's user (no specific agent). Users have asked for them to become private notes instead (#2014).
- `source_id = 'WAID:' + key.id` on **every** bridge-created message (SVC:2113, 2132, 2157, 2202, 2258, 2293, 2312).
- Text: JSON `POST …/messages` with `{content, message_type, private:false, source_id, content_attributes:{in_reply_to, in_reply_to_external_id}, source_reply_id}` (SVC:920-968).
- **Media** (SVC:2058-2143):
  1. Download through `getBase64FromMediaMessage`, which decrypts via WhatsApp.
  2. Build the file name: the original name plus `-<random 2 digits>` (`foo-37.pdf`), or `<random>.<ext-from-mime>`.
  3. Send a **multipart** POST with `attachments[]`, `content` (the caption), `message_type`, `source_id`, `content_attributes` (JSON string, only if a reply) and `source_reply_id` (SVC:1050-1119).
  - Before uploading, it checks Chatwoot's DB for that `source_id` in the conversation and skips if found (SVC:1061-1069, needs the DB URI).
  - Stickers, images, video, audio, documents, `documentWithCaption` and `viewOnceMessageV2` all count as media (SVC:1702-1718).
- **Non-media types rendered as text:**
  - location: a formatted block plus a Google Maps link (SVC:1796-1813)
  - vCard and contact arrays: name and numbers (SVC:1815-1881)
  - list and list-response (SVC:1883-1937)
  - PIX "payment_info" buttons (SVC:2169-2211)
  - **Click-to-WhatsApp ads** (`externalAdReply`): the thumbnail is downloaded, cropped to 320×180 PNG and uploaded with `text + **title** + body + sourceUrl` (SVC:1724-1743, 2213-2267)
- **Groups:** the conversation contact is the **group** (`<subject> (GROUP)`, identifier = group JID).
  - Each participant is also upserted as their own contact (with phone and avatar) but is **not** the sender in Chatwoot. The sender is shown by **prefixing the content**: `**+55 11 98765-4321 - PushName:**\n\n<text>`, with the number formatted by libphonenumber (SVC:2087-2103, 2269-2283).
  - fromMe group messages get no prefix.
  - Reported problems: group conversations only appear after the owner posts (#1811), and group contacts are invisible because `contact_type=0` (#1834).
- **Reactions** (SVC:2145-2167): a new message whose content is **just the emoji**, sent as a reply to the reacted message (`in_reply_to` resolved via the Message table). Removing a reaction (empty text) is ignored. There is no Chatwoot-to-WhatsApp reaction.
- **Quotes / replies:**
  - `stanzaId` comes from `message.extendedTextMessage.contextInfo` or `message.contextInfo` (`prepareMessage` lifts it).
  - `getReplyToIds` maps `stanzaId` to the `chatwootMessageId` of the stored Message, giving `content_attributes.in_reply_to = <cw id>` and `in_reply_to_external_id = <wa id>` (SVC:1656-1677). `source_reply_id` is also set from `quotedMsg.chatwootMessageId` (SVC:944, 2020-2035).
  - If the quoted message is not in the DB or has no Chatwoot id, the reply context is lost. Issue #2078 is a regression where `prepareMessage` dropped `contextInfo` on text replies.
- **Edits** (SVC:2356-2406):
  - The edited text is read from `editedMessage.{conversation|extendedTextMessage.text|image/video/document caption}`.
  - It finds the original by key id and **creates a new message** `` `Mensagem editada:` `` followed by the new text, as a **reply** to the original, with the same direction and `source_id 'WAID:'+key.id`. That reuses the original's WAID, because the protocol key equals the original key.
  - It does **not** edit the original Chatwoot message. Chatwoot-to-WhatsApp edits are not supported, because `message_updated` without `deleted` is ignored.
- **Deletes / revokes, WhatsApp to Chatwoot** (SVC:2325-2354): only when `CHATWOOT_MESSAGE_DELETE=true`. It finds the Message by key id. If it has a Chatwoot id and conversation, it **deletes the local row first** and then calls Chatwoot `DELETE …/messages/{id}`, which shows as "This message was deleted".
- **Read receipts, WhatsApp to Chatwoot** (SVC:2408-2445):
  - When WhatsApp reports `READ` on a fromMe message, it finds the Message, takes its conversation and `chatwootContactInboxSourceId`. If the source id is missing it fetches the conversation and uses `last_non_activity_message.conversation.contact_inbox.source_id`.
  - It then calls the **public** client API `update_last_seen` with the inbox's `inbox_identifier`. That marks the conversation as seen by the contact, so outgoing messages show as read.
  - There is **no `delivered` status** (#2014 comment).
- **Lost-message reconciliation** (SVC:2652-2713, needs the DB URI and `DATABASE_SAVE_DATA_MESSAGE_UPDATE`):
  - It runs on connect and every 30 min. It reads Chatwoot messages of the last 6 h, finds Evolution messages of the last 6 h whose ids are not among Chatwoot's `source_id`s, and bulk-inserts them via SQL.
- **History import** (IMP, BAI:940-1068, 2015-2031):
  - It buffers the Baileys history-sync batches in memory, filtered by `daysLimitImportMessages`.
  - 10 s after the history sync reports 100%, it runs a single SQL statement that creates the missing contacts, `contact_inboxes` (random uuid `source_id`) and conversations (status 0 = open) per phone number. It then bulk-inserts messages in batches of 4000, with `sender_type` set to the token user for fromMe and `source_id 'WAID:<id>'`.
  - Media is skipped, or replaced by `_<Image Message>_` placeholders when `PLACEHOLDER_MEDIA_MESSAGE` is on (IMP:497-556). Groups are excluded (IMP:566-568).
  - It only works if Chatwoot is configured **before** the first QR scan (#2014).

---

## 3. Outbound: Chatwoot to WhatsApp (`receiveWebhook`, SVC:1307-1607)

- **Which inbox and instance:** the instance comes from the URL (`/chatwoot/webhook/:instanceName`). The handler first sleeps **500 ms** (SVC:1309); the reason isn't documented. It then processes everything **synchronously** before replying `{message:'bot'}`, usually with HTTP 200.
- **Events consumed:**
  - `message_created`, implicitly: anything with `body.conversation`.
  - `message_updated` **only if** `content_attributes.deleted`.
  - `conversation_status_changed` (resolved), only for cache invalidation.
  - Everything else returns early: payloads without `conversation`, `body.private` notes, and other `message_updated` events (SVC:1328-1334).
- **Recipient:** `chatId = conversation.meta.sender.identifier` (the JID), or `meta.sender.phone_number` without the `+` (SVC:1336-1337). `sendMessageWithTyping` → `whatsappNumber()` then resolves it (`onWhatsApp` plus a cache that tries **both BR 9-digit variants** and MX/AR prefixes, BAI:3507-3620, BR logic at BAI:3599). If the number doesn't exist, it throws `400 {exists:false}`, which is turned into a **private note** "number not on WhatsApp" (SVC:1280-1292).
- **Filters before sending:**
  - The bot contact `123456`: outgoing messages there are **commands**, never sent to WhatsApp (SVC:1376-1442, 1444).
  - `message_type === 'outgoing'` only. Incoming messages, which the bridge itself created, are ignored.
  - **If `conversation.messages[0].source_id` starts with `WAID:`, it is ignored** (SVC:1445-1447). This is the echo guard for messages the bridge inserted itself (phone-sent or API-sent).
  - `message_type === 'template'` with `message_created` (Chatwoot CSAT survey / template) is sent as **plain text** (SVC:1589-1599). It goes through `textMessage` **without** `isIntegration`, so it gets mirrored back into Chatwoot. That echo is what the `/survey/responses/` inbound filter (SVC:2016) suppresses.
- **Formatting:**
  - Chatwoot markdown is converted to WhatsApp: `*i*`→`_i_`, `**b**`→`*b*`, `~~s~~`→`~s~`, `` `c` `` → ```` ```c``` ```` (SVC:1339-1345).
  - With **signMsg**, the text becomes ``*<sender.available_name>:*`` + delimiter + text, where the delimiter defaults to `\n` (SVC:1454-1465). The sender name is `conversation.messages[0].sender.available_name` or `body.sender.name` (SVC:1347).
  - Typing simulation: a random delay of **500 to 2000 ms** with the `composing` presence (SVC:1506; BAI:2306-2330).
- **Text** (SVC:1502-1541): `textMessage(data, isIntegration=true)` with `quoted` resolved from `content_attributes.in_reply_to`. It looks up the Message row by `chatwootMessageId` and passes `{key, message}` as the Baileys quote (SVC:1679-1700).
- **Attachments** (SVC:1467-1501, `sendAttachment` SVC:1194-1269): for **each** attachment, the bridge sends `attachment.data_url`.
  - The MIME type is guessed from the extension, falling back to a GET for `content-type`.
  - `image` / `video` / `audio` map to their WhatsApp types, everything else to document. `.gif .svg .tiff .tif .dxf .dwg` are sent as **document**.
  - The caption is the signed text, or null if there is no text. It is **repeated on every attachment** in a multi-attachment message.
  - `data_url` is a Chatwoot ActiveStorage URL that must be reachable from Evolution. A wrong `FRONTEND_URL` breaks this (#2194).
- **Audio:** always `audioWhatsapp(..., isIntegration=true)`. It is **transcoded with ffmpeg** to OGG/Opus 48 kHz mono 128k (`-application voip`, metadata stripped), or sent through an external `AUDIO_CONVERTER` API, and then sent as **`ptt: true`** (a voice note) with `mimetype 'audio/ogg; codecs=opus'` and the `recording` presence (BAI:3102-3245). Any audio file from Chatwoot, uploaded MP3s included, becomes a voice note.
- **Persisting the mapping** (`updateChatwootMessageId`, SVC:1609-1642):
  - After the send, it runs a raw `UPDATE "Message" SET chatwootMessageId, chatwootConversationId, chatwootInboxId, chatwootContactInboxSourceId, chatwootIsRead WHERE instanceId AND key->>'id' = <wa id>`.
  - It also rewrites the Chatwoot message's `source_id` to `WAID:<waId>` (with `status=0` and `created_at=NOW()`) directly in Chatwoot's DB, if configured.
  - The mapping table is Evolution's own **`Message`** table (`prisma/postgresql-schema.prisma:157-169`): `key` JSONB plus `chatwootMessageId` int, `chatwootInboxId`, `chatwootConversationId`, `chatwootContactInboxSourceId` varchar and `chatwootIsRead` bool. Inbound messages get the first three filled at insert (BAI:1337-1340).
- **Delete sync** (SVC:1351-1372): for `message_updated` with `deleted`, it finds the Message by `chatwootMessageId`, sends WhatsApp `{delete: key}` (revoke for everyone, which only works for fromMe messages), then **deletes the local row** so later echoes can't find it.
- **Marking read** (SVC:1544-1586, only if `CHATWOOT_MESSAGE_READ=true`): after an agent reply, it marks "the last inbound message" as read in WhatsApp. **Bug:** the query is `findFirst({fromMe:false, instanceId})` with **no `remoteJid` filter and no `orderBy`**. It marks an arbitrary message, not the current chat's latest. This explains "CHATWOOT_MESSAGE_READ=false has no effect" and "messages not marked read" (#1985).
- **Failure feedback:** any send failure posts a **private note** in the conversation, either "🚨 Could not send … {error}" or "number not on WhatsApp" (SVC:1271-1305, i18n `cw.message.*`).

---

## 4. Every loop and duplicate prevention mechanism

1. **Baileys `emitOwnEvents:false`** (BAI:658): API-sent messages, including Chatwoot-originated ones, never come back as `messages.upsert`.
2. **`isIntegration` flag** (BAI:2439-2444, SVC:1237/1262/1514): sends that originate in Chatwoot skip the `SEND_MESSAGE` → Chatwoot mirroring. Every other API send is mirrored, so a mirror exists even for n8n or Typebot sends.
3. **`source_id = 'WAID:<waId>'` on everything the bridge creates** (SVC:2113…2312, IMP:311), together with **webhook guard 1:** an outgoing message whose `conversation.messages[0].source_id` starts with `WAID:` is not sent (SVC:1445). This stops phone-sent and API-sent mirrors from being re-sent.
4. **Webhook guard 2:** only `message_type` outgoing or template is acted on. Incoming messages, which the bridge created, are ignored (SVC:1444, 1589).
5. **Webhook guard 3:** `private` notes, `message_updated` without `deleted`, and payloads without a conversation are ignored (SVC:1328-1334). The bridge's own error notes are private, so they never loop.
6. **Bot-contact guard:** the `123456` conversation is never forwarded to WhatsApp (SVC:1376, 1444).
7. **CSAT echo guard:** inbound text containing `/survey/responses/` is dropped (SVC:2016), because template/CSAT texts are sent non-integration (SVC:1598) and would otherwise mirror back.
8. **Delete loop guard:** in both directions the local Message row is deleted when a delete is processed (SVC:1364-1369, 2337-2345). The opposite event then finds no mapping and stops. The changelog notes "Fix looping when deleting a message in chatwoot".
9. **Pre-upload duplicate check by `source_id`** in Chatwoot's DB, per conversation (SVC:1061-1069, IMP:179-207). It needs the DB URI.
10. **History-import dedupe:** it skips messages already in Evolution's DB (BAI:1000-1035) and those whose `WAID:` already exists in Chatwoot (IMP:256-257).
11. **`source_id` back-fill on agent messages** (IMP:570-576) keeps the lost-message sync from re-importing agent messages as duplicates.
12. **Conversation creation lock, cache and double-check** (SVC:671-724): no duplicate conversations on bursts.
13. **422 fallback on contact create** to search by identifier (SVC:349-357). **BR 9th-digit OR-filter** and optional **merge** (SVC:541-630). The **LID-to-phone identifier upgrade and merge** (SVC:644-666).
14. **Baileys-level dedupe:**
    - `messages.update` keyed on `<instance>_<keyId>_<status>` with the timestamp (BAI:1568-1587).
    - the read-update cache `remoteJid_timestamp_fromMe`.
    - the upsert `type` filter and decrypt-stub skip (BAI:1088-1104, 1166).
    - **Side effect:** issue #2110 reports genuine messages wrongly dropped as "Duplicated ignored".
15. **Connection-notice throttle:** a "connected" message at most every 30 s unless it follows a QR scan (SVC:2464-2489).
16. Ignore `status@broadcast`, `@broadcast` ids, newsletters, `groupsIgnore` and `ignoreJids` (BAI:659-668, 1329; SVC:1966-1999).

---

## 5. Known pain points and bugs (GitHub)

Sources: 510 issues mention "chatwoot". The maintainers consolidate them in **#2014 "[META] Chatwoot integration — tracking umbrella"** and **#1872 "[META] @lid vs @jid"**.

| # | Recurring problem | Root cause (code or issue) | Fix / workaround |
|---|---|---|---|
| 1 | **Duplicate contacts, LID vs phone, "random number" contacts you can't reply to** (#1872, #2071, #2302, #1166, #2003) | `remoteJidAlt` missing or empty; `createContact` puts LID digits into `phone_number`; contacts created earlier with a LID identifier | v2.3.7 added the identifier upgrade and merge pass (SVC:644-666). PR #2718 falls back to the LID when Alt is absent. Community middleware: look up by `identifier=remoteJid`, then by unique pushName among phone-JID contacts, else alert a human (#1872 comment). Upstream says the real fix is Baileys LID→PN mapping. |
| 2 | **Duplicate contacts from the BR 9th digit** (#357, #908) | WhatsApp JID lacks the 9 while the CRM stores it with the 9 | OR-filter on both variants plus `mergeBrazilContacts` (#382). This is the same gotcha as the Notely/Attio note in this vault. |
| 3 | **Duplicate messages / conversations** (#1338, #1040, #908, #762, #720, #75, #165) | Concurrent first messages (fixed with the lock); sync and import re-inserting; webhook retries; Chatwoot webhook timeouts making agents resend | Lock and cache, WAID dedupe, `source_id` back-fill |
| 4 | **"Timed out reading data from server" on agent send, although delivered** (#1887, #1874, #895, #1735, #2299) | Chatwoot's outgoing-webhook timeout is **5 s** (`WEBHOOK_TIMEOUT`). Evolution responds only after the 500 ms sleep, the 0.5-2 s typing delay, the media download and transcode, and the WhatsApp send. Chatwoot then marks the message failed and agents retry, which causes duplicates. | Raise `WEBHOOK_TIMEOUT` to 20-45 s in Chatwoot Super Admin. **For a new bridge: ACK immediately (2xx) and process asynchronously.** |
| 5 | **Audio** | Several separate causes, listed below this table. | See the list below. |
| 6 | **Media dropped intermittently** | Measured in #2512 on v2.3.7: documents 42% missing, stickers 30%, video 19%, images and audio 6%, text 1.1%. Any failure in the download-then-upload path **drops the whole message**: no retry, no placeholder, no error. Outbound "Missing base64 data and mediaUrl" (#2512) is also reported. | Fall back to text with a placeholder, add retries and a dead-letter queue. |
| 7 | **Messages sent from the phone or API don't appear / group messages missing** (#56, #943 changelog, #1811, #1834, #2368, #1742) | Old versions didn't mirror them. Groups only appear after the owner posts. Group contacts are created with `contact_type=0`, which hides them. | Mirror fromMe messages as outgoing with WAID (current behaviour). Some users prefer them as private notes (#2014 feature request). |
| 8 | **Conversations not reopening / reopening when they shouldn't / pending flip-flop** (#2002, #751, #354, #181, #1718) | `reopenConversation` semantics; cache TTL 30 min; cache not cleared on contact deletion or for LID chats; CSAT on resolve creating a new conversation | `/clearcache`, delete the contact and recreate. The `status!=='open'` guard for pending. |
| 9 | **Quote/reply context lost** (#2078, #562, #491, #840, #288) | `prepareMessage` dropped `contextInfo` on text replies (regression in 2.3.3+); the quoted message isn't in the DB | Store the WA↔CW id map for every message in both directions. Send `in_reply_to` and also `in_reply_to_external_id`. |
| 10 | **Formatting artefacts** (#2412, #2415) | Backslash before newline and trailing newlines, caused by Chatwoot's TipTap editor with Ctrl+Enter | Trim trailing whitespace and unescape `\\\n` before sending. Users disable "send with Ctrl+Enter". |
| 11 | **Timestamps shifted -3h** (#1495, #1954) | Direct SQL `created_at=NOW()` in a non-UTC DB session | `ALTER DATABASE … SET timezone TO 'GMT'`. **Use the REST API only.** |
| 12 | **API flood: 40k `contacts/filter`/h** (#1172) | `findContact` runs several times per message (LID pass, participant, main) plus a GET conversation on every cache hit; `contacts.upsert` runs a lookup per synced contact | Cache contact and conversation ids locally (jid → contact_id, contact_id → conversation_id). Don't re-validate on every message. |
| 13 | **Setup:** 401 Unauthorized, can't use an internal Docker hostname for Chatwoot, inbox not created, QR stuck (#2394, #1580, #1709, #545, #1643) | Chatwoot's anti-SSRF rejects webhook URLs that resolve to private IPs; wrong token type | The bridge's webhook URL must be publicly resolvable, or set Chatwoot to allow it. Validate the token with a probe call. |
| 14 | **Unsupported message types silently dropped** | `templateMessage` (#2666), polls, `contactsArrayMessage` edge cases, buttons | Always post *something*, e.g. `[unsupported: <type>]`, instead of dropping. |
| 15 | **Reconnecting an instance stops forwarding until restart** (#2014) | In-memory caches and cron tied to the old socket | The bridge should be stateless with respect to the WhatsApp session (only webhooks in) and expose `clearcache`. |

**Audio problems behind row 5.** The audio player stuck at **00:00** is mostly **on Chatwoot's side**:
- **chatwoot#14644 / #14511.** On 4.13 to 4.18, `message.created` is broadcast over ActionCable **before** the Sidekiq upload to S3 finishes. The first load returns 404 and the player shows `00:00 / 00:00` until refresh. This happens for inbound audio and for agent recordings.
- **chatwoot#13210.** iOS/Safari can't play OGG/Opus `.oga` at all, and Android shows `duration -1`. The open Chatwoot PR #14775 would transcode inbound OGG to MP3. A bridge can work around both by uploading **MP3, or OGG with a correct duration header, and the right content_type**. #14644 also notes attachments registered as `extension mp3` but `content_type audio/opus`.

On Evolution's side the audio issues were separate:
- outbound Chatwoot audio returned "File buffer, URL, or base64 audio is required" in 2.3.5 (#2091, #2117, #2102, fixed in 2.3.6 / PR #2141)
- Cloud API rejected `audio/opus` (#2678)

---

## 6. Lessons for a new bridge: behaviours users migrating from Evolution API + Chatwoot will expect

Ranked by importance. **[v1]** marks a must-have.

1. **[v1] Reliable inbound text to the right contact and conversation, with no duplicates.**
   - Identifier = phone JID.
   - Phone lookup tolerant of the BR 9th digit, with both variants.
   - A local jid → contact_id → conversation_id cache.
   - A per-chat lock or queue so bursts don't create N conversations.
   - `source_id = WAID:<id>`, with a dedupe check before posting.
2. **[v1] Outbound agent replies to WhatsApp:**
   - Consume `message_created` where `message_type == outgoing` and `!private`.
   - Skip messages whose `source_id` starts with `WAID:`.
   - **ACK the webhook immediately and send asynchronously** to avoid the 5 s timeout and the duplicate resends it causes.
   - On failure, post a **private note** ("not sent: …" or "number not on WhatsApp").
3. **[v1] Echo/loop prevention.** Evolution Go may not suppress its own sends the way Baileys `emitOwnEvents:false` does, so verify Evo Go's webhook for API-sent messages. Store every WhatsApp message id the bridge sent and drop the matching `fromMe` webhook events. Never forward private notes.
4. **[v1] Messages typed on the phone or another client mirrored as outgoing**, with the WAID guard. Optionally make them private notes (requested feature).
5. **[v1] LID handling:**
   - Prefer the phone-number JID (`remoteJidAlt` / `SenderAlt` / `senderPn`).
   - Keep a lid ↔ pn map.
   - If only a LID is known, don't put LID digits into `phone_number`. Use identifier = LID and no phone, and upgrade or merge later when the phone number becomes known.
   - Replies must go to whichever JID actually works. On LID-migrated accounts some sends to the phone JID fail silently (#2629, #2588 error 463).
6. **[v1] Media both ways:**
   - Inbound: multipart upload with the original filename and caption. **On download failure, still post the text with a placeholder and log it.** Never drop the whole message.
   - Outbound: download `data_url` server-side (follow redirects; auth may be needed), map the type, send the caption once.
7. **[v1] Audio:**
   - Outbound: convert agent audio to OGG/Opus and send it as a voice note (PTT), as users expect.
   - Inbound: upload in a format Chatwoot clients can play (MP3, or OGG with proper duration) to dodge the iOS and 00:00 problems.
8. **[v1] Conversation lifecycle options:** `reopen_conversation` (one thread per contact vs a new one after resolve), `conversation_pending` (new and reopened conversations go to pending, but never demote an open one), and cache invalidation on `conversation_status_changed` to resolved.
9. **[v1] Groups:** one conversation per group (`<subject> (GROUP)`, identifier = group JID). Show each sender's name and number in a bold prefix. Allow ignoring all groups or specific JIDs (`ignore_jids`).
10. **[v1] Agent signature** `sign_msg` with a configurable delimiter, and markdown conversion both ways (`*`, `_`, `~`, `` ` ``). Trim trailing newlines and stray backslashes.
11. **Quotes/replies both ways**, via the WA↔CW message id map (`in_reply_to` and `in_reply_to_external_id`). This is v1 if possible, since users notice it immediately.
12. **Read receipts:** a WhatsApp READ on an outgoing message triggers `update_last_seen` through the public inbox API. Optionally mark the inbound message read when an agent replies, scoped to **that chat** (Evolution's version is buggy). Delivered status is a bonus that Evolution never had.
13. **Deletes:** a Chatwoot delete revokes the message on WhatsApp, and a WhatsApp revoke deletes it in Chatwoot (opt-in, like `CHATWOOT_MESSAGE_DELETE`). Delete the mapping on the first hop to break the loop.
14. **Reactions:** emoji as a reply to the target message. **Edits:** a new "edited:" message replying to the original.
15. **Contact enrichment:** pushName and avatar on creation, refreshed only when the stored name is the bare number. Never overwrite an agent-edited name with fromMe data.
16. **Rich types rendered as text:** location (with a maps link), vCard, list and buttons, CTWA ads (title, body, URL, thumbnail), polls and templates. Anything else becomes `[unsupported <type>]` rather than a silent drop.
17. **Auto-provision:** create the API inbox with `webhook_url` pointing at the bridge, store the inbox **id** (not the name), and offer an `/status` health endpoint.
    - Evolution's bot contact "123456" (QR in Chatwoot, `/init`, `/status`, `/clearcache`) is **nice-to-have, not v1**. With Evolution Go the pairing happens in Evo Go's manager.
    - If you build it, use a neutral name and avatar.
18. **History import and lost-message reconciliation:** expected by power users. Evolution did this through **direct Chatwoot Postgres SQL**, which caused the timezone bugs and tight coupling. A new bridge should do it through the REST API with rate-limiting, or skip it in v1.
19. **Labels:** Evolution tags each contact with the inbox name, which needs DB access. This is optional.
20. **Security:** authenticate the Chatwoot webhook endpoint (secret path or token, or Chatwoot's webhook signature if available) and the Evo Go webhook. Evolution's endpoint is unauthenticated.

### Things to deliberately *not* copy
- writing directly to Chatwoot's DB
- 1800 s conversation cache that is re-validated with a GET on every message
- one inbox identified by name
- synchronous webhook handling with artificial sleeps
- unscoped `findFirst` for read marking
- reusing the original WAID on edit messages
- dropping a whole message when media fails
- putting LID digits in `phone_number`

### Items that could not be determined from the code alone
- Whether Chatwoot auto-reopens resolved conversations for API-channel incoming messages. Evolution relies on this behaviour, but it was not verified in Chatwoot's source.
- The exact shape of `conversation.messages[0]` in Chatwoot's webhook payload. Evolution assumes it is the just-created message.
- Whether Chatwoot exposes an API to set per-message `delivered` / `failed` status for API channels. Check the Chatwoot version in use.
- Evolution Go's equivalent of `emitOwnEvents`: whether its webhook emits events for messages sent through its own API. This must be tested against the real instance.
