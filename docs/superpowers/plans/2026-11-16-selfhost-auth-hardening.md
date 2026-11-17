# Self-hosted auth, email, status-page, security and docs hardening — plan v2

Status: v2, revised after an independent Opus 5.5 review (high effort). For user review; no code changed yet.
Builds on `2026-11-11-selfhost-multitenant.md`. Work in `maple/` (live tree, git branch `selfhost`, remote
`Msameim181/maple`, a public fork of `MapleTechLabs/maple`). `ashkarai-tutorial/server/maple` is a stale
snapshot: sync it last. Items marked **UNVERIFIED** were not confirmed by reading code or running it.

Checked by me after the review: git repo exists (branch `selfhost`); `changeMember` does not call any
membership revocation; compose sets `ELECTRIC_INSECURE: "true"`.

## 0. Root causes (verified unless marked)

| # | Symptom | Cause |
|---|---|---|
| 1 | Logout lets you back in | Logout only clears the token and loads `/sign-in` (`apps/web/src/shell/command.ts:159`, `page/onboarding/index.ts:279`). No IdP call; Keycloak SSO cookie stays. |
| 1b | Keycloak logout ignored by Maple | Renewal (`DirectoryService.ts:122`) never asks the IdP; TTL 15 min, max 12 h. Boot `CheckSession` only checks the HMAC. Workers verify statelessly (`packages/auth/src/index.ts:886`). |
| new | Root users never re-checked | `DirectoryService.ts:128` renews any root-role token without DB or IdP. Removing `maple-root` in Keycloak does nothing for up to 12 h. |
| 3 | Confirm link → "login failed" | PKCE state in `sessionStorage` (`oidc.ts`); link opens a new tab → "This sign-in expired". Also the `maple-web` client has no `baseUrl`. |
| 3b | Unverified users can sign in | `callback` (`DirectoryService.ts:315`) only skips invitation auto-join. |
| 3c/6 | New tab asks login; no tab sync | Token in `sessionStorage` (`auth-api.ts:14`). |
| 5 | Account → Keycloak | `MAPLE_OIDC_ACCOUNT_URL` card (`settings/account/*`). |
| 2 | Plain emails | Invitation is an inline string (`DirectoryService.ts:180`, already names the org). Alerts/digests already use `packages/email` templates. Keycloak theme has only `login/`. |
| 8a | No status link | `VITE_STATUS_PAGE_BASE_URL` empty in the self-host web build; no status host in Caddy/compose; Worker listens on 8706. |
| 8b | Uptime "pending" | No scraper service in compose; `SD_INTERNAL_TOKEN` unset so `/api/internal/uptime-results` answers 401. The API "Test" runs in-process, so it passes. The scraper also refuses private IPs, so internal targets can test 200 yet never go up. |
| log | `unused.invalid` DNS errors | Warehouse writes for the `ingest` purpose always go to managed Tinybird, so `audit_log` rows are silently lost. **Not fixed here**: separate plan, listed as a known gap. Billing 500 is noise. |

## 1. Extra defects found by the review (ranked)

1. **HIGH, UNVERIFIED live (spike S5): SSRF.** Uptime "Test" validates the URL string only; single-label hosts (`electric`, `keycloak`, `maple`) are not blocked and the local runtime allows private egress. With `ELECTRIC_INSECURE=true`, an engineer in any org could likely read cross-tenant rows via `http://electric:3000/v1/shape?...`.
2. **HIGH: member removal/demotion revokes nothing** in self-host (`changeMember`, `DirectoryService.ts:565`): API, CLI, MCP and device keys keep working. Check `deleteOrg` too.
3. **MEDIUM:** Keycloak `/admin` and `/realms/master` public on `AUTH_HOST`; no brute-force protection or password policy; no CSP/HSTS on `APP_HOST`; `/api/internal/*` reachable from the internet; `MAPLE_ROOT_PASSWORD` is the session HMAC key and is also passed to `ingest`.
4. **Draft bugs:** a 5-min TTL with the 5-min `RENEW_AHEAD` would renew on every request; use TTL 10 min, `RENEW_AHEAD` 2 min. A localStorage token shared across tabs lets tab A use tab B's org token under the wrong UI, so tabs must reload on `sub` **or** `org_id` change.
5. **LOW:** `redirect_uri` not pinned server-side; no `nonce`; ID token not signature-checked (token URL is plain `http://keycloak:8080`, so add `iss`/`aud`/`exp` checks); invitations never expire; no login rate limit.
6. **Refuted:** open redirect via `returnTo` (same-origin validator exists); invitation accepted on unverified email.

