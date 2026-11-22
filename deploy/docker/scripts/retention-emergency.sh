#!/usr/bin/env bash
# Disk-full emergency tool for the self-hosted ClickHouse. Runs on the host and talks only to the
# clickhouse container: it works when the Maple API, worker, scraper and Postgres are down.
#
#   scripts/retention-emergency.sh status [--top N]
#   scripts/retention-emergency.sh free [--target-free-percent N | --keep-days N] [--org <slug>] [--yes] [--dry-run]
#   scripts/retention-emergency.sh truncate-system-logs [--yes] [--dry-run]
#   scripts/retention-emergency.sh drop-org-data --org <slug> [--dry-run]
#   scripts/retention-emergency.sh tables   (the raw-table allowlist)
#
# `free` drops the oldest daily partitions (never today's) of the raw tables below; the sweep's
# MAPLE_CLICKHOUSE_MIN_FREE_PERCENT guard is the automatic version of `free --target-free-percent`.
set -euo pipefail
umask 077
cd "$(dirname "$0")/.."

# Same allowlist as RETENTION_TABLE_TTL_DAYS in packages/domain/src/http/org-retention.ts; a backend test fails on drift. Keep it on one line.
RAW_TABLES=(traces logs metrics_sum metrics_gauge metrics_histogram metrics_exponential_histogram error_events profiles session_replays session_replay_events session_events)
SLUG_PATTERN='^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$' # DIRECTORY_ORG_ID_PATTERN
DEFAULT_TARGET_PERCENT=15
BATCH=5

DRY_RUN=0 YES=0 ORG="" KEEP_DAYS="" TARGET="" TOP=15
CMD=${1:-}
[ $# -gt 0 ] && shift

die() { echo "error: $*" >&2; exit 1; }
ch() {
	CLICKHOUSE_PASSWORD=${CLICKHOUSE_ADMIN_PASSWORD:?CLICKHOUSE_ADMIN_PASSWORD missing from .env} \
		docker compose exec -T -e CLICKHOUSE_PASSWORD clickhouse clickhouse-client --user admin "$@"
}
q() { ch --query "$1"; }
human() { awk -v b="$1" 'BEGIN{split("B KB MB GB TB PB",u," ");i=1;while(b>=1000&&i<6){b/=1000;i++}printf "%.1f %s",b,u[i]}'; }
pct() { awk -v f="$1" -v t="$2" 'BEGIN{printf "%.1f",f*100/t}'; }

TABLE_IN=""
for t in "${RAW_TABLES[@]}"; do TABLE_IN+="${TABLE_IN:+,}'$t'"; done

is_raw_table() { local t; for t in "${RAW_TABLES[@]}"; do [ "$t" = "$1" ] && return 0; done; return 1; }
valid_db() { [[ $1 =~ ^org_[a-z0-9_]+$ ]]; }
valid_partition() { [[ $1 =~ ^[0-9]{8}$ ]]; }
valid_system_log() { [[ $1 =~ ^[a-z0-9_]+_log(_[0-9]+)?$ ]]; }
db_of_slug() {
	[[ $1 =~ $SLUG_PATTERN ]] || die "invalid organization slug: $1"
	echo "org_${1//-/_}"
}

parse_flags() {
	while [ $# -gt 0 ]; do
		case $1 in
			--yes) YES=1 ;;
			--dry-run) DRY_RUN=1 ;;
			--org) ORG=${2:?--org needs a slug}; shift ;;
			--keep-days) KEEP_DAYS=${2:?--keep-days needs a number}; shift ;;
			--target-free-percent) TARGET=${2:?--target-free-percent needs a number}; shift ;;
			--top) TOP=${2:?--top needs a number}; shift ;;
			*) die "unknown option: $1" ;;
		esac
		shift
	done
	[[ -z $ORG || $ORG =~ $SLUG_PATTERN ]] || die "invalid organization slug: $ORG"
	[[ -z $KEEP_DAYS || $KEEP_DAYS =~ ^[0-9]+$ ]] || die "--keep-days must be a whole number"
	[[ -z $TARGET || $TARGET =~ ^[0-9]+$ ]] || die "--target-free-percent must be a whole number"
	if [ -n "$TARGET" ]; then [ "$TARGET" -ge 1 ] && [ "$TARGET" -le 99 ] || die "--target-free-percent must be 1-99"; fi
	[[ $TOP =~ ^[0-9]+$ ]] || die "--top must be a whole number"
	return 0
}

