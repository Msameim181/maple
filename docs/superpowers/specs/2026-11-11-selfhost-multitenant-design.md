# Self-hosted, multi-tenant Maple (Docker + Keycloak) — design

Status: draft for approval · 2026-11-11 · branch `selfhost` on `Msameim181/maple`

## 1. Intent

Run one Maple instance on our own server for every department of our company (Finland) and for our
partners (Oman, Germany, UK). Each company or department is an **organization** with its own data,
its own users and its own admins. Later, some organizations move to their own local server.

Today this is not possible:

- Upstream deploys only to Cloudflare (Alchemy + Workers). It has no Docker path.
- Upstream's multi-user auth is Clerk, a hosted US SaaS. The only other mode, `self_hosted`, is one
  shared root password and one org.
- The community Docker fork (`tlvenn/maple @ f0a7114`) is three months old and still single-tenant.

## 2. Goals

1. **Docker deploy of current upstream.** `docker compose up` on one Linux VPS runs the full stack, and
   we can merge newer upstream versions without rewriting the deploy each time.
2. **Real accounts through an open-source IdP (Keycloak).** Per-user login, SSO, password reset and
   2FA all handled by Keycloak. No Clerk.
3. **Many organizations in one instance**, isolated from each other, with the four roles Maple already
   has: `member`, `engineer`, `admin`, plus `root` for IT.
4. **Two admin surfaces inside Maple:**
   - **IT (platform admin, `root`):** create, rename and delete organizations; add each org's first
     admin; see all orgs and users.
   - **Org admin (`admin`):** the existing *Settings → Members* page. Invite people, change their role,
     remove them.
5. **Per-org ingest.** Each org sends telemetry with its own ingest key and sees only its own data.
6. **A later split per country needs no redesign.** An org's data can move to another server.

## 3. Non-goals

These are deliberately not built, but nothing in the design blocks them later:

- Billing, plans and usage limits. Autumn stays unset, which means unlimited.
- Cloudflare-only features: the PR-review sandbox, Workers AI and the GitHub App.
- SCIM provisioning, or a SAML/LDAP setup UI inside Maple. Keycloak's own console does that.
- Org data regions and cross-region routing.
- High availability or a multi-node cluster. This is one VPS.

**Anti-goals** (the result counts as a failure even if it works):

- A big, hard-to-merge diff against upstream. Changes stay additive behind
  `MAPLE_AUTH_MODE=oidc` and a `deploy/docker/` folder, so `git merge upstream/main` stays cheap.
- Rewriting UI that already exists. The Members, Keys and Settings pages are reused.
- Any path where one org can read another org's data.

## 4. Design

### 4.1 Runtime: upstream Workers in Docker

