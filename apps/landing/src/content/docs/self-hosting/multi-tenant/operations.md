---
title: "Operations"
description: "Back up, upgrade, roll back, rotate secrets, read logs and check health of a multi-tenant Maple stack."
group: "Multi-tenant self-hosting"
order: 6
---

All commands run from `maple/deploy/docker` on the server.

## Health and logs

```bash
docker compose ps                         # every service should be running / healthy
curl -s https://api.maple.example.com/health               # OK
curl -s https://auth.maple.example.com/realms/maple | head -c 80   # {"realm":"maple",...
docker compose logs -f maple ingest       # follow the API runtime and the OTLP gateway
docker compose logs --since 1h keycloak scraper
```

If the API host answers `502`, the `maple` runtime was probably stopped by the out-of-memory killer. Check with `dmesg | grep -i "killed process"`, then `docker compose restart maple` and give the host more RAM.

## What to back up

| What | Why | How |
|---|---|---|
| Postgres (Maple control plane **and** the Keycloak database) | Organizations, members, keys, sessions, users | `pg_dumpall` |
| `clickhouse-data` volume | All telemetry | Stop ClickHouse or snapshot the volume |
| `maple-state` volume | The runtime's local state (queues, KV, R2, Workflow state) | Volume copy |
| `ingest-wal` volume | Telemetry accepted but not yet written | Volume copy |
| `.env` | Secrets | Copy to a safe place |

Without the two `MAPLE_INGEST_KEY_*` values from `.env`, encrypted secrets in Postgres are unreadable, so a database backup without `.env` is not enough.

```bash
# Postgres: logical dump of everything (both databases and the roles)
docker compose exec -T postgres pg_dumpall -U maple | gzip > backup-$(date +%F).sql.gz

# A volume: archive it while its service is stopped
docker compose stop clickhouse
docker run --rm -v maple-selfhost_clickhouse-data:/v -v "$PWD":/b alpine \
  tar czf /b/clickhouse-$(date +%F).tgz -C /v .
docker compose start clickhouse
```

The volume prefix is the compose project name (`maple-selfhost`). Check with `docker volume ls`. To restore a dump into an empty Postgres: `gunzip -c backup.sql.gz | docker compose exec -T postgres psql -U maple -d postgres`.

## Upgrade

```bash
cp .env ~/maple-env-$(date +%F) && chmod 600 ~/maple-env-$(date +%F)
docker compose exec -T postgres pg_dumpall -U maple | gzip > pre-upgrade-$(date +%F).sql.gz
git fetch origin && git merge origin/selfhost     # or: git pull
./scripts/gen-secrets.sh                   # adds any newly required secrets
docker compose build
docker compose up -d
./scripts/bootstrap.sh it-admin@example.com   # re-applies Keycloak settings, safe to repeat
./scripts/smoke-test.sh
```

- Database migrations run when the `maple` container starts.
- Per-organization ClickHouse schema updates are applied from **Settings, Data platform** in each organization.
- Build while the old stack keeps running; downtime is roughly the `maple` restart. After an upgrade that changes the session system, every SSO user signs in once more.
- Merging newer upstream Maple: `git fetch upstream && git merge upstream/main`, then the same build and `up -d`.

### Upgrading to the 0.4.0 base

Checked on a copy of a running stack with data: all new database migrations applied and no rows were lost. Before you upgrade:

- **Root password.** The API refuses to start with `MAPLE_ROOT_PASSWORD` shorter than 16 characters or a known placeholder (`change-me`, `password`, `admin`, ...). Check yours: `grep -c '^MAPLE_ROOT_PASSWORD=.\{16,\}' .env` should print `1`. Generated passwords are 64 characters and pass.
- **New secret.** Run `scripts/gen-secrets.sh`: it appends `MAPLE_SESSION_SIGNING_SECRET` (it replaces the older `MAPLE_SESSION_SECRET`, which you can delete from `.env`). Session tokens are signed from a new derived key, so **everyone signs in once more**.
- **Rebuild the images.** The `maple` container now starts alchemy under Bun (the status Worker imports font files that Node cannot load), so a stale image fails to start with `Unknown file extension ".ttf"`. Rebuild with `docker compose build maple caddy scraper`.
- **Disk.** A rebuild needs roughly 10 GB free for Docker (`docker system df`). If it fills, `docker builder prune -af` only removes build cache.

