# Self-host data retention (per-org) — plan v1

## Decision
Per-org, not global. Each org has its own ClickHouse database (`org_<slug>`), so per-org is as easy as global and more useful. Operator keeps an instance-wide ceiling via env; org admins set their own value up to it.

## Modes
1. **Age**: keep N days. Sweep drops daily partitions older than N from the org's raw tables.
2. **Size**: keep under B bytes. Sweep drops oldest daily partitions until under cap. (Slice 2.)

## Slice 1 (this build)
1. Read-only storage readout per org: bytes/rows per table from `system.parts` (active), via `ClickHouseAdmin` (needs a rows-returning variant).
2. Config table `org_retention_settings` (Postgres): `orgId` PK, `maxAgeDays` nullable, `maxBytes` nullable (stored, not enforced yet), `updatedBy`, `updatedAt`. Separate from `org_clickhouse_settings`.
3. Age enforcement: `RetentionService.sweep()` loops directory orgs with `maxAgeDays` set, `DROP PARTITION` on daily-partitioned raw tables older than N. N is capped per table at that table's shipped TTL (a larger N has no effect). Raw tables only (traces, logs, metrics_*, error_events, profiles, sessions). Monthly rollups untouched.
4. Trigger: internal endpoint `/api/internal/retention/sweep` (`SD_INTERNAL_TOKEN`), called by the scraper via `Schedule.spaced` (default 60 min, env `MAPLE_RETENTION_SWEEP_MINUTES`). Not workers cron (spike S6 unverified).
5. API (admin only, `warehouse:manage`): `GET/PUT /api/org-clickhouse-settings/retention`, `GET /api/org-clickhouse-settings/storage`.
6. Web: "Retention & storage" panel in Settings → Data platform. Usage table, age input (days, presets 7/14/30/90), save, last sweep note. Hidden without `warehouse:manage`.
7. Instance ceiling env: `MAPLE_RETENTION_MAX_DAYS` (optional) clamps PUT.

## Safety
- Database name only via `orgDatabaseName` + `DIRECTORY_ORG_ID_PATTERN` check; table names from a fixed allowlist derived from datasources, never from input.
- Partition ids parsed from `system.parts` and validated against `^\d{8}$` before use in DDL.
- Log every dropped partition (org, table, partition, bytes).
- Dry-run flag on sweep, used by tests.
- Raise `max_partition_size_to_drop` only per statement via SETTINGS if needed; do not change server config.

## Slice 2 (built)
- Size cap per org (`maxBytes`), enforced in the sweep: oldest daily partition across raw tables first (largest table on ties), never today's or a table's newest; age and size both apply; `reason` logged (age|size|disk).
- `MAPLE_RETENTION_MAX_BYTES` ceiling (clamps saves, and holds orgs with no cap); `MAPLE_CLICKHOUSE_MIN_FREE_PERCENT` free-disk guard over all org databases (max 20 drops per sweep, 2-point margin, estimated from dropped bytes because freed space lags).
- Cutoff from ClickHouse `today()` (server tz). Web: Max storage field, presets, usage bar.
- Not done: per-statement `SETTINGS max_partition_size_to_drop=0` (could not be verified: no ClickHouse image/container available; a partition over the server limit fails its drop, which is logged and recorded as the org's sweep error); per-reason counts in the sweep note (needs a column).

## Later
N above shipped TTL via `MODIFY TTL`, system.*_log TTLs, replay blob lifecycle, Postgres tables retention.

## Tests
Service tests with a fake ClickHouseAdmin (partition selection, validation, clamp, dry-run); API auth test (non-admin 403); web update test for the panel state.

## Verification
Typecheck + tests for touched packages only (system load). Screenshot of the panel.