## 2. Decisions (revised)

1. **Session sync:** store the IdP refresh token encrypted per session; renewal refreshes at the IdP. `invalid_grant` → 401. IdP unreachable/5xx → fall back to membership-only renewal with a warning (a Keycloak outage must not log everyone out). Re-read realm roles from the refreshed token (fixes the root bypass). Logout is server-side: revoke the row, then POST `client_id` + `refresh_token` to Keycloak's logout endpoint (no `id_token_hint`, no confirmation page). Spike S1 first; fallback is storing `id_token` and an RP-initiated redirect. **Drop back-channel logout from v1** (stateless Workers cannot honor it before `exp`). Boot `CheckSession` calls refresh, so a reload follows an IdP logout immediately; open tabs follow within one TTL.
2. **Cross-tab:** `localStorage` + the `storage` event (house pattern), `navigator.locks` so one tab renews, one-time migration from `sessionStorage`. HttpOnly cookie deferred (auth deliberately refuses cookie credentials).
3. **IdP abstraction:** extend the existing `OidcClient` with `refresh` and `logout`; add one small `KeycloakAdmin` service (client `maple-admin`, `view-users` + `manage-users`). No full adapter layer.
4. **Verification link:** Keycloak cannot return the link. Offer **Resend** and **Mark verified**, IT-only (realm-wide effect; an org admin could otherwise enrol an account into every org that invited the address). Mark-verified also removes the `VERIFY_EMAIL` required action.
5. **Account page:** Maple shows profile, Maple sessions, "Sign out everywhere". Password / 2FA / profile edit use Keycloak Application-Initiated Actions (`kc_action=...`) in the Maple-styled login theme (spike S3). Optionally remove `manage-account` from default roles. IdP console link only for root.

## 3. Implementation phases

**Phase 0 – prep and spikes (no code).** `git switch -c selfhost-auth-hardening`; `pg_dumpall`. Spikes: S1 refresh then logout-by-refresh-token then second refresh must fail; S2 ID token has `sid`; S3 `kc_action=UPDATE_PASSWORD` returns to `/sign-in`; S4 `send-verify-email` with `client_id`+`redirect_uri` lands in Maple; S5 SSRF to Electric (throwaway stack only); S6 `curl maple:8706/s/<slug>` after publishing (KV shared? crons firing?). Security audit pass 1 read-only (section 4).