## Roll back

1. `git checkout <previous commit>` and `docker compose build && docker compose up -d`.
2. Tables added by a newer version are harmless to an older one.
3. Settings that `bootstrap.sh` changed in Keycloak (themes, client URLs, default roles) are not reverted by a rebuild. Revert them in Keycloak by hand if needed.
4. If data is damaged, restore the `pg_dumpall` dump taken before the upgrade.

## Rotating secrets

| Secret | Effect and procedure |
|---|---|
| `MAPLE_INGEST_KEY_ENCRYPTION_KEY`, `MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY` | **Do not change.** Encrypted secrets and every ingest key stop working |
| `MAPLE_ROOT_PASSWORD` | Edit `.env`, `docker compose up -d maple`. Root sessions end. The session key is salted with the root password, so **all** users are signed out |
| `MAPLE_SESSION_SIGNING_SECRET` | Edit `.env`, `docker compose up -d maple`. All Maple sessions end; everyone signs in again |
| `SD_INTERNAL_TOKEN` | Must match in `maple` and `scraper`: `docker compose up -d maple scraper` |
| `ELECTRIC_SECRET` | Must match in `electric` and `maple`: `docker compose up -d electric maple` |
| `INTERNAL_SERVICE_TOKEN`, `SANDBOX_INTERNAL_SERVICE_TOKEN`, `MAPLE_SHARE_TOKEN_HMAC_KEY` | Edit `.env`, `docker compose up -d maple`. Existing share links stop working when the HMAC key changes |
| `MAPLE_OIDC_ADMIN_CLIENT_SECRET` | Change the client secret in Keycloak (client `maple-admin`, Credentials) and `.env` together, then `docker compose up -d maple` |
| `KEYCLOAK_ADMIN_PASSWORD` | See the Keycloak admin account steps below |
| `POSTGRES_PASSWORD`, `CLICKHOUSE_ADMIN_PASSWORD` | The value is also stored inside the databases once they exist, so editing `.env` alone breaks the stack. Change the password in the database (`ALTER USER`) first, then `.env`, then recreate dependent services. Not tested here |

Rotate an organization's ingest keys from **Settings, Ingestion** (admins).

## Disk full

If the ClickHouse disk fills up, run `scripts/retention-emergency.sh status`, then `truncate-system-logs` and `free --target-free-percent 15` from `deploy/docker`. It works with the rest of the stack down. The commands, safety checks and the full-disk fallback are in [Data retention](/docs/self-hosting/multi-tenant/data-retention#disk-full-emergency). Setting `MAPLE_CLICKHOUSE_MIN_FREE_PERCENT` makes the hourly sweep do the same automatically.

## Keycloak admin account

The first admin (`KEYCLOAK_ADMIN_USER` / `KEYCLOAK_ADMIN_PASSWORD`) is a **temporary** account, meant for bootstrapping. Its password also sits in `.env`. Replace it:

1. Reach the admin console (see [Troubleshooting](/docs/self-hosting/multi-tenant/troubleshooting#keycloak-admin-404-behind-caddy)) and sign in with the `.env` admin.
2. In realm **master**, Users, **Add user**: your own admin with a password and 2FA, then Role mapping, **admin**.
3. Sign in as the new admin and delete the temporary `admin` user.
4. Put the new username and password into `.env`. `bootstrap.sh` signs in with them when you run it again.

## Deleting and moving organizations

- Deleting an organization is **permanent**. It drops the org's ClickHouse database and user and all its Postgres rows. The id can then be used by a new, empty organization.
- To move an organization to its own server later, deploy the same stack there and copy the org's Postgres rows and its `org_<id>` ClickHouse database. The org id, users (Keycloak `sub`) and keys stay the same.
