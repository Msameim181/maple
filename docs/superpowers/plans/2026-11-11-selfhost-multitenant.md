# Self-hosted multi-tenant Maple Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run current upstream Maple from Docker Compose on one VPS, with Keycloak (OIDC) accounts, many isolated orgs, an IT admin page and per-org member admin.

**Architecture:**

- A `maple` container runs alchemy's own local runtime (`alchemy dev`, workerd) under a `selfhost`
  profile, next to Postgres, Electric, ClickHouse, Keycloak, the Rust ingest gateway and Caddy.
- Auth stays on the existing `self_hosted` session-token path, which every Worker already trusts.
  A new OIDC callback endpoint redeems the Keycloak code server-to-server and mints that same token
  carrying the user's real `sub`, `org_id` and role.
- Org membership lives in Postgres.
- Each org gets its own ClickHouse database and user through the existing bring-your-own-ClickHouse
  feature. That gives database-enforced isolation, and purging an org becomes a `DROP DATABASE`.

**Tech Stack:** Bun 1.4.4, Effect 4, effect-orm (Postgres), Foldkit (web), alchemy 2 local runtime,
Keycloak 26, ClickHouse 25, Caddy 2.

**Spec:** `docs/superpowers/specs/2026-11-11-selfhost-multitenant-design.md`

## Global Constraints

- Every change is additive and switched on by env (`MAPLE_SELFHOST=1`, `MAPLE_OIDC_*`). With those
  unset, upstream behaviour is byte-for-byte unchanged.
- Repo conventions from `CLAUDE.md`:
  - Effect Schema, `Schema.TaggedError` with namespaced tags, no throws
  - every warehouse query filters `OrgId`
  - effect-orm tables plus a generated migration
  - Vitest via `bun run test`
- Roles in session tokens use Clerk-style keys: `org:member`, `org:engineer`, `org:admin`, and `root`
  for IT (`packages/domain/src/policy/roles.ts`).
- Org ids are slugs matching `^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$`, and are permanent while the org
  exists.
- Minted OIDC session token: `exp` = now + 15 min, `session_exp` = now + 12 h. Refresh re-checks
  membership.
- No new npm dependency, except `nodemailer` in the deploy runner if it isn't already present.

## Review Focus

1. **A member removed from an org keeps a valid token.** The next refresh (≤15 min) must fail with
   401. Test in Task 3.
2. **Org switch to an org the user doesn't belong to.** Must return 403 and never mint. `root` may
   switch anywhere. Test in Task 3.
3. **Invitation sent to an email the IdP reports unverified.** Must not be accepted. Test in Task 3.
4. **Deleting an org, then re-creating the same slug.** The new org sees zero telemetry rows, because
   its ClickHouse database is new. Covered by the smoke test in Task 6.
5. **Raw SQL from org A.** It runs only against org A's database, so the BYO route is used and never
   the shared credential. Covered by Task 4's provisioning test and the Task 6 smoke test.

---

## API contract (shared by Tasks 3 and 5)

New file `packages/domain/src/http/directory.ts`.

**`DirectoryPublicApiGroup`**, prefix `/api/auth`, no auth middleware:

- `GET /oidc/config` → `OidcConfigResponse { enabled: boolean, authorizeUrl: string, clientId: string, accountUrl: string }`
- `POST /oidc/callback`, payload `OidcCallbackRequest { code, codeVerifier, redirectUri, orgId?: OrgId }`
  - success: `SelfHostedLoginResponse`
  - errors: `UnauthorizedError` (401), `NoOrganizationError` (409: signed in, but member of no org)

**`DirectoryApiGroup`**, prefix `/api/directory`, middleware `Authorization`:

- `GET /me` → `MeResponse { user: DirectoryUser, isRoot: boolean, activeOrgId: OrgId, orgs: Array<{ id: OrgId, name, role: AssignableRoleKey }> }`
- `POST /switch-org`, payload `{ orgId }` → `SelfHostedLoginResponse`; errors 403
  `DirectoryForbiddenError`
- Org admin (`org:admin` or `root`):
  - `GET /members` → `{ members: Array<{ user: DirectoryUser, role }>, invitations: Array<{ id, email, role, createdAt }> }`
  - `PATCH /members/:userId` `{ role }`
  - `DELETE /members/:userId`
  - `POST /invitations` `{ email, role }`
  - `DELETE /invitations/:id`
- IT (`root`):
  - `GET /orgs` → `{ orgs: Array<{ id, name, status: "active"|"deleting", memberCount, createdAt }> }`
  - `POST /orgs` `{ id, name, adminEmail }`
  - `PATCH /orgs/:orgId` `{ name }`
  - `DELETE /orgs/:orgId`
  - `GET /users` → `{ users: Array<DirectoryUser & { orgs: Array<{ id, role }> }> }`

