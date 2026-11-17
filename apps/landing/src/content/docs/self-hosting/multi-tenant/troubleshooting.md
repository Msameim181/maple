---
title: "Troubleshooting"
description: "Symptoms, causes and fixes for common multi-tenant Maple problems: sign-in errors, log noise, pending monitors, missing status links, Keycloak admin access and mail."
group: "Multi-tenant self-hosting"
order: 9
---

## Couldn't reach the server, so some sign-in options may be missing

**Symptom:** the sign-in page shows this message and only the root-password form.

**Cause:** the dashboard could not load `GET /api/auth/oidc/config` from the API, so it cannot tell whether SSO is configured.

**Fix:**

1. `curl -s https://api.maple.example.com/health`. If it does not answer `OK`, the `maple` runtime is down or still booting: `docker compose logs --tail 100 maple`, `docker compose restart maple`.
2. Check the dashboard was built with the right `API_HOST`. It is baked in at build time: `docker compose build caddy && docker compose up -d caddy`.
3. Check the browser console for a blocked request (CORS, certificate, DNS).

## Tinybird DNS errors in the logs

**Symptom:** `maple` or `alerting` logs show DNS errors for `unused.invalid` or "Tinybird HTTP transport failed", for example `errorActiveOrgsDiscovery failed`.

**Cause:** the compose file points `TINYBIRD_HOST` at the placeholder `http://unused.invalid` because there is no shared warehouse; every org has its own ClickHouse. A few code paths still write to the shared warehouse regardless. **Known gap:** `audit_log` rows and alerting-discovery writes go to the placeholder and are lost. Error-issue discovery falls back to the orgs' own ClickHouse, so alerting is not missed.

**Fix:** none yet; this is tracked as a separate piece of work (route those writes to each org's ClickHouse). The errors are noise for everything else.

Similar harmless noise: `Alerting colo lookup failed` (a Cloudflare-edge lookup with no meaning here) and, every few seconds while someone has the dashboard open, `ingest: Missing ingest key` (the dashboard's own telemetry without a key). Set `MAPLE_WEB_INGEST_KEY` to an organization's public key (`maple_pk_...`) and rebuild `caddy` to stop the second.

## Billing returns 500 / BillingNotConfigured

**Symptom:** `BillingNotConfigured` and HTTP 500 for billing endpoints.

**Cause:** there is no billing in this deployment.

**Fix:** none needed. Everything is unlimited and nothing depends on it.

## This sign-in expired

**Symptom:** after the Keycloak page (often after clicking an email verification link), Maple shows "This sign-in expired".

**Cause:** the sign-in was started more than 10 minutes ago, or the browser data for that `state` was cleared. A code that arrives in another tab is recovered automatically: Maple finds the pending sign-in by its `state`, or restarts sign-in once if none exists. The message appears only when that second attempt also fails.

**Fix:** click **Sign in with SSO** again. If it happens every time, check that `https://APP_HOST/sign-in` is the registered redirect URI of the `maple-web` client and rerun `./scripts/bootstrap.sh`.

## Unverified email

**Symptom:** after registering, sign-in stops with a "Verify your email" notice.

**Cause:** with the bundled Keycloak, email verification is required, so Keycloak itself stops the sign-in with "Verify your email" until the link is opened. Maple adds a second check: if an identity provider ever lets an unverified address through, Maple refuses it and shows the same notice.

**Fix:** open the verification email (check spam). If it never arrived, see [mail not sending](#mail-not-sending). IT can resend it or mark the user verified from **Admin, Pending verification**.

## Monitors stay pending

See [Status pages and uptime](/docs/self-hosting/multi-tenant/status-and-uptime#why-a-monitor-stays-pending). Quick checks:

```bash
docker compose ps scraper
docker compose logs --tail 50 scraper     # 401 means SD_INTERNAL_TOKEN differs
```

Private and internal targets are refused by design.

## Status link missing

**Symptom:** a published status page shows no public link in the dashboard.

**Cause:** the web build was made without `STATUS_HOST`, so `PUBLIC_STATUS_URL` was empty.

**Fix:** set `STATUS_HOST` in `.env`, create the DNS record, then `docker compose build caddy && docker compose up -d`. Check `https://STATUS_HOST/s/<slug>` directly.

## Keycloak admin 404 behind Caddy

**Symptom:** `https://AUTH_HOST/admin` answers 404.

**Cause:** intentional. `/admin*` and `/realms/master*` are blocked on the public host.

**How to reach it:**

- For scripted changes, use the admin CLI inside the container:
  ```bash
  docker compose exec keycloak /opt/keycloak/bin/kcadm.sh config credentials \
    --server http://localhost:8080 --realm master --user "$KEYCLOAK_ADMIN_USER" --password "$KEYCLOAK_ADMIN_PASSWORD"
  docker compose exec keycloak /opt/keycloak/bin/kcadm.sh get realms/maple
  ```
- For the web console, temporarily allow your own address in the `AUTH_HOST` block of `deploy/docker/Caddyfile` (change the `@private` matcher so it blocks everyone except your IP, for example `@private { path /admin /admin/* /realms/master /realms/master/*  not remote_ip 203.0.113.10 }`), run `docker compose up -d caddy`, and revert when done. This has not been tested here; Keycloak's `KC_HOSTNAME` is the public auth URL, so the console is only reachable through it.

## Mail not sending

**Symptom:** no verification, reset or invitation email.

**Fix, in order:**

1. `SMTP_URL` is set in `.env`? Without it email is off.
2. Keycloak mail (verification, reset) uses the SMTP settings that `bootstrap.sh` wrote into the realm. After changing `SMTP_URL`, run `./scripts/bootstrap.sh` again.
3. Maple's own mail (invitations, alerts) goes through an in-container bridge: `docker compose logs maple | grep mail-bridge`.
4. A plain SMTP relay without TLS needs `SMTP_INSECURE=1`.
5. Check the `EMAIL_FROM` domain is allowed by your SMTP provider (SPF/DKIM) so mail is not rejected or spam-filtered.

## Other symptoms

| Symptom | Fix |
|---|---|
| A new org shows no data and Settings, Data platform reports a failed apply | The schema apply was interrupted by a restart. Press **Apply** there |
| Spans sent right after creating an org get `503` | The route turns ready about a minute after the schema is applied. Exporters retry |
| `502` from the API host | The runtime was OOM-killed. `docker compose restart maple`, add RAM |
