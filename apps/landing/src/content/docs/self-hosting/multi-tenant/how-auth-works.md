---
title: "How authentication works"
description: "Sign-in flow, Maple session tokens and renewal, logout, removed users, multiple tabs, email verification, invitations, roles and the break-glass login."
navLabel: "How auth works"
group: "Multi-tenant self-hosting"
order: 5
---

Keycloak (or another IdP) answers **who is this person**. Maple answers **which organizations they belong to, and with what role**. Membership lives in Maple's Postgres, not in the IdP.

## Sign-in

```
Browser (dashboard)          Keycloak (AUTH_HOST)        Maple API (API_HOST)
      |                            |                            |
 1. make PKCE verifier + state     |                            |
    (kept in this browser)         |                            |
 2. ---- redirect: authorize ----->|                            |
      (client maple-web, S256,     |                            |
       redirect /sign-in)          |                            |
 3.                       person signs in / registers            |
 4. <--- redirect /sign-in?code=...&state=... ---|              |
 5. check state, then ------- POST /api/auth/oidc/callback ----->|
      { code, codeVerifier, redirectUri }                        |
                                   |<-- code + verifier + ------ 6.
                                   |    client_id (server to server)
                                   |--- id/access/refresh ----->|
                                   |    tokens                   |
                                   |                       7. read sub, email,
                                   |                          email_verified,
                                   |                          roles; upsert user;
                                   |                          accept invitations;
                                   |                          create session row
 8. <------------- Maple session token (org, role, sid) --------|
```

Steps in words:

1. The dashboard creates a PKCE verifier and a `state`, and redirects to the authorize URL.
2. The person signs in or registers at Keycloak.
3. Keycloak redirects back to `https://APP_HOST/sign-in` with a `code`.
4. The dashboard posts the code and verifier to `POST /api/auth/oidc/callback`. The API redeems it at the token URL (server to server, over the private compose network) with `client_id` and no secret.
5. The API reads `sub`, `email`, `email_verified` and roles from the tokens. IT staff (the role in `MAPLE_OIDC_ROOT_ROLE`, default `maple-root`) become `root`.
6. If the email is not verified, sign-in is refused and no invitation is accepted.
7. Otherwise the user is upserted, invitations for the verified email are accepted, and a **session row** is stored with the IdP session id (`sid`) and the IdP refresh token, encrypted.
8. The API returns a **Maple session token**: a short-lived token signed with `MAPLE_SESSION_SECRET` (falling back to `MAPLE_ROOT_PASSWORD` if unset). It carries the subject, the active organization, the role and `sid`.

Every Worker (`api`, `electric-sync`, `alerting`, `ai`) verifies this token itself. API keys, MCP keys and ingest keys are separate: they are organization-bound rows in Postgres and do not use it.

## Token lifetime and renewal

- A Maple session token lives for `MAPLE_OIDC_SESSION_TTL_SECONDS` (default 600 seconds, clamped to 120-3600).
- The whole login is bounded by `MAPLE_OIDC_SESSION_MAX_LIFETIME_SECONDS` (default 43200, 12 hours). After that the person signs in again.
- The dashboard renews **ahead of expiry**: it derives the lead time from the token's own `iat`/`exp` (the smaller of 2 minutes and a quarter of the lifetime).
- On renewal the API checks the session row (not revoked, not expired), refreshes the IdP refresh token, re-reads the roles from the refreshed token and re-checks that the person is still a member of an active organization. Then it mints a new token.

```
Browser                       Maple API                      Keycloak
   |-- POST /api/auth/session/refresh (old token) -->|              |
   |                          row ok? not revoked?    |              |
   |                          |-- refresh_token ----->|              |
   |                          |<-- new tokens --------|              |
   |                          roles + membership re-read             |
   |<------- new Maple session token -----------------|              |
```

**If the IdP is down** (unreachable or 5xx), renewal falls back to the membership check alone and logs a warning. A Keycloak outage therefore does not sign everyone out. If the IdP answers `invalid_grant` (session ended, user disabled), renewal fails with 401 and the person must sign in again.