confirm() {
	if [ "$DRY_RUN" = 1 ]; then return 0; fi
	if [ "$YES" = 1 ]; then return 0; fi
	[ -t 0 ] || die "not a terminal: pass --yes to proceed"
	read -r -p "$1 [y/N] " answer
	[[ $answer == y || $answer == yes ]] || { echo "aborted"; exit 1; }
}

unreachable() {
	cat >&2 <<'MSG'

ClickHouse did not answer. If the disk is full it cannot start or write. In this order:
  1. Stop writers so nothing refills the disk:   docker compose stop ingest maple scraper
  2. Free a little host space (old logs, unused images: `docker system prune` removes stopped
     containers and dangling images, review what it lists first; or grow the volume).
  3. Start ClickHouse:                            docker compose up -d clickhouse
  4. Cheapest first, the diagnostics logs:        scripts/retention-emergency.sh truncate-system-logs
  5. Then old data:                               scripts/retention-emergency.sh free --target-free-percent 15
  6. Start everything again:                      docker compose up -d
MSG
	exit 2
}
host_df() { echo "--- host disk"; df -h /var/lib/docker 2>/dev/null || df -h /; }
ensure_up() { q "SELECT 1" >/dev/null 2>&1 || { host_df; unreachable; }; }

DISK_FREE=0 DISK_TOTAL=0
read_disk() {
	local row
	row=$(q "SELECT sum(free_space), sum(total_space) FROM system.disks WHERE name = 'default'") || return 1
	IFS=$'\t' read -r DISK_FREE DISK_TOTAL <<<"$row"
	[[ $DISK_FREE =~ ^[0-9]+$ && $DISK_TOTAL =~ ^[1-9][0-9]*$ ]] || die "could not read system.disks"
}

# $1 = SQL, $2 = server setting to lift when the statement is refused for size (retried per statement).
run_ddl() {
	if [ "$DRY_RUN" = 1 ]; then echo "  [dry-run] $1"; return 0; fi
	local err
	if err=$(ch --query "$1" 2>&1 >/dev/null); then return 0; fi
	# The server's message says max_[table/partition]_size_to_drop, so match its error code name instead.
	if [[ $err == *TABLE_SIZE_EXCEEDS_MAX_DROP_SIZE_LIMIT* ]]; then
		echo "  refused by $2, retrying with --$2=0 for this statement" >&2
		ch "--$2=0" --query "$1"
	else
		echo "$err" >&2
		return 1
	fi
}

system_logs() { # prints: name<TAB>bytes
	q "SELECT t.name, toString(sum(p.bytes_on_disk)) FROM system.tables AS t INNER JOIN system.parts AS p ON p.database = t.database AND p.table = t.name WHERE t.database = 'system' AND p.active AND match(t.name, '^[a-z0-9_]+_log(_[0-9]+)?\$') GROUP BY t.name ORDER BY sum(p.bytes_on_disk) DESC"
}

LOG_BYTES=0
LOG_NAMES=()
collect_logs() {
	local name bytes
	LOG_BYTES=0 LOG_NAMES=()
	while IFS=$'\t' read -r name bytes; do
		[ -n "$name" ] || continue
		valid_system_log "$name" && [[ $bytes =~ ^[0-9]+$ ]] || continue
		LOG_NAMES+=("$name")
		LOG_BYTES=$((LOG_BYTES + bytes))
		printf '  system.%-34s %s\n' "$name" "$(human "$bytes")"
	done < <(system_logs)
}

truncate_logs() {
	local name
	for name in "${LOG_NAMES[@]+"${LOG_NAMES[@]}"}"; do
		run_ddl "TRUNCATE TABLE IF EXISTS system.\`$name\`" max_table_size_to_drop
	done
}

