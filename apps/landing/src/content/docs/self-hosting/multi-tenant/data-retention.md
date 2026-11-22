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
- A **Max storage (GB)** field with 1, 5, 10 and 50 GB presets, and a bar of current usage against the cap. Blank means no cap.
- When the last sweep ran and how many daily partitions it dropped.

Only members who can manage the warehouse (org admins) see the panel and can call its API.

## What gets deleted

The scraper service asks the API to sweep every hour. For each organization with a limit, the API drops whole daily partitions older than that many days from the raw tables: traces, logs, the four metrics tables, error events, profiles and session replay data. Rollups and monthly tables are never touched.

An organization's size cap, and the age limit, are enforced only for organizations that have saved settings.

A limit above a table's built-in limit has no effect, because the table's own TTL already removes that data first. The built-in limits are 30 days for traces, logs and sessions, 90 days for metrics and error events, and 14 days for profiles.

### Size cap

If an organization sets a max storage, each sweep measures its database (active parts in `system.parts`, all tables). While it is over the cap, the sweep drops the oldest daily partition across the raw tables, oldest day first and the larger table first on a tie, until it is under the cap or nothing more can be dropped. Today's partition and the newest partition of each table are never dropped. The cap is approximate: it is checked once per sweep, drops whole days, and rollup tables count toward the size but are never dropped. Age and size can both be set; either one deletes.

### Free-disk guard

With `MAPLE_CLICKHOUSE_MIN_FREE_PERCENT` set, a sweep reads the free space of ClickHouse's `default` disk. Below the threshold it drops the oldest daily partitions across all organizations, whatever their settings, until the estimated free space is 2 points above the threshold. ClickHouse frees the space a few minutes after a drop, so one sweep drops at most 20 partitions and the next sweep re-reads the disk.

### Time zone

Cutoffs use the ClickHouse server's own `today()`, the same clock that assigns rows to daily partitions, so they are right when the server is not on UTC.

Each dropped partition is logged by the `maple` container with the organization, table, partition, size and reason (`age`, `size` or `disk`):

```bash
docker compose logs maple | grep "Retention: dropping partition"
```

Dropped data cannot be recovered. Lowering the value is the only way to drop data earlier than the built-in limits.

## Server settings

Set these in `deploy/docker/.env`:

| Variable | Default | Meaning |
|---|---|---|
| `MAPLE_RETENTION_MAX_DAYS` | unset | Ceiling on any organization's limit. A larger value saved by an admin is lowered to this. |
| `MAPLE_RETENTION_MAX_BYTES` | unset | Ceiling in bytes on any organization's size cap. A larger value saved by an admin is lowered to this, and an organization with no cap of its own is held to it. |
| `MAPLE_CLICKHOUSE_MIN_FREE_PERCENT` | unset (off) | Free-disk guard threshold, as a percent. |
| `MAPLE_RETENTION_SWEEP_MINUTES` | `60` | Minutes between sweeps. |

The sweep endpoint, `POST /api/internal/retention/sweep`, takes the `SD_INTERNAL_TOKEN` bearer and is not reachable through the public proxy.

## Not included yet

Ceilings and caps for organizations that never saved retention settings, limits above the built-in TTLs, ClickHouse system log retention, and retention for session replay blobs and Postgres tables.
