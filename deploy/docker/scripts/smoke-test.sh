#!/bin/sh
# End-to-end check of a running stack: two orgs get their own ClickHouse database and ingest key,
# each sees only its own telemetry, and deleting an org then re-creating its id starts empty.
# Usage: scripts/smoke-test.sh   (CURL_OPTS=-k for the local CA when testing on *.localhost)
set -eu
cd "$(dirname "$0")/.."
. ./.env
api="https://$API_HOST"; ingest="https://$INGEST_HOST"
c() { curl -fsS ${CURL_OPTS:-} "$@"; }
ch() { docker compose exec -T clickhouse clickhouse-client --user admin --password "$CLICKHOUSE_ADMIN_PASSWORD" -q "$1"; }
json() { sed -E "s/.*\"$1\":\"([^\"]+)\".*/\1/"; }
pass() { echo "PASS $1"; }
fail() { echo "FAIL $1" >&2; exit 1; }

root=$(c "$api/api/auth/login" -H 'content-type: application/json' -d "{\"password\":\"$MAPLE_ROOT_PASSWORD\"}" | json token)
[ -n "$root" ] && pass "root login" || fail "root login"

auth() { echo "authorization: Bearer $1"; }
create_org() {
	c "$api/api/directory/orgs" -H "$(auth "$root")" -H 'content-type: application/json' \
		-d "{\"id\":\"$1\",\"name\":\"$1\",\"adminEmail\":\"admin@$1.test\"}" >/dev/null
}
delete_org() { c -X DELETE "$api/api/directory/orgs/$1" -H "$(auth "$root")" >/dev/null; }
wait_schema() { # $1 database: the org's schema is applied by a Workflow, asynchronously
	for _ in $(seq 1 60); do
		[ "$(ch "SELECT count() FROM system.tables WHERE database = '$1' AND name = 'traces'")" = 1 ] && return 0
		sleep 3
	done
	return 1
}
org_token() { c "$api/api/directory/switch-org" -H "$(auth "$root")" -H 'content-type: application/json' -d "{\"orgId\":\"$1\"}" | json token; }
ingest_key() { c "$api/v2/ingest_keys" -H "$(auth "$(org_token "$1")")" | json private_key; }
send_span() { # $1 key, $2 service name
	now=$(date +%s)000000000
	c "$ingest/v1/traces" -H "x-maple-ingest-key: $1" -H 'content-type: application/json' -d "{\"resourceSpans\":[{\"resource\":{\"attributes\":[{\"key\":\"service.name\",\"value\":{\"stringValue\":\"$2\"}}]},\"scopeSpans\":[{\"spans\":[{\"traceId\":\"$(openssl rand -hex 16)\",\"spanId\":\"$(openssl rand -hex 8)\",\"name\":\"smoke\",\"kind\":2,\"startTimeUnixNano\":\"$now\",\"endTimeUnixNano\":\"$now\"}]}]}]}" >/dev/null
}
count() { ch "SELECT count() FROM $1.traces WHERE ServiceName = '$2'"; }
wait_count() { # $1 db, $2 service, $3 expected
	for _ in $(seq 1 30); do [ "$(count "$1" "$2")" = "$3" ] && return 0; sleep 2; done; return 1
}

for org in smoke-a smoke-b; do delete_org "$org" 2>/dev/null || true; done
create_org smoke-a && create_org smoke-b && pass "create two orgs"
wait_schema org_smoke_a && wait_schema org_smoke_b && pass "per-org ClickHouse schema applied" || fail "schema apply"

key_a=$(ingest_key smoke-a); key_b=$(ingest_key smoke-b)
[ -n "$key_a" ] && [ -n "$key_b" ] && [ "$key_a" != "$key_b" ] && pass "distinct ingest keys" || fail "ingest keys"

# A new org's ingest route turns ready once its schema row is marked connected, and the gateway
# caches readiness for up to a minute; until then it answers 503, which OTLP exporters retry.
deliver() { # $1 key, $2 service, $3 db: send until the span lands, like an exporter retrying
	for _ in $(seq 1 30); do
		send_span "$1" "$2" 2>/dev/null || true
		[ "$(count "$3" "$2")" -ge 1 ] && return 0
		sleep 4
	done
	return 1
}
deliver "$key_a" smoke-svc-a org_smoke_a && pass "org A span stored in org A" || fail "org A span"
deliver "$key_b" smoke-svc-b org_smoke_b && pass "org B span stored in org B" || fail "org B span"
[ "$(count org_smoke_a smoke-svc-b)" = 0 ] && [ "$(count org_smoke_b smoke-svc-a)" = 0 ] \
	&& pass "no cross-org rows" || fail "cross-org leak"

if c "$ingest/v1/traces" -H 'x-maple-ingest-key: maple_sk_bogus' -H 'content-type: application/json' -d '{}' >/dev/null 2>&1; then
	fail "unknown ingest key accepted"
else
	pass "unknown ingest key rejected"
fi

delete_org smoke-a
for _ in $(seq 1 30); do [ "$(ch "SELECT count() FROM system.databases WHERE name = 'org_smoke_a'")" = 0 ] && break; sleep 2; done
[ "$(ch "SELECT count() FROM system.databases WHERE name = 'org_smoke_a'")" = 0 ] && pass "delete purges the org database" || fail "purge"
create_org smoke-a && wait_schema org_smoke_a && [ "$(count org_smoke_a smoke-svc-a)" = 0 ] \
	&& pass "re-created id starts empty" || fail "re-create"

delete_org smoke-a; delete_org smoke-b
echo "smoke test complete"
