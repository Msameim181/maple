#!/bin/sh
# Creates deploy/docker/.env from .env.example with every secret filled. If .env exists, only
# adds the keys it lacks and fills empty secrets; existing values are never changed (idempotent).
set -eu
umask 077 # secrets files and temp files must never be world-readable
cd "$(dirname "$0")/.."
hex() { openssl rand -hex 32; }
new=0
if [ ! -f .env ]; then cp .env.example .env; new=1; fi
chmod 600 .env

# Keys added to .env.example after the first install (hostnames included: review them).
if [ "$new" = 0 ]; then
	while IFS= read -r line; do
		key=${line%%=*}
		case "$line" in [A-Z]*=*) ;; *) continue ;; esac
		grep -q "^$key=" .env || { echo "$line" >> .env; echo "added $key (check its value)"; }
	done < .env.example
fi

fill() { # $1 key, $2 value: set only when the key is empty
	grep -q "^$1=." .env && return 0
	sed -e "s|^$1=.*|$1=$2|" .env > .env.tmp && mv .env.tmp .env && chmod 600 .env
	[ "$new" = 1 ] || echo "generated $1"
}
for k in POSTGRES_PASSWORD CLICKHOUSE_ADMIN_PASSWORD KEYCLOAK_ADMIN_PASSWORD MAPLE_ROOT_PASSWORD \
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY MAPLE_SHARE_TOKEN_HMAC_KEY INTERNAL_SERVICE_TOKEN \
	SANDBOX_INTERNAL_SERVICE_TOKEN ELECTRIC_SECRET SD_INTERNAL_TOKEN MAPLE_SESSION_SIGNING_SECRET \
	MAPLE_OIDC_ADMIN_CLIENT_SECRET; do
	fill "$k" "$(hex)"
done
fill MAPLE_INGEST_KEY_ENCRYPTION_KEY "$(openssl rand -base64 32)"
[ "$new" = 1 ] && echo "wrote deploy/docker/.env; now set the hostnames, SMTP_URL and EMAIL_FROM" || echo "updated deploy/docker/.env"
