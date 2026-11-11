# Self-hosted, multi-tenant Maple (Docker Compose)

One server runs the whole stack. People sign in through Keycloak; each department or partner
company is an **organization** with its own users, roles, ingest keys and its own ClickHouse
database. Design: [`docs/superpowers/specs/2026-11-11-selfhost-multitenant-design.md`](../../docs/superpowers/specs/2026-11-11-selfhost-multitenant-design.md).

| Service | Role |
|---|---|
| `caddy` | TLS (Let's Encrypt) for every hostname; serves the dashboard |
| `maple` | api, ai, alerting, electric-sync, chat-bot, status Workers on alchemy's local runtime (workerd) |
| `ingest` | OTLP/HTTP gateway; resolves each ingest key to its org |
| `keycloak` | accounts, passwords, email verification, 2FA, SSO federation |
| `postgres` | Maple control plane + Keycloak database |
| `electric` | live sync of Postgres changes to the dashboard |
| `clickhouse` | telemetry; one database + user per org (`org_<id>`) |

## Requirements

- Linux, 8 vCPU / 16 GB RAM / 200 GB SSD for a few dozen orgs. Docker 24+, Compose v2.20+.
  The `maple` container alone holds about 5 GB of RAM: alchemy's local runtime keeps an incremental
  build of every Worker in memory. ClickHouse and Keycloak need another 1.5 GB. Below 12 GB the
  kernel's OOM killer stops the runtime under load. Images need about 8 GB of disk.
- Five DNS names pointing at the server (app, api, sync, auth, ingest). Ports 80 and 443 open.
- An SMTP server for verification, password reset, invitation and alert mail.

## Install

```bash
git clone -b selfhost https://github.com/Msameim181/maple && cd maple/deploy/docker
./scripts/gen-secrets.sh            # creates .env with every secret
nano .env                           # set the 5 hostnames, ACME_EMAIL, SMTP_URL, EMAIL_FROM
docker compose build                # ~15-25 min the first time (Rust ingest + bun monorepo)
docker compose up -d
./scripts/bootstrap.sh it-admin@yourco.fi ashkar-fi "Ashkar Finland" lead@yourco.fi
```

`bootstrap.sh` creates the Keycloak realm, the `maple-web` client, the `maple-root` role and SMTP
settings. It also creates the first IT admin, printing a temporary password, and optionally the
first organization. It is safe to run again. Then open `https://<APP_HOST>`, choose **Sign in with
SSO**, and sign in as the IT admin.

Check everything end to end. The script creates two throwaway orgs, ingests one span into each,
proves neither can see the other, and proves delete + re-create starts empty:

```bash
./scripts/smoke-test.sh
```

## Who does what

| Role | Where | Can |
|---|---|---|
| IT admin (Keycloak realm role `maple-root`) | **Admin** page | create / rename / delete orgs, name each org's first admin, see all users, open any org |
| Org admin (`Admin` in an org) | **Settings → Members** | invite by email, change roles (Member, Engineer, Admin), remove people |
| | **Settings → AI** | choose **Your OpenRouter key**, paste the org's key, and turn auto-triage and investigations on or off. "Maple managed" needs Maple's cloud and does nothing here. |
| | **Settings → Ingest keys** | roll the org's ingest keys |
| Everyone | **Manage your account** | password, 2FA, sessions (Keycloak account console) |

How invitations work:

1. An org admin invites `person@partner.com`.
2. The person registers at the sign-in page with that email and verifies it.
3. On first sign-in they land in the org. Only verified emails can accept an invitation.
4. Someone in several orgs switches between them with the org switcher.

Partners' identity providers (Entra ID, Google, LDAP) can be added in the Keycloak admin
console (`https://<AUTH_HOST>/admin`, user `admin`, password in `.env`). Enforce 2FA for admins
there under *Authentication → Required actions*.

## Sending telemetry

Each org's ingest key is in **Settings → Ingest keys**. Point any OpenTelemetry SDK at the ingest
host:

```bash
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.example.com
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_HEADERS="x-maple-ingest-key=maple_sk_..."
export OTEL_SERVICE_NAME=my-service
```

Requests without a valid key are rejected, so the ingest host can be public.

## Operations

- **Logs:** `docker compose logs -f maple ingest`
- **Deleting an org** is permanent. It drops the org's ClickHouse database and user and all of its
  Postgres rows. The id can then be used again by a new, empty org.
- **Backups** need Postgres (`pg_dump`), the `clickhouse-data` and `maple-state` volumes, and `.env`.
  Without the two `MAPLE_INGEST_KEY_*` values, encrypted secrets in Postgres are unreadable.

  ```bash
  docker compose exec -T postgres pg_dumpall -U maple | gzip > backup-$(date +%F).sql.gz
  ```
- **Upgrading to newer Maple:**

  ```bash
  git fetch upstream && git merge upstream/main
  docker compose build && docker compose up -d && ./scripts/smoke-test.sh
  ```

  Migrations apply on boot. Per-org ClickHouse schema updates are applied from
  *Settings → Data platform* in each org.
- **Moving an org to its own server later:** deploy this same stack there and copy the org's
  Postgres rows and its `org_<id>` ClickHouse database. The org id, users (Keycloak `sub`) and
  keys stay the same.

## Security notes

- `MAPLE_ROOT_PASSWORD` is **break-glass access for IT**. Signing in with it on the sign-in page
  ("Use root password") gives admin over every organization. Keep `.env` readable by root only
  (`gen-secrets.sh` sets `chmod 600`). Rotating the value signs everyone out.
- Org admins manage members, keys and AI for their own org. Only IT (`maple-root`) can change
  where an org's telemetry is stored.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `502` from the API host | The runtime was stopped, usually by the OOM killer (`dmesg \| grep -i "killed process"`). Run `docker compose restart maple` and give the host more RAM. |
| A new org shows no data and *Settings → Data platform* reports a failed apply | The schema apply was interrupted by a restart. Press **Apply** there, as an org admin or IT. |
| Spans sent right after creating an org get `503` | The org's ingest route turns ready about a minute after its schema is applied. OTLP exporters retry by themselves. |
| No emails | Check `SMTP_URL`, then `docker compose logs maple \| grep mail-bridge`. |

## Known log noise

- `alerting: errorActiveOrgsDiscovery failed … Tinybird HTTP transport failed`. Error-issue
  discovery first scans a shared warehouse this deployment doesn't have. It then falls back to
  the orgs with their own ClickHouse, which is every org here, so nothing is missed.
- `Alerting colo lookup failed`: a Cloudflare-edge lookup with no meaning off Cloudflare.

## Not available in this deployment

- Billing and plans: everything is unlimited.
- The PR-review sandbox (Cloudflare Containers).
- Public share-link previews (`/share/*` images).
- Integrations that need their own OAuth apps (GitHub, Slack, PlanetScale, Cloudflare) work only
  after you register those apps and add their env vars to the `maple` service.
