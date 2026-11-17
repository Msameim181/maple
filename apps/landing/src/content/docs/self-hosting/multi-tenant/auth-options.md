---
title: "Auth service options"
description: "Keycloak is bundled and is the default. Any standards-compliant OIDC provider can replace it by configuration; what Maple needs and which features depend on Keycloak."
navLabel: "Auth options"
group: "Multi-tenant self-hosting"
order: 2
---

Maple does not store passwords. An identity provider (IdP) proves who a person is. Maple then decides which organizations they belong to and with what role.

| Option | Status |
|---|---|
| **Keycloak** (bundled) | Default. Everything in these docs is written for it and is what the install guide sets up. |
| **Another OIDC provider** (Authentik, Zitadel, Entra ID, Okta, Auth0, ...) | Supported by configuration, **not tested**. Some features degrade (see below). |
| **Root password** | Break-glass login for IT. Always available. Not a user directory. |
| **Clerk** | The hosted Maple cloud's sign-in. **Not used** in this mode. |

## Keycloak (bundled)

The `keycloak` service runs Keycloak 26 with its own `keycloak` database in the same Postgres server.

What it does here:

- Accounts, passwords, password reset, self-registration, email verification and 2FA.
- Optional federation to a company directory or a partner's IdP (Entra ID, Google, LDAP), added in the Keycloak admin console.
- Sessions: the IdP session decides whether a returning user can sign in without typing a password.

What `scripts/bootstrap.sh` sets up (and re-applies safely when you run it again):

- A realm named `maple`: self-registration on, email verification on, email as the username, password reset on, "remember me" on, duplicate emails off.
- The realm's SMTP settings, parsed from `SMTP_URL`, with `EMAIL_FROM` as the sender.
- The Maple login theme (`loginTheme=maple`) and the realm display name from `REALM_DISPLAY_NAME` (default `Maple`).
- A **public** client `maple-web`: authorization code flow with PKCE (S256), no direct access grants, redirect URI `https://APP_HOST/sign-in`, post-logout redirect URIs `https://APP_HOST/*`.
- A realm role `maple-root` for IT staff.
- The first IT admin user with a temporary password, and optionally the first organization.

### Themes

`keycloak/themes/maple` restyles the sign-in, registration, email-verification and password pages to look like Maple. Only IT, inside the Keycloak admin console, sees stock Keycloak. After you edit theme files, run `docker compose up -d --force-recreate keycloak`: Keycloak caches theme files in the container, so a plain restart keeps serving the old ones. Set `REALM_DISPLAY_NAME` before running `bootstrap.sh` to change the browser tab title.

## Another OIDC provider

Maple's directory code talks to the provider through plain OIDC endpoints configured by environment variables. It does not import any Keycloak library. To switch, you stop using the bundled `keycloak` service, create a client at your provider, and set the variables below on the `maple` service in `docker-compose.yml`.

**This is supported by configuration but has not been tested.** Treat a switch as a project: try it on a throwaway stack first.

### What your provider must offer

| Need | Why |
|---|---|
| Authorization code flow with **PKCE (S256)** for a **public** client (no client secret) | The dashboard signs people in from the browser |
| Redirect URI `https://APP_HOST/sign-in` registered exactly | Maple sends this value and the callback lives there |
| A post-logout redirect URI for `https://APP_HOST/*` | Return to Maple after sign-out |
| ID token with `sub`, `email` and `email_verified` | `sub` is the user id. Maple lowercases the email. People with `email_verified` not true cannot sign in |
| A **roles claim** carrying `maple-root` for IT staff | Maple reads the `realm_access.roles` array and a top-level `roles` array from the access token. The role name is set by `MAPLE_OIDC_ROOT_ROLE` (default `maple-root`) |
| A **refresh token** (`offline_access` is not needed, a normal refresh token is) | Maple renews its own session by refreshing at the provider, so removed or disabled users lose access |
| Issuer, authorization, token and end-session (logout) URLs | See the variables below |

### Variables

| Variable | Set it to |
|---|---|
| `MAPLE_OIDC_AUTHORIZE_URL` | The provider's authorization endpoint (opened in the browser, so it must be public) |
| `MAPLE_OIDC_TOKEN_URL` | The token endpoint (Maple calls it from the server, so an internal URL is fine) |
| `MAPLE_OIDC_CLIENT_ID` | The public client's id |
| `MAPLE_OIDC_ISSUER` | The exact `iss` value the provider puts in ID tokens |
| `MAPLE_OIDC_LOGOUT_URL` | The end-session endpoint, called by the server on sign-out |
| `MAPLE_OIDC_ROOT_ROLE` | The role name that marks IT staff, if not `maple-root` |
| `MAPLE_OIDC_ACCOUNT_URL` | A link to the provider's account page, shown to IT only |
| `MAPLE_OIDC_ADMIN_URL`, `MAPLE_OIDC_ADMIN_CLIENT_ID`, `MAPLE_OIDC_ADMIN_CLIENT_SECRET` | Keycloak Admin API access. Leave unset for another provider |

Directory sign-in is enabled only when both `MAPLE_OIDC_TOKEN_URL` and `MAPLE_OIDC_CLIENT_ID` are set. Details of every variable are in the [configuration reference](/docs/self-hosting/multi-tenant/configuration).

### What degrades without Keycloak

The server-side Keycloak Admin API is used for a few IT conveniences. A provider without that API loses them, and the rest of sign-in is unaffected.

| Feature | With Keycloak | With another provider |
|---|---|---|
| IT admin "Pending verification" list, **Resend** and **Mark verified** | Works through the `maple-admin` service account | Not available. Verify users in the provider itself |
| Account page actions (change password, set up 2FA) | Keycloak application-initiated actions (`kc_action`) bring the person back to Maple | Not available. IT links to the provider's own account page |
| Sign-out ends the IdP session too | Server calls Keycloak's logout with the refresh token | Works if the provider's end-session endpoint accepts a refresh token and client id. If not, the person may be signed back in silently |
| Themed sign-in, registration and verification emails | Maple theme | The provider's own look |
| `bootstrap.sh` | Creates realm, client, role, first IT user | Does not apply. Do these steps at your provider |

The "claims you need" and the session sync both assume a standards-compliant provider. Anything else is not covered.

## Root-password break-glass login

`MAPLE_ROOT_PASSWORD` works as a shared IT password. On the sign-in page, choose **Use root password**. It gives `root` access to every organization and does not need the IdP at all, so it still works if Keycloak is down.

- Keep `.env` readable by root only. `gen-secrets.sh` sets `chmod 600`.
- Rotating the value signs everyone out (see [Operations](/docs/self-hosting/multi-tenant/operations#rotating-secrets)).
- Use it for emergencies and for creating the first organization from a script, not for daily work.

## Clerk

Clerk is the sign-in used by the hosted Maple cloud (`MAPLE_AUTH_MODE=clerk`). The multi-tenant Docker deployment keeps the Workers in their `self_hosted` auth mode, and directory sign-in against your own IdP turns on as soon as the `MAPLE_OIDC_*` variables are set. Do not set Clerk variables.