The root-password login is exempt from IdP checks (see [break-glass](#break-glass-root-login)).

## Logout

Logout is done by the server, so it cannot be skipped by clearing the browser:

```
Browser                       Maple API                      Keycloak
   |-- POST /api/auth/logout ------>|                              |
   |                          mark session row revoked             |
   |                          |-- POST logout (client_id + --->|   |
   |                          |   refresh_token)                   |
   |<-- 200 ------------------|      IdP session ended             |
   |-- load /sign-in                                               |
```

Because the IdP session ends too, "Sign in with SSO" asks for the password again instead of silently signing back in. **Sign out everywhere** on the account page revokes every Maple session of that person. If the API is unreachable at logout, the browser clears its token locally. A tab that sat idle past the token lifetime can still log out: the logout endpoint (and only it) accepts a correctly signed expired token that carries a `sid`, until the login's maximum lifetime ends.

## When a person is removed or disabled

- Removed from an organization in **Settings, Members**: the person's API keys and other credentials for that organization are revoked, and the session cannot renew into it.
- Disabled or deleted in Keycloak, or their session ended there: the next renewal gets `invalid_grant` and fails.
- Removed from the IT role in Keycloak: the next renewal re-reads the roles and `root` is gone.

**Limitation:** the Workers are stateless. They accept an unexpired Maple session token without asking the database or the IdP. So access ends at the next renewal, which is **within one token lifetime** (10 minutes by default). Lower `MAPLE_OIDC_SESSION_TTL_SECONDS` to shorten the window; the cost is more renewal traffic. Back-channel logout and per-request revocation checks are not implemented.

On a page reload, the dashboard asks for a refresh right away, so a reload after an IdP-side logout signs out immediately; tabs that stay open follow within one token lifetime.

## Several tabs

The session token is kept in `localStorage`, so it is **shared across tabs**: opening a deep link in a new tab does not ask for sign-in. One tab renews at a time (browser lock). Tabs listen for storage events and **reload** when the user or the active organization changes, or when the token is removed (logout in another tab). A one-time migration moves a token from the older per-tab `sessionStorage`.

## Registration and email verification

- Self-registration is on in the realm and requires email verification.
- Unverified users **cannot sign in to Maple**: they see a "Verify your email" notice, and no invitation is accepted for them.
- Keycloak sends the verification email. The link opens in whatever tab the mail client uses. If it lands in a new tab, Maple recovers the pending sign-in by its `state` and continues. A sign-in older than 10 minutes shows "This sign-in expired".
- IT can open the **Admin** page, see **Pending verification**, and **Resend** the email or **Mark verified**. The list is read from Keycloak (people who signed up but never confirmed cannot finish the Keycloak login, so Maple has never seen them). Mark verified is IT-only on purpose: verification is realm-wide, so an org admin could otherwise enrol an account into every organization that invited that address. These actions need the Keycloak Admin API ([Auth options](/docs/self-hosting/multi-tenant/auth-options#what-degrades-without-keycloak)).

## Invitations

1. An org admin invites `person@partner.com` in **Settings, Members**. Maple sends an invitation email naming the organization.
2. The person registers or signs in with that email and verifies it.
3. On sign-in, a person whose **verified** email matches pending invitations is added to those organizations, and the invitations are marked accepted.

Nothing else assigns membership automatically. Invitations do not expire (they can be revoked).

## Organization switching

A person in several organizations switches with the org switcher. Maple mints a new session token for the chosen organization. IT (`root`) can open any organization. Other tabs reload when the active organization changes.

## Roles

Each role holds every permission of the roles below it. Permissions come from `packages/domain/src/policy/permissions.ts`.

| Role | Gets | Permissions it adds |
|---|---|---|
| `member` | Reads all telemetry, builds dashboards, posts incident updates | `ingest_keys:view_public` |
| `engineer` | Technical setup | `integrations:manage`, `code_review:configure`, `scrape_targets:manage`, `sources:manage`, `alerts:manage`, `uptime_monitors:manage`, `status_pages:edit`, `ingest_rules:manage`, `attribute_mappings:manage`, `ingest_keys:view`, `anomalies:configure`, `error_policy:manage`, `ai_triage:configure`, `security:manage` |
| `admin` | The organization, money and credentials | `organization:manage`, `members:manage`, `billing:manage`, `api_keys:manage`, `ingest_keys:roll`, `status_pages:break_glass`, `warehouse:manage`, `data_sources:manage`, `security_audit:run`, `audit_log:read`, `llm_keys:manage`, `mcp_connections:view_all` |
| `root` | Platform operator (IT) | Everything, in every organization, plus the Admin page: create, rename and delete organizations, see all users |

`root` comes from the IdP role (`maple-root` by default), never from an organization membership. Enforce 2FA for `admin` and `root` users in Keycloak.

## Account page

The Maple account page shows the profile, the Maple sessions and **Sign out everywhere**. Changing a password or setting up 2FA uses Keycloak's application-initiated actions inside the Maple-styled pages, and returns to Maple. A link to the Keycloak account console is shown to `root` only.

## Break-glass root login

On the sign-in page, **Use root password** posts `MAPLE_ROOT_PASSWORD` to `POST /api/auth/login`. The session has the subject `root` and `root` access to every organization.

- It does not touch the IdP, so it works when Keycloak is down.
- Its renewal is exempt from IdP and session-row checks.
- Treat the value as a root credential for the whole platform.

## Threat notes

- PKCE protects the code in the browser. The `redirect_uri` is checked at the IdP and the token is redeemed server to server.
- The ID token is read from a connection Maple opened itself, with `iss`, audience and `exp` checks against `MAPLE_OIDC_ISSUER`.
- The refresh token is stored encrypted in Postgres. It never reaches the browser.
- Session tokens are HMAC-signed bearer tokens. Whoever holds one can act as that person until it expires; the token is in `localStorage`, so a script injection in the dashboard can read it. The web app is served with a restrictive header set ([Security](/docs/self-hosting/multi-tenant/security)).
- A federated IdP with "Trust email" enabled can assert any email address and so could claim pending invitations. Do not enable it for IdPs you do not control.
- The `maple-admin` service account can edit users, including role assignment. See [Security](/docs/self-hosting/multi-tenant/security#the-maple-admin-service-account).
