# Self-hosted, multi-tenant Maple (Docker Compose)

One server runs the whole stack. People sign in through Keycloak; each department or partner
company is an **organization** with its own users, roles, ingest keys and its own ClickHouse
database. The full documentation lives in one place, the Maple docs Markdown, and the whole Maple
docs site is also published on GitHub Pages for this fork:
<https://msameim181.github.io/maple/docs/self-hosting/multi-tenant/overview/>.

## Quick start

Needs a Linux server (8 vCPU / 16 GB RAM suggested), Docker 24+ with Compose v2.20+, six DNS names
pointing at it (app, api, sync, auth, ingest, status), ports 80 and 443 open, and an SMTP account.

```bash
git clone -b selfhost https://github.com/Msameim181/maple && cd maple/deploy/docker
cp .env.example .env
./scripts/gen-secrets.sh            # fills every empty secret in .env
nano .env                           # set the 6 hostnames, ACME_EMAIL, SMTP_URL, EMAIL_FROM
docker compose build                # ~15-25 min the first time
docker compose up -d
./scripts/bootstrap.sh it-admin@example.com acme-main "Acme Main" lead@example.com
```

`bootstrap.sh` prints the IT admin's temporary password. Then open `https://<APP_HOST>`, choose
**Sign in with SSO** and sign in. Check the whole stack with `./scripts/smoke-test.sh`.

Already running Nginx or Caddy on the server? Start with
`docker compose -f docker-compose.yml -f docker-compose.host-proxy.yml up -d` and see
[`proxy/README.md`](proxy/README.md).

## Documentation

The pages are plain Markdown in
[`apps/landing/src/content/docs/self-hosting/multi-tenant/`](../../apps/landing/src/content/docs/self-hosting/multi-tenant/).
They appear on the Maple docs site under **Multi-tenant self-hosting**, and on GitHub Pages.

| Page | Site path | In this repository |
|---|---|---|
| Overview: architecture, requirements, limits | `/docs/self-hosting/multi-tenant/overview` | [overview.md](../../apps/landing/src/content/docs/self-hosting/multi-tenant/overview.md) |
| Auth service options: Keycloak, other OIDC, break-glass | `/docs/self-hosting/multi-tenant/auth-options` | [auth-options.md](../../apps/landing/src/content/docs/self-hosting/multi-tenant/auth-options.md) |
| Install, step by step | `/docs/self-hosting/multi-tenant/install` | [install.md](../../apps/landing/src/content/docs/self-hosting/multi-tenant/install.md) |
| Configuration reference | `/docs/self-hosting/multi-tenant/configuration` | [configuration.md](../../apps/landing/src/content/docs/self-hosting/multi-tenant/configuration.md) |
| How authentication works | `/docs/self-hosting/multi-tenant/how-auth-works` | [how-auth-works.md](../../apps/landing/src/content/docs/self-hosting/multi-tenant/how-auth-works.md) |
| Operations: backup, upgrade, rollback, rotation | `/docs/self-hosting/multi-tenant/operations` | [operations.md](../../apps/landing/src/content/docs/self-hosting/multi-tenant/operations.md) |
| Data retention and the disk-full emergency script | `/docs/self-hosting/multi-tenant/data-retention` | [data-retention.md](../../apps/landing/src/content/docs/self-hosting/multi-tenant/data-retention.md) |
| Status pages and uptime | `/docs/self-hosting/multi-tenant/status-and-uptime` | [status-and-uptime.md](../../apps/landing/src/content/docs/self-hosting/multi-tenant/status-and-uptime.md) |
| Security | `/docs/self-hosting/multi-tenant/security` | [security.md](../../apps/landing/src/content/docs/self-hosting/multi-tenant/security.md) |
| Troubleshooting | `/docs/self-hosting/multi-tenant/troubleshooting` | [troubleshooting.md](../../apps/landing/src/content/docs/self-hosting/multi-tenant/troubleshooting.md) |

Build the Pages copy locally with
`cd apps/landing && ASTRO_SITE=https://<owner>.github.io ASTRO_BASE=/<repo> bun --bun run build && node scripts/pages-base.mjs dist /<repo>`
(output in `apps/landing/dist`). Design notes:
[`docs/superpowers/specs/2026-11-11-selfhost-multitenant-design.md`](../../docs/superpowers/specs/2026-11-11-selfhost-multitenant-design.md).
