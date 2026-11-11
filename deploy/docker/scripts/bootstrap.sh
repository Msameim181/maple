#!/bin/sh
# One-time (idempotent) setup after `docker compose up -d`:
#   - Keycloak realm `maple`: self-registration with email verification, SMTP, password reset
#   - public OIDC client `maple-web` (code flow + PKCE) and realm role `maple-root` (Maple IT admins)
#   - the first IT admin user, and optionally the first organization
# Usage: scripts/bootstrap.sh <it-admin-email> [<first-org-id> <first-org-name> <org-admin-email>]
set -eu
cd "$(dirname "$0")/.."
. ./.env
IT_EMAIL=${1:?usage: bootstrap.sh <it-admin-email> [org-id org-name org-admin-email]}

kc() { docker compose exec -T keycloak /opt/keycloak/bin/kcadm.sh "$@"; }
kc config credentials --server http://localhost:8080 --realm master \
	--user "$KEYCLOAK_ADMIN_USER" --password "$KEYCLOAK_ADMIN_PASSWORD" >/dev/null

if ! kc get realms/maple >/dev/null 2>&1; then
	kc create realms -s realm=maple -s enabled=true -s registrationAllowed=true \
		-s registrationEmailAsUsername=true -s verifyEmail=true -s loginWithEmailAllowed=true \
		-s duplicateEmailsAllowed=false -s resetPasswordAllowed=true -s rememberMe=true
	echo "realm maple created"
fi

# SMTP for verification and password-reset mail, parsed from SMTP_URL (smtp[s]://user:pass@host:port).
if [ -n "${SMTP_URL:-}" ]; then
	scheme=${SMTP_URL%%://*}; rest=${SMTP_URL#*://}
	creds=""; case "$rest" in *@*) creds=${rest%@*}; rest=${rest##*@};; esac
	host=${rest%%:*}; port=${rest##*:}; [ "$port" = "$rest" ] && port=$([ "$scheme" = smtps ] && echo 465 || echo 587)
	user=${creds%%:*}; pass=${creds#*:}
	ssl=$([ "$scheme" = smtps ] && echo true || echo false)
	starttls=$([ "$scheme" = smtps ] && echo false || echo true)
	kc update realms/maple -s "smtpServer.host=$host" -s "smtpServer.port=$port" \
		-s "smtpServer.from=$EMAIL_FROM" -s "smtpServer.ssl=$ssl" -s "smtpServer.starttls=$starttls" \
		-s "smtpServer.auth=$([ -n "$user" ] && echo true || echo false)" \
		-s "smtpServer.user=$user" -s "smtpServer.password=$pass"
	echo "realm SMTP set to $host:$port"
fi

if [ -z "$(kc get clients -r maple -q clientId=maple-web --fields id --format csv --noquotes)" ]; then
	kc create clients -r maple -s clientId=maple-web -s publicClient=true -s standardFlowEnabled=true \
		-s directAccessGrantsEnabled=false -s "redirectUris=[\"https://$APP_HOST/sign-in\"]" \
		-s "webOrigins=[\"https://$APP_HOST\"]" -s 'attributes."pkce.code.challenge.method"=S256' \
		-s "attributes.\"post.logout.redirect.uris\"=https://$APP_HOST/*"
	echo "client maple-web created"
fi

kc get roles/maple-root -r maple >/dev/null 2>&1 || kc create roles -r maple -s name=maple-root \
	-s 'description=Maple IT administrator (all organizations)'

if [ -z "$(kc get users -r maple -q email="$IT_EMAIL" -q exact=true --fields id --format csv --noquotes)" ]; then
	temp=$(openssl rand -base64 18)
	# A name up front, or Keycloak stops the first sign-in at "update your profile".
	kc create users -r maple -s username="$IT_EMAIL" -s email="$IT_EMAIL" -s enabled=true -s emailVerified=true \
		-s firstName=IT -s "lastName=${IT_EMAIL%%@*}"
	kc set-password -r maple --username "$IT_EMAIL" --new-password "$temp" --temporary
	echo "IT admin $IT_EMAIL created, temporary password: $temp (must change at first sign-in)"
fi
kc add-roles -r maple --uusername "$IT_EMAIL" --rolename maple-root

if [ $# -ge 4 ]; then
	api="https://$API_HOST"
	# CURL_OPTS=-k when testing on *.localhost with Caddy's local CA.
	login=$(curl -fsS ${CURL_OPTS:-} "$api/api/auth/login" -H 'content-type: application/json' \
		-d "{\"password\":\"$MAPLE_ROOT_PASSWORD\"}") || { echo "root login failed" >&2; exit 1; }
	token=$(printf %s "$login" | sed -E 's/.*"token":"([^"]+)".*/\1/')
	curl -fsS ${CURL_OPTS:-} "$api/api/directory/orgs" -H "authorization: Bearer $token" -H 'content-type: application/json' \
		-d "{\"id\":\"$2\",\"name\":\"$3\",\"adminEmail\":\"$4\"}" >/dev/null \
		|| { echo "creating org $2 failed" >&2; exit 1; }
	echo "org $2 created; invitation sent to $4"
fi
echo "done. Sign in at https://$APP_HOST"
