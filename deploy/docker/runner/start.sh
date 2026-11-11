#!/bin/sh
# Container entrypoint: migrate Postgres, start the email bridge, then run the stack.
set -eu
cd /app

for attempt in 1 2 3 4 5 6 7 8 9 10; do
	DATABASE_URL="$MAPLE_PG_URL" bun run --cwd packages/db db:migrate && break
	echo "[start] migrations failed (attempt $attempt), retrying in 5s" >&2
	sleep 5
done

# Local Workflows do not resume after a restart, so a schema apply that was in flight would stay
# "running" forever and block the next one. Mark it failed; Settings -> Data platform re-applies.
DATABASE_URL="$MAPLE_PG_URL" bun -e 'await Bun.sql`UPDATE org_clickhouse_schema_apply_runs SET status = ${"failed"}, error_message = ${"Interrupted by a restart; apply the schema again."}, updated_at = now() WHERE status IN (${"queued"}, ${"running"})`' \
	|| echo "[start] could not reset interrupted schema applies" >&2

bun deploy/docker/runner/mail-bridge.ts &

exec node_modules/.bin/alchemy dev --stage dev_selfhost