Shared types:

- `DirectoryUser { id: UserId, email: string, name: string | null, lastSeenAt: IsoDateTimeString | null }`
- `AssignableRoleKey = "org:member" | "org:engineer" | "org:admin"`
- Errors: `DirectoryForbiddenError` (403), `DirectoryNotFoundError` (404), `DirectoryConflictError`
  (409), `DirectoryValidationError` (400), `DirectoryPersistenceError` (503).

Both groups are added to `MapleApi` (`packages/domain/src/http/api.ts`), the stable `/api`
surface, so the web reaches them with the same `HttpApiClient.make(MapleApi)` it uses for login.

---

### Task 1: `selfhost` stack profile

**Files:**
- Modify: `alchemy.run.ts`
- Modify: `packages/infra/src/dev-urls.ts`, if fixed ports live there

**Interfaces:**
- Produces: with `MAPLE_SELFHOST=1 ALCHEMY_LOCAL_STATE=1 alchemy dev --stage selfhost`, the api,
  ai, alerting, electric-sync, chat-bot and status Workers listen on fixed ports. The api listens on
  `0.0.0.0:3472` and electric-sync on `3476`.
  - No floci (AWS emulator) container.
  - No portless route.
  - No `app` (web) vite server.

Steps:

- [ ] When `MAPLE_SELFHOST=1`, skip `Acm.providers`, `AWS.providers()` and `Portless.providers()`, and
  do not create `Portless.Route`s. Workers bind fixed ports (`MAPLE_SELFHOST_PORT_<APP>`, defaults
  api 3472, electric-sync 3476).
- [ ] Verify: run the stack locally against the dev Postgres. Expect `curl localhost:3472/health` → `OK`
  and `docker ps` showing no `alchemy-floci`.
- [ ] Commit `feat(selfhost): alchemy selfhost stage profile`.

### Task 2: `deploy/docker` stack

**Files:**
- Create: `deploy/docker/Dockerfile` (maple runtime image)
- Create: `deploy/docker/web.Dockerfile` (vite build, served by Caddy)
- Create: `deploy/docker/docker-compose.yml`
- Create: `deploy/docker/Caddyfile`
- Create: `deploy/docker/keycloak/realm-maple.json`
- Create: `deploy/docker/.env.example`
- Create: `deploy/docker/scripts/gen-secrets.sh`
- Create: `deploy/docker/runner/mail-relay.ts`

**Interfaces:**
- Consumes: Task 1 profile.
- Produces: `docker compose up -d` serves:
  - `https://${APP_HOST}`: web
  - `https://${API_HOST}`: api
  - `https://${SYNC_HOST}`: electric-sync
  - `https://${AUTH_HOST}`: Keycloak
  - `https://${INGEST_HOST}`: ingest gateway (OTLP/HTTP)

Steps:

- [ ] **Runtime image:** bun 1.4.4, `bun install --frozen-lockfile`, `bun run alchemy:build-deps`.
  On boot it runs the Postgres migrations, then `alchemy dev --stage selfhost` with local state in
  `/data`.
- [ ] **Compose services:** `postgres:17` (`wal_level=logical`, databases `maple` + `keycloak`),
  `electricsql/electric`, `clickhouse/clickhouse-server`, `keycloak/keycloak:26`
  (`start --import-realm`), `ingest` (built from `apps/ingest/Dockerfile`), `maple`, `web`, `caddy`.
- [ ] **Realm export:**
  - realm `maple`, registration on, verify email on, SMTP from env
  - public client `maple-web` with redirect `https://${APP_HOST}/*`
  - realm role `maple-root`, in the access token's `realm_access.roles`
- [ ] **Mail relay:** watches the local email directory and sends each `.eml` through `SMTP_URL`,
  deleting it on success.
- [ ] **Ingest env:**
  - `INGEST_KEY_STORE_BACKEND=postgres`
  - `MAPLE_PG_URL`, and the same two ingest-key secrets as the API
- [ ] **Verify:** `docker compose up -d`, then `curl https://${API_HOST}/health` → `OK`. The Keycloak
  realm page loads.
- [ ] Commit `feat(selfhost): docker compose deployment`.

### Task 3: Directory backend (tables, OIDC callback, members, orgs)

**Files:**
- Create: `packages/db/src/tables/directory.ts` (tables `directory_orgs`, `directory_members`,
  `directory_invitations`, `directory_users`), exported from the tables index, plus the generated
  migration
- Create: `packages/domain/src/http/directory.ts` (the API contract above)
- Modify: `packages/domain/src/http/api.ts`
- Modify: `packages/auth/src/index.ts`: export
  `mintSessionToken(claims: { sub: string; orgId: string; roles: ReadonlyArray<string>; ttlSeconds: number; sessionExpSeconds: number }, secret: string): string`