**Phase 1 – deploy/infra (#8 + quick security wins).**
- `Dockerfile`: `scraper` target (`FROM deps`, run `apps/scraper/src/main.ts`); `web-build` arg `PUBLIC_STATUS_URL` → `VITE_STATUS_PAGE_BASE_URL`.
- `docker-compose.yml`: `scraper` service (`MAPLE_API_URL=http://maple:8701`, `MAPLE_INGEST_URL=http://ingest:3474`, `SD_INTERNAL_TOKEN`); `maple` gets `SD_INTERNAL_TOKEN`, `MAPLE_STATUS_PAGE_BASE_URL`, `ELECTRIC_SECRET`; `electric` gets `ELECTRIC_SECRET` and loses `ELECTRIC_INSECURE` (plumbing UNVERIFIED, `apps/electric-sync/src/config.ts`); `caddy` gets `STATUS_HOST`; `MAPLE_ROOT_PASSWORD` removed from the `ingest` env.
- `Caddyfile` (+ `proxy/caddy/Caddyfile.host`, `proxy/nginx/maple.conf.template`, `docker-compose.host-proxy.yml`): `STATUS_HOST → maple:8706`; 404 on `/api/internal/*` at the API host; 404 on `/admin*` and `/realms/master*` at the auth host; HSTS, nosniff, referrer policy, `frame-ancestors 'none'`, CSP report-only first.
- `.env.example`, `gen-secrets.sh` (append missing secrets instead of refusing), `bootstrap.sh` (upgrade-safe `kc update` of client `baseUrl`/URIs; `bruteForceProtected`, `passwordPolicy`, SSO 2 h idle / 12 h max, `emailTheme=maple`; create confidential `maple-admin` client).

**Phase 2 – backend security fixes without sessions.**
- `changeMember`/`deleteOrg` call `MembershipRevocationService`.
- `lib/safe-fetch` `isPrivateHost`: reject dotless hostnames.
- `OidcClient`: pin `redirect_uri` to `MAPLE_APP_BASE_URL/sign-in`; check `iss` (new `MAPLE_OIDC_ISSUER`), `azp`/`aud`, `exp`; parse `refresh_token` and `sid`.
- `callback`: if `!emailVerified`, upsert user, accept no invitations, fail with new `DirectoryEmailNotVerifiedError`. No root exemption.
- Dedicated `MAPLE_SESSION_SECRET` falling back to the root password (touches `packages/auth`, electric-sync).

**Phase 3 – session core (#1, 1b, 3c, 6).**
- Migration: `directory_sessions` (id, user_id, idp_sid, refresh_token ciphertext/iv/tag, created_at, expires_at, refreshed_at, revoked_at; index user_id); no `org_id`. Secret slot `directory_sessions.refresh_token` + `RESEAL_TARGETS` + `docs/secret-encryption.md`.
- `packages/auth`: optional `sid` claim; `RenewSelfHostedSession` receives `sid`. TTL 10 min, `RENEW_AHEAD` 2 min.
- `makeDirectoryRenewal`: root-password `sub` unchanged (break-glass); OIDC token without `sid` → 401 (one re-login at rollout); row lock; revoked/expired → 401; IdP refresh as in decision 1; skip IdP call if refreshed < 30 s ago; roles re-read.
- API: `POST /api/auth/logout`, `POST /api/auth/logout-all`.
- Web: `auth-api.ts` localStorage + migration + `logout`; `session-bearer.ts` `navigator.locks`; `CheckSession` uses refresh; `subscription.ts` merges `storage` events; `update.ts` reloads on `sub`/`org_id` change or token removal; both LogOut commands call logout then `/sign-in` (clear locally if API unreachable).

**Phase 4 – registration/verification (#3).** Pending sign-in in localStorage keyed by state (10-min expiry); unknown `state` restarts authorize once (guard flag), never redeems without matching state; "Check your inbox" state; `KeycloakAdmin` (`listUnverified`, `resendVerification`, `markVerified`); root-only endpoints; "Pending verification" table on `/admin`; `DirectoryUser.emailVerified`.

**Phase 5 – account page and role help (#5, #4).** `BeginOidcSignIn` optional `action` (`kc_action`); Maple account card + Maple sessions + "Sign out everywhere"; IdP console link root-only. Members view shows each role's summary under the select; "What can each role do?" dialog generated from `Policy.permissions` (`packages/domain/src/policy/permissions.ts`) so copy cannot drift; explain `root` on `/admin`.

**Phase 6 – emails (#2).** New `invitation` template in `packages/email` (rebuild with its build script; org name, inviter, CTA); Keycloak `themes/maple/email/` (`theme.properties`, `html/template.ftl` layout override — UNVERIFIED on 26.4 —, messages with `${realmName}`, absolute-URL PNG logo); favicon in the login theme; Keycloak "organization name" = `REALM_DISPLAY_NAME` (no new var); `EMAIL_FROM` with a display name.

**Phase 7 – security audit pass 2 and fixes (#7).** Section 4.

**Phase 8 – docs and Pages (#9).** Section 5.

New env vars: `STATUS_HOST`, `SD_INTERNAL_TOKEN`, `ELECTRIC_SECRET`, `MAPLE_SESSION_SECRET`, `MAPLE_OIDC_ISSUER`, `MAPLE_OIDC_LOGOUT_URL`, `MAPLE_OIDC_ADMIN_URL`, `MAPLE_OIDC_ADMIN_CLIENT_ID`, `MAPLE_OIDC_ADMIN_CLIENT_SECRET`. Each goes in `.env.example`, `docker-compose.yml`, `gen-secrets.sh` (secrets), `packages/backend/src/platform/Env.ts`, `apps/api/src/resources/env.ts` (UNVERIFIED whether other Workers also need `packages/infra/src/env.ts`), and `configuration.md`.

## 4. Security plan (#7)

- **The skill** (`cloudflare/security-audit-skill`): per its README, an MIT agent skill with a six-phase audit (recon, hunt, validate, structured output, independent verification, report). I have **not** read `SKILL.md` or its validators. Run safely: do not `skills add --global` (user allowed this project only); clone into an empty directory outside the repo at a pinned commit; read every file first for shell/network/write instructions; scope to the auth flow file list (`packages/auth`, `services/{directory,auth}`, `routes/{auth,directory,uptime-internal,scraper-internal}.http.ts`, `apps/web/src/platform/{oidc,auth-api,session-bearer}.ts`, `page/sign-in`, `lib/safe-fetch`, `deploy/docker/{Caddyfile,docker-compose.yml,scripts/bootstrap.sh}`); output outside the repo; treat findings as leads to verify by hand.
- **Own checklist:** items in section 1, plus `state` never skipped, code stripped from history (done), HS256 pinned (done), Electric shape auth after `ELECTRIC_SECRET`.
- Documented risks: federated IdP "Trust email" can assert any address; `maple-admin` with `manage-users` could grant `maple-root`, so a compromised API becomes an escalation path.

## 5. Docs plan and GitHub Pages (#9)

- **Update:** `deploy/docker/README.md` (shrink to overview; fix the Keycloak-console and sign-in-pages sections; add status, scraper, new vars), `deploy/docker/proxy/README.md`, the 2026-11-11 spec (mark §4.2, §4.4, §4.6 superseded; it names `MAPLE_SESSION_SECRET` though code uses the root password), `ashkarai-tutorial/README.md` last. **Do not edit** `apps/landing/src/content/docs/self-hosting/*` (documents Maple Local, a different product; upstream merge friction).
- **Add** in `deploy/docker/docs/`: `index.md`, `install.md` (step by step: 6 DNS hosts, sizing, gen-secrets, SMTP, build, up, bootstrap, first org, verify, ingest test), `configuration.md` (every `.env` and container var: required, default, example, what breaks), `auth-and-sessions.md`, `status-and-uptime.md`, `operations.md` (backup, upgrade, rollback, rotation), `security.md`, `troubleshooting.md` (`unused.invalid`, billing 500, "couldn't reach the server", "This sign-in expired", pending monitors, private uptime targets).
- **GitHub Pages:** recommend MkDocs Material (`deploy/docker/mkdocs.yml`, `docs_dir: docs`, `site_url: https://msameim181.github.io/maple/`), built in CI only (no `bun.lock` change). Workflow `.github/workflows/selfhost-docs.yml`: push to `selfhost`, paths `deploy/docker/docs/**` + `mkdocs.yml`; permissions `pages: write`, `id-token: write`; steps setup-python, pinned `mkdocs-material`, `mkdocs build --strict`, `upload-pages-artifact`, `deploy-pages`. Repo settings: Pages source = GitHub Actions. Fork is public, so Pages is free; upstream's ~20 workflows will also run on the fork, so disable them in the fork's Actions settings rather than editing them. Custom domain: add `cname` + DNS and change `site_url`. Never put real hostnames or `.env` values in the docs. Rejected: the Astro landing app (paraglide, Cloudflare deps, `site: maple.dev`, republishes upstream marketing); Jekyll (weaker nav/search).

### v2.1 amendments (user review, 2026-11-17)
- **Token TTL is configurable.** New env `MAPLE_OIDC_SESSION_TTL_SECONDS` (default 600, clamped 120–3600) and `MAPLE_OIDC_SESSION_MAX_LIFETIME_SECONDS` (default 43200), read in `DirectoryService.ts` instead of the constants. The web app derives its renew-ahead from the token's own `iat`/`exp` (min(2 min, lifetime/4)), so no web env is needed. A root-only `/admin` "Session lifetime" setting (DB-backed, overrides env) is an optional add-on, about +1.5 h; default is env only.
- **Docs have one canonical source: the landing docs collection.** Write plain Markdown in `apps/landing/src/content/docs/self-hosting/multi-tenant/` (new group "Multi-tenant self-hosting", sits beside the existing single-container "Self-hosting" group; follow its frontmatter `title/description/group/order` and nav wiring in `src/lib/docs-nav.ts` / `docs-order.ts`). Pages: auth service options, environment reference, step-by-step install, how auth works (flow, sessions, logout), plus operations/security/troubleshooting and status/uptime. It then appears on maple.dev when upstream merges, and on the fork's own site.
- `deploy/docker/README.md` becomes a short quick start that links to those pages. No second copy of the content. GitHub Pages (MkDocs Material) reads the same folder via `docs_dir`, with a small build step that rewrites `/docs/...` links to relative ones. CI builds both the landing site and MkDocs so they cannot drift. Whether the landing build runs on the fork is spike S7 (UNVERIFIED).

## 6. Verification on a rebuilt stack
Rebuild: `docker compose build maple caddy scraper && docker compose up -d && ./scripts/bootstrap.sh …`.
1. Log out → "Sign in with SSO" shows the password form. End the session in Keycloak, reload Maple → `/sign-in`.
2. Invite email themed and names the org; Keycloak verify/reset mails themed with PNG logo.
3. Register in tab A, open the link in a new tab → lands signed in; unverified sign-in shows "Check your inbox"; `/admin` Resend and Mark verified work. A deep link in a new tab does not show sign-in.
4. Members shows role summaries and the dialog.
5. Change password via the account page and return to Maple; non-IT users never see the console link.
6. Two tabs: logout in A sends B to sign-in; sign in as user 2 in A reloads B as user 2; org switch in A reloads B.
7. Re-run S5 (rejected); `curl https://API_HOST/api/internal/uptime-targets` → 404; `/admin/` on the auth host → 404; headers present.
8. Publish a status page: link shows and `https://STATUS_HOST/s/<slug>` → 200; new monitor goes `pending` → `up`.
9. Follow `install.md` on a clean VM.
Tests (behaviour only, per `CLAUDE.md`): unverified callback fails with no invitation accepted; callback creates a session row; renewal fails after logout and on `invalid_grant`; renewal survives IdP outage; root dropped when refreshed token lacks `maple-root`; token without `sid` not renewable; removed member's API key rejected; org admin mark-verified forbidden; `http://electric:3000/` rejected by safe-fetch; new-tab sign-in by `state`; unknown `state` restarts once; `storage` event with another `org_id` reloads; `<script>` in org name rendered escaped; extend `deploy/docker/scripts/smoke-test.sh` (status 200, monitor leaves pending in 3 min, renewal 401 after logout, root-password login with Keycloak stopped).

## 7. Rollout, rollback, break-glass
- Rollout: `pg_dumpall`; `gen-secrets.sh` (append mode); set `STATUS_HOST` + DNS; build while the old stack runs; `docker compose up -d` (migration on boot via `runner/start.sh`); re-run `bootstrap.sh`. Downtime ≈ `maple` restart (UNVERIFIED); every OIDC user signs in once more.
- Rollback: check out the previous commit and rebuild; the new table is harmless; revert Keycloak settings by hand (`emailTheme`, default roles, client `baseUrl`); restore the dump if needed.
- Break-glass: root-password login stays untouched and exempt from renewal; the smoke test proves it works with Keycloak stopped; IdP-outage fallback prevents mass logout; Keycloak admin remains available through `docker compose exec keycloak kcadm.sh`.

## 8. Known gaps (not in this plan)
Audit-log and alerting warehouse writes to `unused.invalid` (needs routing to per-org ClickHouse; per-org `audit_log` schema presence UNVERIFIED) — separate plan. Back-channel logout and per-request revocation checks. HttpOnly cookie sessions.

## 9. Implementation status (2026-11-17, branch `selfhost-auth-hardening`, uncommitted)

Built in one session by parallel agents, then integrated and checked on a rebuilt local Docker stack (`*.localhost`, Playwright with certificate errors ignored, Mailpit for mail).

**Verified in the browser or with curl on the rebuilt stack**
- #1 Logout ends the Keycloak session: "Sign in with SSO" after logout shows the password form. Logout in one tab sends other tabs to sign-in.
- #1b Ending the user's Keycloak sessions makes the next Maple reload fail the refresh (401) and return to sign-in. A reload within 30 s of the last renewal is not re-checked (by design).
- #1 corner case: a logout with a token that expired minutes ago still ends the Keycloak session; the same token gets 401 on every other endpoint.
- #3 A verification link opened in a new tab lands on the sign-in page with a clear "not a member of any organization" message, not a failure. (The "Verify your email" notice in Maple appears only if an IdP lets an unverified address through; Keycloak blocks it first.)
- #3c New tab opens straight into the app (token in `localStorage`).
- #6 Logout in tab 1, sign in as another user: tab 2 reloads as the new user, not the old one.
- #4 Role summaries and the "What can each role do?" dialog (generated from `Policy.permissions`).
- #5 Maple account page (no Keycloak link for non-IT); "Change password" goes through Keycloak's application-initiated action and returns to `/settings/account` signed in.
- #3 Admin "Pending verification" lists unverified users from Keycloak; Resend sends the themed mail; Mark verified sets `emailVerified` and clears `VERIFY_EMAIL`.
- #2 Invitation email (org name, Maple look) and Keycloak verify/reset emails (themed). Subjects are generic because Keycloak passes no arguments to subjects.
- #8a Status page: publish shows `https://status.<host>/s/<slug>`; the public page loads. #8b An uptime monitor moved from `pending` to `up` after a real scraper check.
- Edge: `/api/internal/*` and Keycloak `/admin`, `/realms/master` return 404, including `;`, case and encoded variants (a `;` bypass found in review was fixed); security headers present.
- Tests: web 4561 pass; backend directory+auth 211 pass; auth 82; lint clean on all changed files; types clean for auth, backend, api, domain, web. Strict MkDocs build passes.

**Security review (static, guided by cloudflare/security-audit-skill methodology; not its full six-phase workflow)**
Fixed: removed members could mint CLI/MCP credentials with an old token (F1); `switchOrg` extended sessions without asking the IdP (F2); failed revocation could not be retried (F4); weak-fallback session key now warns (F7); `umask 077` in secret scripts (F6); Caddy/nginx `;` and case bypass (F9).
Open, documented in `security.md`: DNS-based SSRF in uptime "Test"/scrape targets/alert webhooks (F3; the pinned-IP fix does not work in workerd; use an egress rule or route the test through the scraper); ID token not signature-checked over the private compose network (F8); token in `localStorage` (F5); email change might keep the verified flag (F10, untested).

**Not done / not verified**
- Not run: the GitHub Pages workflow, the landing site build after the last doc edits, `ashkarai-tutorial/server/maple` sync (stale snapshot, left untouched), a clean-VM run of the install guide, the custom-domain Pages setup.
- Not verified live: Keycloak refresh-token rotation behaviour beyond what the tests above exercised, `electricsql/electric:latest` with `ELECTRIC_SECRET` under load, Keycloak email-change semantics.
- The `ingest` and `electric` secrets and the `unused.invalid` warehouse routing for audit-log/alerting writes are unchanged (separate plan).

**Update (2026-11-17): GitHub Pages now publishes the real Astro docs site, not MkDocs.** `.github/workflows/selfhost-docs.yml` builds `apps/landing` with `ASTRO_SITE`/`ASTRO_BASE` (the fork's `https://<owner>.github.io/<repo>/`), then `apps/landing/scripts/pages-base.mjs` prefixes the hand-written root-relative links in the built output. `Layout.astro`, `LanguageSwitcher`, `SeoHead` and `Breadcrumb` now strip the base before reading the locale (no-ops on maple.dev). The MkDocs config and script were removed. Checked locally: 1019 internal links resolve under `/maple/`, search and the sidebar work.
