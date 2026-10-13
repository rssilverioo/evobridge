# Security policy

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through GitHub's **Report a vulnerability** button, under the Security tab of this repository.

Include steps to reproduce and the version affected. You'll get an answer within 7 days.

## How EvoBridge protects your data

- **Admin password:** hashed with Argon2id.
- **Sessions:** random tokens in `HttpOnly`, `SameSite=Lax` cookies. Only a SHA-256 of each token is stored.
- **CSRF:** every state-changing request needs a per-session token.
- **Credentials at rest:** provider keys, instance tokens and webhook secrets are encrypted with AES-256-GCM. The key comes from `ENCRYPTION_KEY`, or is generated into the data volume.
- **The browser** never receives provider credentials.
- **Webhook URLs** carry a 256-bit secret.
- **Chatwoot signatures:** the `X-Chatwoot-Signature` HMAC is verified whenever the inbox exposes a secret.
- **Evolution Go events** must carry the token of the bridged instance.
- **SSRF protection:** outgoing requests refuse private, loopback and link-local addresses at connection time, unless `ALLOW_PRIVATE_NETWORKS=true`. Cloud metadata addresses are always refused.
- **Logs** are redacted. Message content is not logged unless you turn it on.

## Supported versions

Security fixes go to the latest release.
