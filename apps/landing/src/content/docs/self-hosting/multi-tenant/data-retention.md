---
title: "Data retention"
description: "Set how long each organization keeps raw logs, traces and metrics, see what it uses on disk, and cap it for the whole server."
group: "Multi-tenant self-hosting"
order: 10
---

Every organization has its own ClickHouse database (`org_<slug>`), so retention is set per organization.

## What an admin sees

Organization admins open **Settings, Data platform, Retention & storage**. The panel shows:

- Rows, partitions and disk bytes for each table in the organization's database.
- A **Keep data for (days)** field with 7, 14, 30 and 90 day presets. Blank keeps each table's built-in limit.
- When the last sweep ran and how many daily partitions it dropped.

Only members who can manage the warehouse (org admins) see the panel and can call its API.

## What gets deleted

The scraper service asks the API to sweep every hour. For each organization with a limit, the API drops whole daily partitions older than that many days from the raw tables: traces, logs, the four metrics tables, error events, profiles and session replay data. Rollups and monthly tables are never touched.

A limit above a table's built-in limit has no effect, because the table's own TTL already removes that data first. The built-in limits are 30 days for traces, logs and sessions, 90 days for metrics and error events, and 14 days for profiles.

Each dropped partition is logged by the `maple` container with the organization, table, partition and size:

```bash
docker compose logs maple | grep "Retention: dropping partition"
```

Dropped data cannot be recovered. Lowering the value is the only way to drop data earlier than the built-in limits.

## Server settings

Set these in `deploy/docker/.env`:

| Variable | Default | Meaning |
|---|---|---|
| `MAPLE_RETENTION_MAX_DAYS` | unset | Ceiling on any organization's limit. A larger value saved by an admin is lowered to this. |
| `MAPLE_RETENTION_SWEEP_MINUTES` | `60` | Minutes between sweeps. |

The sweep endpoint, `POST /api/internal/retention/sweep`, takes the `SD_INTERNAL_TOKEN` bearer and is not reachable through the public proxy. Add `?dryRun=1` to log what would be dropped without dropping it.

## Not included yet

A size cap per organization (the value is stored but not enforced), a free-disk guard, limits above the built-in TTLs, ClickHouse system log retention, and retention for session replay blobs and Postgres tables.
