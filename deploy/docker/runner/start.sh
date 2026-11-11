#!/bin/sh
# Container entrypoint: migrate Postgres, start the email relay, then run the stack.
set -eu
cd /app

for attempt in 1 2 3 4 5 6 7 8 9 10; do
	DATABASE_URL="$MAPLE_PG_URL" bun run --cwd packages/db db:migrate && break
	echo "[start] migrations failed (attempt $attempt), retrying in 5s" >&2
	sleep 5
done

deploy/docker/runner/mail-relay.sh &

exec node_modules/.bin/alchemy dev --stage dev_selfhost
