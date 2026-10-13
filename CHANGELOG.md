# Changelog

## 0.1.0 (unreleased)

First version.

- **Dashboard:**
  - first-run setup and onboarding;
  - a three-step connection wizard;
  - instance creation, with pairing by QR code or by code;
  - Overview, Connections, Providers, Events & Logs and Settings pages.
- **Messages in both directions:** text, images, video, audio, documents, captions, locations, contact cards, replies, reactions, edits, deletes, read receipts, and messages sent from the phone.
- **Reliability:** a durable SQLite queue with retries, a dead-letter list and replay, plus de-duplication, echo suppression and in-order processing per chat.
- **Webhook provisioning:** idempotent and resumable. When a webhook was already in use, events are forwarded to the previous one.
- **Connection notices** in Chatwoot, in the account's language.
- **LID contacts:** the name comes from the WhatsApp profile, the photo is added, and the phone number is filled in when WhatsApp reveals it.
- **Security:** Argon2id passwords, CSRF protection, encrypted credentials, SSRF guard and verified webhook signatures.
- **Deployment:** Docker image, Compose files, and guides for EasyPanel, Dokploy and Coolify.
