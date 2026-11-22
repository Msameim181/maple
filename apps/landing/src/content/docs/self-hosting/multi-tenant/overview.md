---
title: "Multi-tenant overview"
description: "Run one Maple server for many organizations, with Keycloak sign-in, per-org data isolation and a Docker Compose install."
navLabel: "Overview"
group: "Multi-tenant self-hosting"
order: 1
---

This section covers the **multi-tenant Docker Compose deployment** of Maple. One server runs the whole stack. People sign in through Keycloak, and each department or partner company is an **organization** with its own users, roles, ingest keys and its own ClickHouse database.

It is a different product from [Maple Local and the single-container image](/docs/self-hosting), which has one user and one organization. Pick this section when you need several organizations or real per-person accounts.

## What you get

- One Linux server, `docker compose up -d`.
- Real accounts: per-user passwords, email verification, password reset and 2FA, all in Keycloak.
- Many organizations in one instance. Each has its own data, members, API keys and ingest keys.
- Four roles: `member`, `engineer`, `admin` inside an organization, and `root` for IT staff who run the platform.
- An IT admin page to create, rename and delete organizations.
- OTLP ingest over HTTPS and gRPC, authenticated per organization by ingest key.
- Public status pages and uptime monitors.

## Architecture

Six public hostnames reach the stack through a TLS proxy (bundled Caddy by default). Replace `maple.example.com` with your own domain.

```
                       Internet
                          |
                 ports 80 / 443 (TLS)
                          |
                      [ caddy ]
   +----------+-----------+-----------+-----------+-----------+
   |          |           |           |           |           |
 app.       api.        sync.       auth.      ingest.     status.
 (static    (API,       (live       (sign-in)  (OTLP)      (public
  web app)   :8701)      sync,                              status
                         :8705)                             pages
                                                            :8706)
   |          |           |           |           |           |
 files    [ maple ]----------------+  [keycloak] [ingest]  [ maple ]
 in the    api, ai, alerting,       |      |         |
 caddy     electric-sync, status    |      |         |
 image          |                   |      |         |
                +-------+-----------+------+---------+
                        |
        [postgres]  [electric]  [clickhouse]  [scraper]
```

| Hostname (example) | Served by | What it is |
|---|---|---|
| `maple.example.com` (`APP_HOST`) | `caddy` | The dashboard, as static files |
| `api.maple.example.com` (`API_HOST`) | `maple` (port 8701) | The Maple API |
| `sync.maple.example.com` (`SYNC_HOST`) | `maple` (port 8705) | Live sync of Postgres changes to the dashboard |
| `auth.maple.example.com` (`AUTH_HOST`) | `keycloak` (port 8080) | Sign-in, registration, password reset |
| `ingest.maple.example.com` (`INGEST_HOST`) | `ingest` (ports 3474 HTTP, 4317 gRPC) | OTLP from your apps |
| `status.maple.example.com` (`STATUS_HOST`) | `maple` (port 8706) | Public status pages |

## Services

| Service | Role |
|---|---|
| `caddy` | TLS (Let's Encrypt) for every hostname and the static dashboard |
| `maple` | The api, ai, alerting, electric-sync, chat-bot and status Workers, on alchemy's local runtime (workerd) |
| `ingest` | OTLP/HTTP and gRPC gateway. Resolves each ingest key to its organization and writes to that organization's ClickHouse |
| `keycloak` | Accounts, passwords, email verification, 2FA and SSO federation |
| `postgres` | Maple's control plane and the Keycloak database |
| `electric` | ElectricSQL, live sync of Postgres changes to the dashboard |
| `clickhouse` | Telemetry. One database and one user per organization (`org_<id>`) |
| `scraper` | Runs uptime monitors and Prometheus scrape targets, and reports results to `maple` |

## Who does what

| Role | Where | Can |
|---|---|---|
| IT admin (`root`, Keycloak realm role `maple-root`) | Admin page | Create, rename and delete organizations, name each organization's first admin, see all users, open any organization |
| Org `admin` | Settings, Members | Invite by email, change roles, remove people; manage API keys, ingest keys and AI settings |
| `engineer` | Settings | Manage integrations, alerts, monitors, status pages and ingest setup |
| `member` | Everywhere else | Read telemetry, build dashboards, post incident updates |

The full permission list per role is in [How authentication works](/docs/self-hosting/multi-tenant/how-auth-works#roles).

## Requirements

- A Linux server. We suggest **8 vCPU, 16 GB RAM and 200 GB SSD** for a few dozen organizations.
- Docker 24+ and Docker Compose v2.20+ (v2.24+ if you use the host-proxy override).
- The `maple` container alone holds about **5 GB of RAM**: alchemy's local runtime keeps an incremental build of every Worker in memory. ClickHouse and Keycloak need roughly another 1.5 GB. Below 12 GB the kernel's OOM killer can stop the runtime under load.
- About 8 GB of disk for images.
- Six DNS names pointing at the server, and ports 80 and 443 open.
- An SMTP server for verification, password reset, invitation and alert mail.

## What is not supported in this mode

These are Cloudflare-only or SaaS features with no local equivalent:

- Billing and plans. Everything is unlimited.
- The PR-review sandbox (Cloudflare Containers).
- Workers AI and the AI Gateway. AI features use an OpenRouter key that an organization admin pastes into Settings, AI. The "Maple managed" option does nothing here.
- Public share-link preview images (`/share/*`).
- Integrations that need their own OAuth apps (GitHub, Slack, PlanetScale, Cloudflare). They work only after you register those apps and add their environment variables to the `maple` service.
- High availability. This is one server.
- Clerk. It is the hosted-cloud sign-in and is not used here.

Audit-log and alerting-discovery writes still target a placeholder warehouse. See [Troubleshooting](/docs/self-hosting/multi-tenant/troubleshooting#tinybird-dns-errors-in-the-logs).

## Where to go next

1. [Install](/docs/self-hosting/multi-tenant/install) on a fresh server.
2. [Auth service options](/docs/self-hosting/multi-tenant/auth-options): Keycloak or another OIDC provider.
3. [Configuration reference](/docs/self-hosting/multi-tenant/configuration) for every variable.
4. [How authentication works](/docs/self-hosting/multi-tenant/how-auth-works), [Operations](/docs/self-hosting/multi-tenant/operations), [Data retention](/docs/self-hosting/multi-tenant/data-retention), [Status pages and uptime](/docs/self-hosting/multi-tenant/status-and-uptime), [Security](/docs/self-hosting/multi-tenant/security) and [Troubleshooting](/docs/self-hosting/multi-tenant/troubleshooting).
