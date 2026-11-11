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

Already running Nginx or Caddy on the server? See [`proxy/README.md`](proxy/README.md).
The default below runs Caddy inside Docker.

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

## Sign-in pages

People never see Keycloak's own look. `keycloak/themes/maple` restyles the sign-in, registration,
email-verification and password pages to match Maple: same layout, colors, fonts and artwork.
`bootstrap.sh` selects it. Only IT, in the Keycloak admin console, sees stock Keycloak.

- The page titles say "Maple". Set `REALM_DISPLAY_NAME` before `bootstrap.sh` to change the browser
  tab title, e.g. `REALM_DISPLAY_NAME=AshkarAI`.
- After editing the theme, run `docker compose up -d --force-recreate keycloak`. Keycloak caches
  theme files in the container, so a plain restart keeps serving the old ones.
- The "Manage your account" page (password, 2FA, sessions) is Keycloak's separate account app and
  keeps Keycloak's look.

## Sending telemetry

Each org's private ingest key is in **Settings → Ingestion**. Send it as `Authorization: Bearer <key>`
or as an `x-maple-ingest-key: <key>` header. Both OTLP protocols work. Pick the endpoint by where the
app runs:

| App runs… | OTLP/HTTP | OTLP/gRPC |
|---|---|---|
| anywhere else (internet, other servers) | `https://$INGEST_HOST` | `https://$INGEST_HOST:443` |
| on this same server | `http://127.0.0.1:4318` | `http://127.0.0.1:4317` |
| in Docker on this server, joined to the `maple-selfhost_default` network | `http://ingest:3474` | `http://ingest:4317` |
| in Docker on this server, not on that network | `http://host.docker.internal:4318`* | `http://host.docker.internal:4317`* |

\* On Linux add `extra_hosts: ["host.docker.internal:host-gateway"]` to that app's service.

```bash
# OTLP/HTTP (works with every SDK)
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.example.com
export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
export OTEL_EXPORTER_OTLP_HEADERS="authorization=Bearer maple_sk_..."
export OTEL_SERVICE_NAME=my-service

# OTLP/gRPC (the default in several SDKs, e.g. Python and .NET)
export OTEL_EXPORTER_OTLP_ENDPOINT=https://ingest.maple.example.com:443
export OTEL_EXPORTER_OTLP_PROTOCOL=grpc
```

Notes:

- **A brand-new org** accepts data about a minute after it is created. Until then the gateway answers
  `503`, and exporters retry.
- **Unknown keys** get `401`, so the public ingest host is safe.
- **The loopback ports** `4317`/`4318` are bound to `127.0.0.1` only; they are not reachable from
  outside. Change them with `OTLP_HTTP_LOCAL_PORT` / `OTLP_GRPC_LOCAL_PORT`.
- **Testing on `*.localhost`** (a laptop, Caddy's local CA): apps don't trust that certificate. Point
  them at the loopback ports above instead of `https://ingest.localhost`.

Check a path end to end with OpenTelemetry's own generator:

```bash
docker run --rm ghcr.io/open-telemetry/opentelemetry-collector-contrib/telemetrygen:v0.120.0 \
  traces --otlp-http --otlp-endpoint ingest.maple.example.com:443 \
  --otlp-header 'authorization="Bearer maple_sk_..."' --service smoke --traces 3
```

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

## Keycloak's admin account

Keycloak creates its first admin (`KEYCLOAK_ADMIN_USER` / `KEYCLOAK_ADMIN_PASSWORD` in `.env`) as a
**temporary** account. Its admin console shows a yellow banner until you replace it, and Keycloak
documents it as meant for bootstrapping only. Its password also sits in `.env` on the server, readable
by anyone with root there. To replace it:

1. Sign in at `https://$AUTH_HOST/admin` with the `.env` admin.
2. In realm **master** → Users → **Add user**: your own admin, with a password and 2FA. Then
   Role mapping → **admin**.
3. Sign out, sign in as the new admin, and delete the temporary `admin` user.
4. Put the new username and password into `.env` (`KEYCLOAK_ADMIN_USER`, `KEYCLOAK_ADMIN_PASSWORD`).
   `bootstrap.sh` signs in with them when you run it again. Keycloak ignores these values once an
   admin exists.

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

- `ingest: Missing ingest key`, every few seconds while someone has the dashboard open. This is
  the dashboard's own browser telemetry (`maple-web`) with no key. Set `MAPLE_WEB_INGEST_KEY` to an
  org's *public* key (`maple_pk_…`) and run `docker compose build caddy && docker compose up -d caddy`.
  The dashboard's performance then shows up in that org, and the warning stops.

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
