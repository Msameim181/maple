#!/bin/sh
# alchemy's local `send_email` binding writes each message as an .eml file instead of sending it.
# This loop hands every such file to SMTP_URL with curl, then deletes it. No SMTP_URL: email off.
# shortcut: polls every 10s and parses only From/To headers; upgrade to a real MTA if volume grows.
set -u
[ -n "${SMTP_URL:-}" ] || { echo "[mail-relay] SMTP_URL unset, email disabled"; exit 0; }
DIR=/app/.alchemy/local/email
mkdir -p "$DIR"
while true; do
	for f in $(find "$DIR" -name '*.eml' -type f 2>/dev/null); do
		from=$(grep -m1 -i '^From:' "$f" | sed -E 's/^From:[[:space:]]*//I; s/.*<([^>]+)>.*/\1/')
		rcpts=$(grep -m1 -i '^To:' "$f" | sed -E 's/^To:[[:space:]]*//I' | tr ',' '\n' | sed -E 's/.*<([^>]+)>.*/\1/; s/[[:space:]]//g')
		args=""
		for r in $rcpts; do args="$args --mail-rcpt $r"; done
		tls="--ssl-reqd"
		[ "${SMTP_INSECURE:-0}" = "1" ] && tls=""
		# shellcheck disable=SC2086
		if curl -sS $tls --url "$SMTP_URL" --mail-from "${SMTP_FROM:-$from}" $args --upload-file "$f"; then
			rm -f "$f"
		else
			echo "[mail-relay] send failed for $f, will retry" >&2
		fi
	done
	sleep 10
done
