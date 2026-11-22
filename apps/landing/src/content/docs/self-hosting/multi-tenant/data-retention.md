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

## Disk full emergency

The sweep's free-disk guard (`MAPLE_CLICKHOUSE_MIN_FREE_PERCENT`) is the automatic version of this. When the disk is already full, or ClickHouse is down, use `deploy/docker/scripts/retention-emergency.sh` on the host. It talks only to the `clickhouse` container, so it works with the Maple API, worker, scraper and Postgres stopped. Run it from `deploy/docker`:

```bash
# 1. See where the space is: disks, host df, bytes per organization database and table,
#    and the biggest tables overall, including system.query_log, trace_log, metric_log, text_log.
scripts/retention-emergency.sh status

# 2. Cheapest first: truncate ClickHouse's own diagnostics logs (safe, they hold no telemetry).
scripts/retention-emergency.sh truncate-system-logs

# 3. Free space down to a target (default 15% free). Truncates the system logs first, then removes
#    the oldest daily partitions across all organizations until the target is reached.
scripts/retention-emergency.sh free --target-free-percent 15

# 4. Or remove by age: everything older than N days, all organizations or one.
scripts/retention-emergency.sh free --keep-days 14
scripts/retention-emergency.sh free --org acme --keep-days 7

# 5. Last resort: erase every raw table of one organization (you type its slug to confirm).
scripts/retention-emergency.sh drop-org-data --org acme
```

Every destructive command prints exactly what it will remove with sizes and asks for confirmation; `--yes` skips the question for scripts. `--dry-run` prints the plan and the statements and changes nothing. Today's partition is never removed by `free`, and only the raw tables listed above are touched. ClickHouse hands the space back a few minutes after a removal, so `free` tracks an estimate and `status` shows the real figure later. If a statement is refused because it exceeds ClickHouse's `max_partition_size_to_drop` (or `max_table_size_to_drop`), the script retries that one statement with the limit lifted for it.

If ClickHouse will not answer because the disk is completely full, the script prints the fallback: stop the writers (`docker compose stop ingest maple scraper`), free a little host space, start ClickHouse (`docker compose up -d clickhouse`), run `truncate-system-logs`, then `free`, then `docker compose up -d`.

## Not included yet

Ceilings and caps for organizations that never saved retention settings, limits above the built-in TTLs, ClickHouse system log retention, and retention for session replay blobs and Postgres tables.