# Plan arrays, filled by plan_partitions (oldest day first, larger partition first on a tie).
P_DB=() P_TABLE=() P_PART=() P_BYTES=()
plan_partitions() { # $1 = extra WHERE built from validated values; $2 = bytes still needed (0 = all)
	local db table part bytes sum=0
	P_DB=() P_TABLE=() P_PART=() P_BYTES=()
	while IFS=$'\t' read -r db table part bytes; do
		[ -n "$db" ] || continue
		valid_db "$db" && is_raw_table "$table" && valid_partition "$part" && [[ $bytes =~ ^[0-9]+$ ]] || continue
		if [ "$2" -gt 0 ] && [ "$sum" -ge "$2" ]; then break; fi
		P_DB+=("$db") P_TABLE+=("$table") P_PART+=("$part") P_BYTES+=("$bytes")
		sum=$((sum + bytes))
	done < <(q "SELECT database, table, partition_id, toString(sum(bytes_on_disk)) AS b FROM system.parts WHERE active AND startsWith(database, 'org_') AND table IN ($TABLE_IN) AND match(partition_id, '^[0-9]{8}\$') AND partition_id < toString(toYYYYMMDD(today()))$1 GROUP BY database, table, partition_id ORDER BY partition_id ASC, sum(bytes_on_disk) DESC")
}

print_plan() {
	local i total=0
	for i in "${!P_DB[@]}"; do
		printf '  %s  %-34s %s\n' "${P_PART[$i]}" "${P_DB[$i]}.${P_TABLE[$i]}" "$(human "${P_BYTES[$i]}")"
		total=$((total + P_BYTES[i]))
	done
	echo "  ${#P_DB[@]} partitions, $(human "$total") on disk (today's partition is never included)"
}

drop_one() { # index into plan
	local i=$1
	echo "dropping ${P_DB[$i]}.${P_TABLE[$i]} ${P_PART[$i]} ($(human "${P_BYTES[$i]}"))"
	run_ddl "ALTER TABLE \`${P_DB[$i]}\`.\`${P_TABLE[$i]}\` DROP PARTITION ID '${P_PART[$i]}'" max_partition_size_to_drop
}

org_filter() {
	if [ -n "$ORG" ]; then echo " AND database = '$(db_of_slug "$ORG")'"; fi
}

cmd_status() {
	host_df
	ensure_up
	echo "--- ClickHouse disks"
	q "SELECT name, formatReadableSize(free_space) AS free, formatReadableSize(total_space) AS total, round(100 * free_space / total_space, 1) AS free_pct FROM system.disks FORMAT PrettyCompactMonoBlock"
	echo "--- per organization database"
	q "SELECT database, formatReadableSize(sum(bytes_on_disk)) AS size, sum(bytes_on_disk) AS bytes FROM system.parts WHERE active AND startsWith(database, 'org_') GROUP BY database ORDER BY bytes DESC FORMAT PrettyCompactMonoBlock"
	echo "--- per table in organization databases (top $TOP)"
	q "SELECT database, table, formatReadableSize(sum(bytes_on_disk)) AS size, sum(rows) AS rows FROM system.parts WHERE active AND startsWith(database, 'org_') GROUP BY database, table ORDER BY sum(bytes_on_disk) DESC LIMIT $TOP FORMAT PrettyCompactMonoBlock"
	echo "--- $TOP biggest tables overall (system.*_log tables are diagnostics, safe to truncate)"
	q "SELECT database, table, formatReadableSize(sum(bytes_on_disk)) AS size FROM system.parts WHERE active GROUP BY database, table ORDER BY sum(bytes_on_disk) DESC LIMIT $TOP FORMAT PrettyCompactMonoBlock"
}

cmd_truncate_logs() {
	ensure_up
	echo "system log tables:"
	collect_logs
	[ "${#LOG_NAMES[@]}" -gt 0 ] || { echo "nothing to truncate"; return 0; }
	confirm "Truncate these $(human "$LOG_BYTES") of diagnostics logs?"
	truncate_logs
	echo "truncated; ClickHouse returns the space within a few minutes"
}