- Create: `packages/backend/src/services/directory/DirectoryService.ts`
- Create: `packages/backend/src/services/directory/OidcClient.ts`: a code→tokens exchange against
  `MAPLE_OIDC_TOKEN_URL`, decoding the id/access token payloads. Tokens arrive directly from the
  token endpoint, so the signature is not re-verified (OIDC Core §3.1.3.7).
- Create: `apps/api/src/routes/directory.http.ts`, wired where `auth.http.ts` groups are wired
- Modify: `packages/backend/src/services/auth/AuthService.ts`: when OIDC is configured, `refresh` of an
  OIDC session re-checks `directory_members` (`root` skips the check). Not a member →
  `UnauthorizedError`.
- Modify: `packages/backend/src/platform/Env.ts`: optional `MAPLE_OIDC_AUTHORIZE_URL`,
  `MAPLE_OIDC_TOKEN_URL`, `MAPLE_OIDC_CLIENT_ID`, `MAPLE_OIDC_ACCOUNT_URL`, `MAPLE_OIDC_ROOT_ROLE`
  (default `maple-root`). OIDC is enabled iff the token URL and client id are set.
- Test: `packages/backend/src/services/directory/DirectoryService.test.ts`, using PGlite
  `createTestDb()` and a fake `OidcClient` layer

**Interfaces:**
- Produces: `DirectoryService` methods matching each endpoint.
- `callback(input)`:
  - upsert the user
  - accept pending invitations when `email_verified === true`
  - pick the org: requested org if member (root: any active org), else the oldest membership
  - mint a token signed with `MAPLE_ROOT_PASSWORD`

Tests:

- [ ] `callback mints a token for the only org`: roles `["org:admin"]`, `org_id` `"acme"`.
- [ ] `callback with no membership fails NoOrganizationError`.
- [ ] `verified email accepts pending invitation`.
- [ ] `unverified email leaves invitation pending`.
- [ ] `root may select any org`.
- [ ] `switchOrg to non-member org fails DirectoryForbiddenError`.
- [ ] `refresh check after removal fails`.
- [ ] `member cannot manage members`.
- [ ] `last admin cannot be demoted or removed`.
- [ ] Run the tests. Expect PASS. Commit.

### Task 4: Org lifecycle (ClickHouse provisioning, purge)

**Files:**
- Create: `packages/backend/src/services/directory/OrgProvisioner.ts`
- Modify: `packages/backend/src/services/org/OrgClickHouseSettingsService.ts:596`. Allow `http:` when
  the URL's origin equals `MAPLE_SELFHOST_CLICKHOUSE_URL`'s origin.
- Test: `packages/backend/src/services/directory/OrgProvisioner.test.ts`, with a fake ClickHouse admin
  executor

**Interfaces:**
- Produces:
  - `provision(orgId)` runs `CREATE DATABASE org_<id>` → `CREATE USER` → `GRANT ALL ON org_<id>.*` →
    BYO upsert → `applySchema`.
  - `purge(orgId)` runs the existing Postgres purge → `DROP DATABASE` → `DROP USER` → delete the BYO
    row → delete the directory org row.

Tests:

- [ ] `provision issues create database, user, grant in order, then upserts BYO with database org_acme`.
- [ ] `purge drops database and user and removes org row; slug then reusable`.
- [ ] `create org rejects slug of an org still deleting`.

### Task 5: Web (OIDC sign-in, org switcher, members, admin)

**Files:**
- Create: `apps/web/src/platform/oidc.ts` (PKCE begin and complete; state and verifier in
  sessionStorage)
- Modify: `apps/web/src/page/sign-in/*`: SSO button when `/api/auth/oidc/config` reports enabled;
  handle `?code=&state=`; save the token; keep the root-password form
- Modify: `apps/web/src/page/settings/members/*`: directory source when enabled
- Create: `apps/web/src/page/admin/*`: `/admin`, root only; orgs table (create, rename, delete) and
  users table
- Org switcher (`me.orgs` → `switch-org` → save token → reload)
- Account link to `accountUrl`

Steps:

- [ ] Scene tests:
  - SSO button shown when enabled
  - callback saves the token
  - Members page lists directory members
  - Admin page hidden for non-root
- [ ] `bun typecheck` and the web tests pass. Commit.

### Task 6: Smoke test, docs, push

**Files:**
- Create: `deploy/docker/scripts/bootstrap.sh` (Keycloak IT user with `maple-root`, first org)
- Create: `deploy/docker/scripts/smoke-test.sh`:
  - two orgs, each with its own ingest key; one span each
  - each org sees only its own span
  - delete one org, re-create the slug: zero rows
- Create: `deploy/docker/README.md`
- Modify: root `README.md` status row

Steps:

- [ ] Run `smoke-test.sh` against the local compose: `PASS` per check. Commit, push.
