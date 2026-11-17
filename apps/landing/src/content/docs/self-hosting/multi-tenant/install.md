---
title: "Install"
description: "Step-by-step install of multi-tenant Maple on a fresh Linux server: DNS, firewall, Docker, secrets, bootstrap, first organization and first telemetry."
group: "Multi-tenant self-hosting"
order: 3
---

This guide takes a fresh Linux VPS to a working multi-tenant Maple. Use your own domain wherever you see `maple.example.com`.

Time: about 30 minutes of work, plus 15 to 25 minutes for the first image build.

## 1. Before you start

- A Linux server with 8 vCPU, 16 GB RAM and 200 GB disk (see [requirements](/docs/self-hosting/multi-tenant/overview#requirements)).
- A domain you control and an SMTP account for outgoing mail.
- Root or sudo access to the server.

## 2. DNS records

Create six `A` records (and `AAAA` if you use IPv6) that all point at the server's public IP. Do this first: Caddy requests certificates on first start and fails if DNS is not ready.

| Name | Variable | Used for |
|---|---|---|
| `maple.example.com` | `APP_HOST` | Dashboard |
| `api.maple.example.com` | `API_HOST` | API |
| `sync.maple.example.com` | `SYNC_HOST` | Live sync |
| `auth.maple.example.com` | `AUTH_HOST` | Keycloak sign-in |
| `ingest.maple.example.com` | `INGEST_HOST` | OTLP from your apps |
| `status.maple.example.com` | `STATUS_HOST` | Public status pages |

Check them:

```bash
for h in maple api.maple sync.maple auth.maple ingest.maple status.maple; do
  dig +short $h.example.com
done
```

## 3. Firewall

Open only SSH, 80 and 443. Port 80 is needed for the Let's Encrypt challenge. With `ufw`:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Docker publishes ports itself and can bypass `ufw` rules. The stack only publishes 80 and 443 publicly. The OTLP ports 4317 and 4318 are bound to `127.0.0.1` only.

## 4. Install Docker

```bash
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER"
newgrp docker
docker --version && docker compose version
```

You need Docker 24+ and Compose v2.20+.

## 5. Get the code

```bash
git clone -b selfhost https://github.com/Msameim181/maple
cd maple/deploy/docker
```

Everything below runs from `maple/deploy/docker`.

## 6. Create `.env`

```bash
cp .env.example .env
./scripts/gen-secrets.sh
```

`gen-secrets.sh` fills every empty secret in `.env` with a random value and sets file mode 600. Keep `.env` private and back it up. **Never change `MAPLE_INGEST_KEY_ENCRYPTION_KEY` or `MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY` after the first start**: stored encrypted secrets and every ingest key become unreadable.

Now edit the non-secret values:

```bash
nano .env
```

Set at least:

```bash
APP_HOST=maple.example.com
API_HOST=api.maple.example.com
SYNC_HOST=sync.maple.example.com
AUTH_HOST=auth.maple.example.com
INGEST_HOST=ingest.maple.example.com
STATUS_HOST=status.maple.example.com
ACME_EMAIL=it@example.com
SMTP_URL=smtps://user:password@smtp.example.com:465
EMAIL_FROM=Maple <maple@example.com>
```

`SMTP_URL` is `smtps://user:pass@host:465` (TLS) or `smtp://user:pass@host:587` (STARTTLS). URL-encode special characters in the password. Without it, no email is sent: no verification mail, no invitations. Every variable is described in the [configuration reference](/docs/self-hosting/multi-tenant/configuration).

## 7. Build and start

```bash
docker compose build
docker compose up -d
```

The first build takes 15 to 25 minutes (Rust ingest gateway and the bun monorepo). Then wait for health:

```bash
docker compose ps
curl -s https://auth.maple.example.com/realms/master | head -c 60
```

Keycloak takes about a minute to be ready. The `maple` container takes several minutes on first boot: it runs database migrations and starts the Workers. Check its logs if the API is not ready:

```bash
docker compose logs -f maple
curl -s https://api.maple.example.com/health
```

`/health` answers `OK` when the API is up.

## 8. Bootstrap Keycloak and the first organization

```bash
./scripts/bootstrap.sh it-admin@example.com acme-main "Acme Main" lead@example.com
```

Arguments: the IT admin's email, then optionally the first organization's id (a permanent slug), its display name, and the email of its first admin. `bootstrap.sh`:

1. Creates the `maple` realm, the `maple-web` client, the `maple-root` role and SMTP settings.
2. Creates the IT admin and **prints a temporary password**. Copy it.
3. Creates the organization and invites the first org admin by email.

It is safe to run again. If you run it with only the first argument, it skips the organization.

## 9. First sign-in

1. Open `https://maple.example.com` and choose **Sign in with SSO**.
2. Sign in as the IT admin with the temporary password. Keycloak makes you set a new one.
3. After sign-in you land in the dashboard. IT admins also see the **Admin** page.

## 10. Create an organization

If you skipped it in the bootstrap step: open **Admin**, choose to create an organization, set a slug id (for example `partner-om`) and a name, and name the first admin's email. The new organization accepts telemetry about a minute after it is created, once its ClickHouse schema is applied.

## 11. Invite a member

Sign in as the organization's admin and open **Settings, Members**. Invite `person@partner.com` with a role (`member`, `engineer` or `admin`). The person registers on the sign-in page with that email, verifies it, and on first sign-in lands in the organization. Only verified emails can accept an invitation.

## 12. Send the first telemetry

Open **Settings, Ingestion** in the organization and copy its private ingest key (`maple_sk_...`). Then:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.example.com
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer maple_sk_..."
export OTEL_SERVICE_NAME=my-service
```

For a quick test without an SDK, use OpenTelemetry's generator:

```bash
docker run --rm ghcr.io/open-telemetry/opentelemetry-collector-contrib/telemetrygen:v0.120.0 \
  traces --otlp-http --otlp-endpoint ingest.maple.example.com:443 \
  --otlp-header 'authorization="Bearer maple_sk_..."' --service smoke --traces 3
```

Pick the endpoint by where the app runs:

| App runs... | OTLP/HTTP | OTLP/gRPC |
|---|---|---|
| anywhere else | `https://ingest.maple.example.com` | `https://ingest.maple.example.com:443` |
| on this same server | `http://127.0.0.1:4318` | `http://127.0.0.1:4317` |
| in Docker on this server, on the `maple-selfhost_default` network | `http://ingest:3474` | `http://ingest:4317` |

A new organization answers `503` for about a minute (exporters retry). Unknown keys get `401`. The traces appear under **Traces** in the dashboard.

## 13. Status page and uptime monitor

1. Open **Status pages**, create a page and publish it. Its public link is `https://status.maple.example.com/s/<slug>`.
2. Open **Uptime**, add a monitor for a public HTTPS URL. It starts as `pending` and goes `up` after the scraper's first check.

How this works, and why internal targets stay pending, is in [Status pages and uptime](/docs/self-hosting/multi-tenant/status-and-uptime).

## 14. Verify checklist

- [ ] All six hostnames resolve and serve valid certificates.
- [ ] `curl -s https://api.maple.example.com/health` prints `OK`.
- [ ] Sign-in works as the IT admin, and sign-out then **Sign in with SSO** asks for the password again.
- [ ] The organization's admin received the invitation email.
- [ ] A trace sent with the org's key shows up in that org only.
- [ ] `https://api.maple.example.com/api/internal/uptime-targets` answers 404 (internal endpoints are not public).
- [ ] The Keycloak `/admin` path answers 404 on `auth.maple.example.com`.
- [ ] A published status page opens on the status host, and a new monitor leaves `pending`.

For an automated check, run `./scripts/smoke-test.sh`. It creates two throwaway organizations, ingests one span into each, proves neither can see the other, and proves delete and re-create starts empty.

## Variant: behind an existing Nginx or Caddy

If the server already runs Nginx or Caddy as a system service, use the host-proxy override so the stack publishes nothing publicly. Requires Compose v2.24+.

```bash
docker compose -f docker-compose.yml -f docker-compose.host-proxy.yml up -d
```

The stack then listens on loopback only, and your proxy forwards each hostname:

| Hostname | Loopback upstream |
|---|---|
| `APP_HOST` | `127.0.0.1:8780` (static dashboard) |
| `API_HOST` | `127.0.0.1:8701` |
| `SYNC_HOST` | `127.0.0.1:8705` (long polls: no buffering, 300 s timeout) |
| `AUTH_HOST` | `127.0.0.1:8080` (needs `X-Forwarded-*` headers) |
| `INGEST_HOST` | `127.0.0.1:3474` (HTTP) and `127.0.0.1:4317` (gRPC); bodies up to 20 MB |
| `STATUS_HOST` | `127.0.0.1:8706` |

Change a port with `WEB_PORT`, `API_PORT`, `SYNC_PORT`, `AUTH_PORT` or `INGEST_PORT` in `.env`. For host Caddy, copy `proxy/caddy/Caddyfile.host`, replace the example names and install it. For host Nginx, issue one certificate with certbot and render `proxy/nginx/maple.conf.template` with `envsubst`. Full steps are in `deploy/docker/proxy/README.md` in the repository. Block the paths listed in [Security](/docs/self-hosting/multi-tenant/security#what-is-exposed) in your own proxy too.

## Variant: test on one machine (`*.localhost`)

On a laptop, set every host to a `*.localhost` name (for example `APP_HOST=app.localhost`, `API_HOST=api.localhost`) and run the same steps. Caddy then uses its own local CA, so:

- Pass `CURL_OPTS=-k` to `bootstrap.sh` and `smoke-test.sh`.
- Your apps will not trust the certificate, so send telemetry to the loopback ports (`http://127.0.0.1:4318`) instead of `https://ingest.localhost`.
- Email will not work unless you set `SMTP_URL`.