Upstream Workers are alchemy-v2 Effect classes. Alchemy generates their entry modules, and there is
no `wrangler.jsonc` left (removed 2026-09-02). The fork's trick of running `wrangler deploy
--dry-run`, then Miniflare, does not carry over unchanged. See §8 for the inventory.

**Step 0: a 2–3 day spike that decides the route:**

- **R1, preferred:** add a `selfhost` stage profile to `alchemy.run.ts` that builds the Worker
  bundles (`.alchemy/bundles/*`) **without Cloudflare/AWS credentials**. A small `deploy/docker/runtime.ts`
  then runs them under Miniflare, using the fork's `deploy/workerd/runtime.ts` (266 lines) as the
  model:
  - Postgres through `hyperdrives: { MAPLE_DB: pgUrl }`
  - local Durable Objects (`ChatSession`), Queues (5 + DLQ), Workflows, KV, R2, rate limiters
  - crons fired by the runner
  - migrations on boot

  Workers in the container: `api`, `ai`, `alerting` and `electric-sync` are required, because api
  and alerting bind `ChatSession` from `ai`. `status` and `chat-bot` are optional.
- **R2:** if alchemy cannot bundle offline, extract the generated entry per Worker once and commit
  it under `deploy/docker/entries/`. This costs more per upstream merge.
- **R3, fallback:** build on the Docker fork `tlvenn/maple @ f0a7114`. It runs today, but it is three
  months behind and its web is the older React app. The auth work still applies, with different web
  files.

Whatever the route:

- **Web** is served as a static SPA. A Caddy `reverse_proxy` replaces the Worker's `/_api` proxy. The
  `/share/*` OG previews and the chart images in notifications are not available in v1.
- **Alerting** needs `MAPLE_ALERTING_ALLOW_NONPROD=1`.
- **Email:** upstream sends only through Cloudflare's `send_email` binding, which is a no-op locally.
  The runner provides a tiny `EMAIL` stand-in that relays to an SMTP server (`SMTP_URL`). Without
  it, alert email is off; Slack, Teams-webhook, Telegram and PagerDuty still work.
- **Miniflare** is bumped to a release that supports the compatibility date `2026-10-01`.

### 4.2 Identity: Keycloak

- **Keycloak 26** in compose, using its own database in the same Postgres server.
- Realm `maple`, with one **public** OIDC client `maple-web` (authorization code + PKCE). Redirect to
  `PUBLIC_APP_URL`.
- Keycloak does users, passwords, email verification, 2FA, sessions, and federation to company AD or
  Google if wanted. Maple's account pages (profile, password, 2FA, sessions) link to the Keycloak
  account console instead of being rebuilt.
- One realm role, `maple-root`, marks IT staff. It appears in the token as `realm_access.roles`.

**Decision: org membership lives in Maple's Postgres, not in Keycloak Organizations.** Keycloak 26
does fully support Organizations. They were considered and rejected for these reasons:

| | Keycloak Organizations | Maple-owned membership (chosen) |
|---|---|---|
| Per-org roles (member/engineer/admin) | Not native. Needs org groups (26.6+) plus a custom token mapper | One column |
| Members page | Every list, invite or role change calls the Keycloak Admin API, with a service-account secret in Maple | Plain Postgres queries |
| Other IdPs (Authentik, Zitadel, Entra) | Locked to Keycloak | Any OIDC provider works |
| Moving an org to a regional server | Its membership is split across two systems | Rows move with the org's other rows |

Keycloak answers *who is this person*. Maple answers *which orgs they belong to, and with what role*.

### 4.3 Data model (new tables, `packages/db/src/tables/`)

```
orgs              (id text pk, name, created_at, created_by)
org_members       (org_id fk, user_id, role  -- 'member'|'engineer'|'admin',  created_at,  pk(org_id,user_id))
org_invitations   (id, org_id fk, email citext, role, invited_by, created_at, accepted_at null,  unique(org_id,email) where pending)
users             (id text pk = OIDC sub, email, name, last_seen_at)   -- upserted on each sign-in; feeds member lists
```

- `orgs.id` is a readable slug, for example `ashkar-fi` or `partner-om`. It is the `OrgId` written on
  every telemetry row, so it is permanent.
- These tables are used only when `MAPLE_AUTH_MODE=oidc`. Clerk mode is untouched.

### 4.4 Request auth: `MAPLE_AUTH_MODE=oidc`

**Token exchange (builder's call, after review).** The Keycloak token proves *who*; Maple then mints
its own short-lived session token that says *which org, which role*. This reuses the existing
`self_hosted` session-token code (`verifySelfHostedSessionToken`: HMAC, `org_id`/`sub`/`roles`
claims, refresh endpoint), signed with a new `MAPLE_SESSION_SECRET` instead of the root password.

The flow:

1. `POST /api/auth/oidc/exchange`, with the Keycloak access token as the bearer and an optional
   `x-maple-org-id` header:
   - Verify the JWT against the IdP's JWKS (from `OIDC_ISSUER` discovery, cached). Check `iss`,
     `aud`/`azp`, `exp` and the signature, using WebCrypto RS256/ES256 in the style of the existing
     `services/auth/device/jose.ts`, with no new server dependency.
   - `userId = sub`. `root` if the realm roles include `maple-root`.
   - Upsert `users`, and accept any pending invitations (see below).
   - Pick the org:
     - the header's org, if the user has an `org_members` row for it (`root`: any org);
     - otherwise the user's only org;
     - otherwise the existing "no active organization" error, so the web app shows the org picker.
   - Return a Maple session token: `{sub, org_id, roles}`, **15-minute TTL**.
2. The web app calls exchange again on refresh and on org switch. A removed member therefore loses
   access within 15 minutes.
3. Every Worker (`api`, `electric-sync`, `alerting`, `ai`) verifies the Maple token through the
   existing self-hosted branch of `makeResolveTenant`, generalised to `self_hosted | oidc`.
   `electric-sync` needs no database, so its upstream code is unchanged.

API keys, MCP and ingest keys keep working unchanged: they are already org-bound rows in Postgres.

Invitations: on sign-in, a user whose **verified** email (`email_verified=true`) matches pending
invitations is added to those orgs and the invitations are marked accepted. Nothing else assigns
membership automatically.

### 4.5 Backend services

- `OrgMembersService`, `OrganizationService` (org identity, create/delete), and email lookup (digest,
  alert email) get an **oidc implementation that reads the new tables** instead of calling Clerk.
  Choose by auth mode, the way the code already switches on `clerk` / `self_hosted`.
- New HTTP endpoints, protected by the existing `Policy.check`:
  - `GET /api/me`: user, orgs and roles. Feeds the org switcher.
  - Org admin (`admin` in that org): list members, change role, remove member, list/create/revoke
    invitations.
  - IT (`root`): list/create/rename/delete orgs, list users, add a user to an org with a role.
- Deleting an org reuses the existing `OrganizationService` purge of org-scoped rows.

### 4.6 Web (`apps/web`, Foldkit)

- **Sign-in:** an OIDC code+PKCE flow using `oidc-client-ts` (one small, standard dependency; not
  hand-rolled auth). The token is kept in memory with silent refresh, and sent as a bearer token.
  `x-maple-org-id` is set from the selected org.
- **Org switcher:** uses the existing org-picker / `org-required` surfaces, fed by `GET /api/me`.
- **Settings → Members:** same view, with the data layer switched from Clerk JS to the new endpoints
  (`page/settings/members/update.ts`). The invite form is unchanged.
- **Settings → Account:** one card, "Manage your account", linking to the Keycloak account console.
  The Clerk-only subpages are hidden in oidc mode.
- **Admin page (`/admin`)**, visible to `root` only, built from existing kit components:
  - Organizations table: create, rename, delete, open members.
  - Users table: email, name, orgs, last seen.

  Nothing more.
- Clerk-only onboarding cards are hidden in oidc mode.

### 4.7 Ingest

- Replace the kit's plain otel-collector with Maple's own Rust gateway (`apps/ingest`). It already
  resolves each request's ingest key to its org from Postgres (`INGEST_KEY_STORE_BACKEND=postgres`).
  The two encryption keys are the same ones the API uses. Autumn unset means no limits; this is
  verified in the code.
- **Per-org warehouse row.** The env-level ClickHouse config is single-org only. For many orgs,
  each org needs an `org_clickhouse_settings` row (the existing "bring your own ClickHouse" feature)
  pointing at our shared ClickHouse. Then:
  - API reads route per org.
  - The gateway writes straight to ClickHouse, including session replay and product events. These
    return 503 in `forward` mode.

  When IT creates an org, the existing `OrgClickHouseSettingsService` provisions this row with the
  server's ClickHouse credentials. The schema is applied once, at deploy time.
- Orgs create and roll keys in the existing *Settings → Keys* page.
- Ports 4317/4318 sit behind Caddy TLS. Requests need a valid key, so open internet ingest from
  partners is safe.

### 4.8 Deploy: `deploy/docker/`

```
caddy        TLS (Let's Encrypt) for app., api., ingest. hostnames
web          static SPA (nginx or caddy file_server)
workerd      api + alerting + electric-sync (+ ai if feasible) under Miniflare
ingest       Rust gateway
keycloak     26.x, realm import file (realm, client, maple-root role) applied on first boot
postgres     maple db + keycloak db
electric     ElectricSQL
clickhouse   + one-shot schema migrate
```

Also in `deploy/docker/`:

- `.env.example` and `scripts/gen-secrets.sh`
- `scripts/bootstrap.sh`, which creates the first org and the first IT user
- `scripts/smoke-test.sh`, which runs two orgs and two users and proves each sees only its own data
- `README.md`: install, operate, backup, upgrade from upstream

### 4.9 Future per-country split

Every Postgres and ClickHouse row carries `OrgId`. Moving `partner-om` to a server in Oman means:

1. Deploy the same compose stack there.
2. Export that org's rows.
3. Point its users at the new URL. The same Keycloak, or a regional one, works, because `sub` stays
   stable within a realm.

Maple's per-org ClickHouse setting (`org_clickhouse_settings`) also allows a softer step first: keep
one shared dashboard but store that org's telemetry on a ClickHouse in Oman.

## 5. Constraints

- Upstream-merge friendly: new code goes in new files where possible, and behaviour is switched by
  `MAPLE_AUTH_MODE=oidc`.
- Follow repo conventions (`CLAUDE.md`): Effect services and layers, Effect Schema, typed errors,
  effect-orm migrations, the Foldkit kit for UI, and tests that assert behaviour.
- One VPS: 8 vCPU / 16 GB RAM / 200 GB SSD suggested for the shared instance.

## 6. Left to the builder

- The exact Miniflare/workerd wiring, guided by the fork's `deploy/workerd`.
- The JWKS cache TTL, and clock-skew leeway (60s default).
- Whether `web` is served by nginx or by Caddy directly.
- Invitation emails: v1 shows a copyable sign-in link to the admin. Keycloak sends its own emails
  (verification, reset) when SMTP is configured in Keycloak.

## 7. Risks

- **Upstream drift.** Auth and the web shell change often upstream. Mitigation: the change set is small
  and additive, and CI runs a merge-and-test of `upstream/main` weekly.
- **Cloudflare-only bindings** (see §8). Features with no local equivalent are switched off in Docker
  mode and listed in the README.
- **Partner identity.** Partners' users live in our Keycloak, so password policy and 2FA are our
  responsibility. Enforce 2FA for `admin` and `root` in Keycloak.

## 8. Docker feasibility of upstream

Verdict: **feasible, medium-to-large.** Upstream binding inventory as of `1e96be8a1`:

| Worker | Bindings | Local (Miniflare) | Needed |
|---|---|---|---|
| api | Hyperdrive, 5 queues + DLQ, R2×2, KV, 6 rate limiters, `send_email`, `ChatSession` DO (from ai), Workflow `ClickHouseSchemaApplyWorkflow`, 2 crons, service bindings `AI_WORKER`/`API_SELF` | All except `send_email` delivery | core |
| ai | `ChatSession` DO (SQLite), `SecurityAuditWorkflow`, Hyperdrive, rate limiters, `SANDBOX` (optional), `CODE_LOADER` (WorkerLoader, unverified), AI Gateway (prd only) | Core yes; LLM through OpenRouter | core (api binds its DO) |
| alerting | Hyperdrive, `send_email`, `ChatSession`, KV, R2, 4 crons | yes | core |
| electric-sync | env only | yes | core |
| status | KV, R2, rate limiter | yes | optional (status pages) |
| chat-bot | DOs `ConnectorSocket`/`ConnectorRelay`, Hyperdrive, cron | yes | optional |
| sandbox | Cloudflare Containers | **no** | off |
| web | static assets + `/_api` proxy | static + Caddy | core |
| ingest (Rust), electric, scraper | containers already (AWS ECS upstream) | yes | ingest + electric core |

Off in Docker mode:

- PR-review sandbox, AI Gateway / Workers AI, billing
- GitHub/PlanetScale sync, unless their env vars are configured
- `/share` OG previews

Not yet verified (the Step-0 spike answers these): offline alchemy bundling, and WorkerLoader in Miniflare.

## 9. Open questions (owner decides)

1. **Keycloak Organizations or Maple-owned membership.** The owner asked for Keycloak Organizations
   if available. They are available, but §4.2 recommends Maple-owned membership.
2. **Partner onboarding.** Does Keycloak get SMTP from day one, and is self-registration (with email
   verification) on? Or does IT create every account?
3. **AI features.** Are investigations, chat and the MCP agent in scope? They send telemetry to an
   external LLM (OpenRouter).
4. **Deleted orgs.** Should a deleted org's ClickHouse telemetry be purged, and its slug blocked from
   reuse? Without either, a new org that reuses the slug would see the old org's data.

## 10. Phases and estimate

Units are focused working days for one experienced TypeScript/DevOps engineer working with an AI
assistant. Ranges cover the unknowns above.

| # | Phase | Output | Days |
|---|---|---|---|
| 0 | Spike: offline alchemy bundles, Miniflare bump, `ChatSession` + queue under Miniflare | R1/R2/R3 decision | 2–3 |
| 1 | Docker runtime: runner, compose, Caddy TLS, static web, ingest gateway, ClickHouse schema, Keycloak + realm import | Single-org stack up on the VPS (still `self_hosted` auth) | 6–9 |
| 2 | OIDC backend: tables + migration, JWT/JWKS verify, tenant resolution, invitations, oidc service impls, `/api/me`, members and admin endpoints, tests | API multi-tenant | 5–7 |
| 3 | Web: OIDC login, org switcher, Members rewire, Account card, `/admin` page, Clerk-only surfaces hidden | UI multi-tenant | 6–8 |
| 4 | Per-org ClickHouse row on org create, bootstrap script, two-org isolation smoke test | Isolation proven | 2–3 |
| 5 | SMTP `EMAIL` stand-in (alert email, optional) | Email alerts | 1–2 |
| 6 | README / `deploy/docker/README.md`, upgrade procedure, weekly upstream-merge CI check | Docs | 2 |
| 7 | VPS rollout, partner onboarding dry-run, fixes | Production | 3–5 |
| | **Total** | | **27–39 days ≈ 6–8 weeks** |

Ongoing: merging upstream costs about 0.5–1 day per month while upstream keeps its current pace.
Route R3 (the fork) saves about 3–4 days in phase 1 but loses three months of upstream features and
makes future merges harder.
