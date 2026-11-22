---
title: "Security"
description: "What the stack exposes to the internet, which paths are blocked, response headers, secrets handling, the maple-admin service-account risk and hardening recommendations."
group: "Multi-tenant self-hosting"
order: 8
---

## What is exposed

Only ports 80 and 443 (Caddy) are public. Every other service is on the private compose network. The two OTLP ports 4317 and 4318 are published on `127.0.0.1` only.

| Hostname | Public to | Notes |
|---|---|---|
| `APP_HOST` | Everyone | Static dashboard. No secrets in it |
| `API_HOST` | Everyone | Every route needs a session token or key, except sign-in and health. `/api/internal/*` is blocked (404) |
| `SYNC_HOST` | Everyone | Live sync. Each shape request is authenticated by `electric-sync` with the session token |
| `AUTH_HOST` | Everyone | Keycloak sign-in. `/admin*` and `/realms/master*` are blocked (404) |
| `INGEST_HOST` | Everyone | OTLP. Unknown ingest keys get `401` |
| `STATUS_HOST` | Everyone | Public status pages only (`/s/<slug>`) |

### Blocked paths

- `API_HOST`: `/api/internal/*`. These are the scraper's endpoints and are for the compose network only.
- `AUTH_HOST`: `/admin`, `/admin/*`, `/realms/master` and `/realms/master/*`. The Keycloak admin console and the master realm stay off the internet.

If you use your own reverse proxy, add the same rules. The shipped host-proxy configs for Caddy and Nginx already include them.

### Headers

Caddy sets these on `APP_HOST`: `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Content-Security-Policy: frame-ancestors 'none'`, and a **report-only** content security policy (the built page has an inline theme script, so it allows `'unsafe-inline'` scripts for now).

## Secrets

- `.env` holds every secret. Keep it mode 600 and owned by root. Back it up somewhere safe.
- `MAPLE_INGEST_KEY_ENCRYPTION_KEY` and `MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY` can never change after first start.
- Session tokens are signed with a key derived (HKDF-SHA256) from `MAPLE_SESSION_SIGNING_SECRET`, salted with `MAPLE_ROOT_PASSWORD`, so a captured token reveals nothing about the password. If the secret is empty, the key is derived from the root password alone and the API logs a warning at start. Keep both set (`gen-secrets.sh` creates both). The API refuses to start with a root password shorter than 16 characters or a known placeholder, and root-password login is limited to 10 attempts per minute per client address.
- `MAPLE_ROOT_PASSWORD` is **not** passed to the `ingest` service.
- Electric (`ELECTRIC_SECRET`) only accepts shape requests that carry the secret, and only `maple` holds it. Without it, a compromised service on the network could read other organizations' rows.
- The IdP refresh token of each session is stored encrypted in Postgres.

## The maple-admin service account

For IT conveniences (resend verification, mark verified), the API holds a Keycloak service account, client `maple-admin`, with `view-users` and `manage-users`. Its secret is `MAPLE_OIDC_ADMIN_CLIENT_SECRET`.

**Risk:** `manage-users` lets whoever holds the secret edit users, which includes granting the `maple-root` role. A compromised API could therefore escalate to IT admin. Mitigations: keep `.env` private, do not expose the Keycloak admin API (it is blocked at Caddy), and monitor Keycloak admin events. If you do not need these features, leave the three `MAPLE_OIDC_ADMIN_*` variables out.

## Tenant isolation

- Every telemetry row carries the organization id, and every query must filter on it.
- Each organization has its own ClickHouse database and user (`org_<id>`), so the database enforces isolation.
- Ingest keys, API keys and MCP keys are bound to one organization.
- Uptime "Test" and the scraper refuse private addresses, so monitors cannot be used to reach internal services.

## Recommendations

1. **Enforce 2FA for `admin` and `root` users** in Keycloak (Authentication, Required actions, and a conditional OTP flow). Partners' users live in your Keycloak, so password policy and 2FA are your responsibility.
2. Keep IT (`maple-root`) membership small. The root-password login is a shared credential; use it for emergencies only and rotate it when staff change.
3. Replace Keycloak's temporary bootstrap admin (see [Operations](/docs/self-hosting/multi-tenant/operations#keycloak-admin-account)).
4. Do not enable "Trust email" on federated IdPs you do not control.
5. Keep the firewall to SSH, 80 and 443, and restrict SSH.
6. Back up, and test a restore.
7. Review the report-only CSP in your browser console, then move it to enforcing if it is quiet.
8. Keep the stack up to date: rebuild images regularly.

## Known limits

- Session tokens are stateless on the Workers, so a removed person's token works until it expires (10 minutes by default). See [How authentication works](/docs/self-hosting/multi-tenant/how-auth-works#when-a-person-is-removed-or-disabled).
- Back-channel logout and HttpOnly cookie sessions are not implemented.
- Audit-log writes currently go to a placeholder warehouse, so the audit log is not populated. See [Troubleshooting](/docs/self-hosting/multi-tenant/troubleshooting#tinybird-dns-errors-in-the-logs).
- **Uptime "Test", scrape targets and alert webhooks resolve DNS names in the API without pinning the address.** A name that resolves to a private address (for example a public DNS name pointing at `10.x`) can reach the API container's network. Single-label names such as `electric` or `keycloak` and private literal IPs are refused. The services on the compose network are protected by credentials (`ELECTRIC_SECRET`, `SD_INTERNAL_TOKEN`, Keycloak admin tokens, per-org ClickHouse users), but on a cloud host the instance metadata address can be reachable by name. On a cloud VM, block the metadata address for all containers with one host firewall rule (it does not affect the stack's own traffic):

  ```sh
  sudo iptables -I DOCKER-USER -d 169.254.169.254 -j DROP
  ```

  Make it persistent with your distribution's tool (for example `iptables-persistent` or `nftables`). The `DOCKER-USER` chain survives Docker restarts. Also give the engineer role only to people you would trust with this reach, since engineers can use the uptime "Test" button. If you run other tools on the same host (an admin UI or monitoring port bound to localhost or the Docker gateway), review whether a container should be able to reach them. A filtering DNS resolver or a pinned probe for the "Test" button would close the DNS-name case fully; neither is built yet.
- **The identity token is not signature-checked.** Maple trusts the token endpoint over the private compose network (`http://keycloak:8080`) and checks `iss`, `aud`, `azp` and `exp`. Do not put untrusted containers on that network. Verifying against the realm's JWKS is planned work.
- **The session token lives in `localStorage`.** It is shared across tabs, so a person who closes the tab without logging out stays signed in on that browser profile until the token's lifetime ends. Use the account page's sign out on shared machines. The report-only CSP is the main protection against script injection; move it to enforcing once it is quiet.
- **Renewal skips the identity provider for 30 seconds after a successful renewal.** A session ended in Keycloak therefore takes up to 30 seconds plus one token lifetime to stop working in an already-open tab, and a reload within 30 seconds of the last renewal is not re-checked.
- **A Keycloak email change might keep the "verified" flag.** Keycloak with email verification on resets it when a person changes their address in "Edit profile". This was not tested here. Validate it before relying on invitations to unverified addresses.
- **Keycloak path parameters.** The edge rules for `/admin` and `/realms/master` also match `;` path parameters and any letter case. If you use your own reverse proxy, copy those rules from `deploy/docker/proxy`.
