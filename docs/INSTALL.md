# Installing EvoBridge

EvoBridge ships as one Docker image, `ghcr.io/rssilverioo/evobridge`. It needs:

- **A volume at `/data`.** It holds the SQLite database and the encryption key.
- **Port `3000`.**

It doesn't need a database server, Redis, or any variable. You enter the provider credentials in the dashboard after installing.

**Before you start**

- **Evolution Go** must be reachable from EvoBridge, and you need its `GLOBAL_API_KEY`. The server must be activated in its Manager (`/manager/login`); until then, Evolution Go answers 503 to everything.
- **Chatwoot** must be reachable from EvoBridge, and you need the access token of a user with the **Administrator** role.
- **Both** must be able to reach EvoBridge's public address, because that's where they send webhooks. A domain with HTTPS is the simplest way.

**After any install**, open the address, create the administrator, then follow the onboarding (Evolution Go, then Chatwoot) and create your first connection.

- [EasyPanel](#easypanel)
- [Dokploy](#dokploy)
- [Coolify](#coolify)
- [Docker Compose on a VPS](#docker-compose-on-a-vps)
- [Networking notes](#networking-notes)
- [Updating, backups and moving servers](#updating-backups-and-moving-servers)

## EasyPanel

1. **Create the app.** Open a project, click **+ Service**, then choose **App**, and name it `evobridge`.
2. **Set the source.** Go to **Source**, choose **Docker Image**, enter `ghcr.io/rssilverioo/evobridge:latest`, and click **Save**.
3. **Add storage.** Go to **Mounts**, click **Add Volume**, use the name `data` and the mount path `/data`.
4. **Add a domain.** Go to **Domains** and add your domain, for example `bridge.example.com`, with **port 3000**. EasyPanel issues the HTTPS certificate.
5. **Deploy.** Click **Deploy** and open the domain.

> **Same server as Evolution Go and Chatwoot?** You can type their internal service addresses in the dashboard (for example `http://evolution-go:8080`), but they are private IPs. Set the environment variable `ALLOW_PRIVATE_NETWORKS=true`.
> Using their public domains works without that.

## Dokploy

1. **Create the app.** Open a project, click **Create Service**, then choose **Application**.
2. **Set the provider.** Go to **Provider**, choose **Docker**, enter the image `ghcr.io/rssilverioo/evobridge:latest`, and click **Save**.
3. **Add storage.** Go to **Advanced**, then **Volumes / Mounts**, and add a **Volume Mount** named `evobridge-data` with mount path `/data`.
4. **Add a domain.** Go to **Domains** and add your domain with **container port 3000**. Enable HTTPS with Let's Encrypt.
5. **Deploy** and open the domain.

You can also use **Create Service → Compose**, paste [`docker-compose.yml`](../docker-compose.yml), and add the domain on the `evobridge` service, port 3000.

## Coolify

1. **Create the resource.** Open a project, click **+ New**, choose **Docker Compose Empty**, and paste [`deploy/coolify.yml`](../deploy/coolify.yml).
2. **Deploy.** Coolify generates a domain, routes it to port 3000 and sets `PUBLIC_URL` from it. To use your own domain, edit the **Domains** of the `evobridge` service.
3. **Open the domain.**

You can also use **+ New → Docker Image** with `ghcr.io/rssilverioo/evobridge:latest`, exposed port `3000`, and a persistent storage mount at `/data`.

## Docker Compose on a VPS

```bash
mkdir evobridge && cd evobridge
curl -fsSLO https://raw.githubusercontent.com/rssilverioo/evobridge/main/docker-compose.yml
docker compose up -d
```

Open `http://<server-ip>:3000`.

For production, put it behind HTTPS. Point a DNS record to the server, then:

```bash
curl -fsSLO https://raw.githubusercontent.com/rssilverioo/evobridge/main/deploy/docker-compose.caddy.yml
DOMAIN=bridge.example.com docker compose -f docker-compose.caddy.yml up -d
```

Caddy gets and renews the certificate on its own.

## Networking notes

- **Public URL.** Evolution Go and Chatwoot call `<public URL>/hooks/...`.
  - When you open the dashboard on your domain, EvoBridge suggests that domain as the public URL.
  - To pin it, set `PUBLIC_URL=https://bridge.example.com`.
  - If you change it later, use **Reconfigure webhooks** on each connection.
- **Private networks.** By default, EvoBridge refuses provider URLs that resolve to private or local addresses, as protection against SSRF.
  - Set `ALLOW_PRIVATE_NETWORKS=true` when Evolution Go or Chatwoot sit on the same private network.
  - Cloud metadata addresses stay blocked either way.
- **Chatwoot 4.14 and newer** only delivers webhooks to private addresses when `SAFE_FETCH_ALLOW_PRIVATE_NETWORK=true` is set on its `rails` and `sidekiq` containers. With a public domain for EvoBridge, you don't need it.
- **Reverse proxies.** EvoBridge trusts `X-Forwarded-*` headers from private and loopback addresses, which is what EasyPanel, Dokploy, Coolify and Caddy use. Override this with `TRUST_PROXY`.

## Updating, backups and moving servers

- **Update.** Pull the new image and restart: `docker compose pull && docker compose up -d`, or **Deploy** in your panel. Migrations run on start.
- **Back up.** Back up the `/data` volume. It holds:
  - `evobridge.db`, plus its `-wal` file;
  - `encryption.key`. **Without this file, the stored credentials can't be decrypted.**
- **Move servers.** Copy the volume. If you prefer to keep the key outside the volume, set `ENCRYPTION_KEY` (64 hex characters) before the first start.

## Environment variables

All of them are optional.

| Variable | Default | Purpose |
|---|---|---|
| `PUBLIC_URL` | (from the dashboard) | Address providers use to reach EvoBridge |
| `ALLOW_PRIVATE_NETWORKS` | `false` | Allow provider URLs on private networks |
| `ENCRYPTION_KEY` | generated in `/data` | 32-byte key, as 64 hex characters, for credentials at rest |
| `PORT` | `3000` | HTTP port |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` or `error` |
| `TRUST_PROXY` | `loopback,linklocal,uniquelocal` | Which proxies' `X-Forwarded-*` headers to trust |
| `WORKER_CONCURRENCY` | `4` | Events processed in parallel (one at a time per chat) |
