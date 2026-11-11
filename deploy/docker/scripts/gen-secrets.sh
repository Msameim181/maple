#!/bin/sh
# Creates deploy/docker/.env from .env.example with every secret filled. Refuses to overwrite.
set -eu
cd "$(dirname "$0")/.."
[ -f .env ] && { echo ".env already exists; not touching it" >&2; exit 1; }
hex() { openssl rand -hex 32; }
sed \
	-e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(hex)|" \
	-e "s|^CLICKHOUSE_ADMIN_PASSWORD=.*|CLICKHOUSE_ADMIN_PASSWORD=$(hex)|" \
	-e "s|^KEYCLOAK_ADMIN_PASSWORD=.*|KEYCLOAK_ADMIN_PASSWORD=$(hex)|" \
	-e "s|^MAPLE_ROOT_PASSWORD=.*|MAPLE_ROOT_PASSWORD=$(hex)|" \
	-e "s|^MAPLE_INGEST_KEY_ENCRYPTION_KEY=.*|MAPLE_INGEST_KEY_ENCRYPTION_KEY=$(openssl rand -base64 32)|" \
	-e "s|^MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY=.*|MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY=$(hex)|" \
	-e "s|^MAPLE_SHARE_TOKEN_HMAC_KEY=.*|MAPLE_SHARE_TOKEN_HMAC_KEY=$(hex)|" \
	-e "s|^INTERNAL_SERVICE_TOKEN=.*|INTERNAL_SERVICE_TOKEN=$(hex)|" \
	-e "s|^SANDBOX_INTERNAL_SERVICE_TOKEN=.*|SANDBOX_INTERNAL_SERVICE_TOKEN=$(hex)|" \
	.env.example > .env
chmod 600 .env
echo "wrote deploy/docker/.env; now set the hostnames, SMTP_URL and EMAIL_FROM"