cmd_free() {
	ensure_up
	[ -z "$KEEP_DAYS" ] || [ -z "$TARGET" ] || die "use either --keep-days or --target-free-percent"
	local filter
	filter=$(org_filter)
	if [ -n "$KEEP_DAYS" ]; then
		plan_partitions "$filter AND partition_id < toString(toYYYYMMDD(today() - $KEEP_DAYS))" 0
		[ "${#P_DB[@]}" -gt 0 ] || { echo "nothing older than $KEEP_DAYS days"; return 0; }
		echo "will drop:"; print_plan
		confirm "Drop these partitions? This cannot be undone."
		local i; for i in "${!P_DB[@]}"; do drop_one "$i"; done
		echo "done; ClickHouse returns the space within a few minutes"
		return 0
	fi

	TARGET=${TARGET:-$DEFAULT_TARGET_PERCENT}
	read_disk
	local free0=$DISK_FREE total=$DISK_TOTAL
	local target_bytes=$((total * TARGET / 100))
	echo "disk: $(human "$free0") free of $(human "$total") ($(pct "$free0" "$total")%), target $TARGET%"
	if [ "$free0" -ge "$target_bytes" ]; then echo "already above the target"; return 0; fi
	echo "system log tables (cheapest to reclaim):"
	collect_logs
	local projected=$((free0 + LOG_BYTES))
	if [ "$projected" -lt "$target_bytes" ]; then
		plan_partitions "$filter" $((target_bytes - projected))
		echo "plus these partitions, oldest first:"; print_plan
	else
		P_DB=() P_TABLE=() P_PART=() P_BYTES=()
	fi
	confirm "Truncate the system logs and drop the partitions above? Dropped data cannot be recovered."
	if [ "${#LOG_NAMES[@]}" -gt 0 ]; then truncate_logs; fi
	local dropped=$LOG_BYTES i=0 n=${#P_DB[@]} est
	while [ "$i" -lt "$n" ]; do
		# ClickHouse frees dropped parts minutes later, so the estimate is the larger of the real
		# reading and what we started with plus everything dropped.
		read_disk
		est=$((free0 + dropped))
		[ "$DISK_FREE" -gt "$est" ] && est=$DISK_FREE
		if [ "$est" -ge "$target_bytes" ]; then break; fi
		local end=$((i + BATCH))
		for ((; i < end && i < n; i++)); do drop_one "$i"; dropped=$((dropped + P_BYTES[i])); done
		echo "round done: real $(human "$DISK_FREE") free, estimated $(human $((free0 + dropped))) after drops"
	done
	read_disk
	est=$((free0 + dropped))
	[ "$DISK_FREE" -gt "$est" ] && est=$DISK_FREE
	if [ "$est" -ge "$target_bytes" ]; then
		echo "target reached (estimated); the real figure follows within minutes: run 'status'"
	else
		echo "everything older than today that this tool may drop is gone and the disk is still below $TARGET%." >&2
		echo "Stop ingest (docker compose stop ingest), free host space, or add disk." >&2
		return 3
	fi
}

cmd_drop_org() {
	[ -n "$ORG" ] || die "drop-org-data needs --org <slug>"
	local db t
	db=$(db_of_slug "$ORG")
	ensure_up
	echo "raw tables of $db that will be emptied (TRUNCATE, today's data included, schema kept):"
	local present=() bytes
	for t in "${RAW_TABLES[@]}"; do
		bytes=$(q "SELECT toString(sum(bytes_on_disk)) FROM system.parts WHERE active AND database = '$db' AND table = '$t'")
		if [ "$(q "SELECT count() FROM system.tables WHERE database = '$db' AND name = '$t'")" = 1 ]; then
			present+=("$t")
			printf '  %-34s %s\n' "$db.$t" "$(human "${bytes:-0}")"
		fi
	done
	[ "${#present[@]}" -gt 0 ] || { echo "no raw tables found"; return 0; }
	if [ "$DRY_RUN" != 1 ]; then
		[ -t 0 ] || die "not a terminal: this command needs you to type the organization slug"
		read -r -p "Type the organization slug ($ORG) to erase its telemetry: " typed
		[ "$typed" = "$ORG" ] || { echo "aborted"; exit 1; }
	fi
	for t in "${present[@]}"; do run_ddl "TRUNCATE TABLE \`$db\`.\`$t\`" max_table_size_to_drop; done
	echo "done"
}

# `tables` needs no credentials: a backend test compares its output with the sweep's allowlist.
if [ "$CMD" = tables ]; then printf '%s\n' "${RAW_TABLES[@]}"; exit 0; fi
# shellcheck disable=SC1091
. ./.env

case $CMD in
	status) parse_flags "$@"; cmd_status ;;
	free) parse_flags "$@"; cmd_free ;;
	truncate-system-logs) parse_flags "$@"; cmd_truncate_logs ;;
	drop-org-data) parse_flags "$@"; cmd_drop_org ;;
	*) sed -n '2,13p' "$0"; exit 1 ;;
esac
