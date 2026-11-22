import { afterEach, assert, describe, it } from "@effect/vitest"
import { EdgeCacheService, type EdgeCacheServiceApi } from "@maple/cache"
import {
	CreateOrgRequest,
	DirectoryConflictError,
	DirectoryNotFoundError,
	OrganizationAccessDeniedError,
	DirectoryEmailNotVerifiedError,
	DirectoryForbiddenError,
	NoOrganizationError,
	OidcCallbackRequest,
	OrgId,
	RoleName,
	type TenantContext,
	UnauthorizedError,
	UserId,
} from "@maple/domain/http"
import { mintSessionToken, selfHostedSessionKey } from "@maple/auth"
import { ConfigProvider, Effect, Exit, Layer, Option, Redacted, Schema, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/testing/test-pglite"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { MembershipRevocationService } from "@maple/backend/services/auth/MembershipRevocationService"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { CliDeviceAuthService } from "@maple/backend/services/auth/CliDeviceAuthService"
import { McpOAuthService } from "@maple/backend/services/auth/McpOAuthService"
import { DirectoryService } from "./DirectoryService"
import { EmailService } from "@maple/backend/platform/EmailService"
import {
	OidcClient,
	type OidcIdentity,
	type OidcRefreshed,
	OidcRefreshRejectedError,
	OidcUnavailableError,
} from "./OidcClient"
import { OrgProvisioner } from "./OrgProvisioner"

/** The default `MAPLE_OIDC_SESSION_TTL_SECONDS`. */
const OIDC_TTL_SECONDS = 600

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const NOW_MS = Date.UTC(2026, 10, 11, 9, 0, 0)
const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asRole = Schema.decodeUnknownSync(RoleName)
const ACME = asOrgId("acme")
const GLOBEX = asOrgId("globex")

/** The root-password operator, as its session resolves. */
const ROOT: TenantContext = {
	orgId: asOrgId("default"),
	userId: asUserId("root"),
	roles: [asRole("root")],
	authMode: "self_hosted",
}

const identity = (
	code: string,
	sub: string,
	email: string,
	overrides: Partial<OidcIdentity> = {},
): OidcIdentity => ({
	sub,
	email,
	emailVerified: true,
	name: sub,
	roles: [],
	refreshToken: `rt-${code}`,
	...overrides,
})

/** Codes the fake IdP redeems: `<code>` signs in as that identity. */
const IDENTITIES = new Map([
	["alice", identity("alice", "alice-sub", "alice@acme.test")],
	["alice-unverified", identity("alice-unverified", "alice-sub", "alice@acme.test", { emailVerified: false })],
	["bob", identity("bob", "bob-sub", "bob@acme.test")],
	["it", identity("it", "it-sub", "it@corp.test", { roles: ["offline_access", "maple-root"] })],
	[
		"it-unverified",
		identity("it-unverified", "it-sub", "it@corp.test", { emailVerified: false, roles: ["maple-root"] }),
	],
])

/**
 * A scriptable IdP. Refresh tokens are `rt-<code>`, rotated to `rt-<code>.<n>` on every refresh;
 * `refreshRoles` overrides what a refresh grants for a code, and `mode` makes the IdP refuse or vanish.
 */
const makeIdp = () => {
	const state = {
		mode: "ok" as "ok" | "rejected" | "unavailable",
		refreshRoles: new Map<string, ReadonlyArray<string>>(),
		refreshCalls: [] as Array<string>,
		logoutCalls: [] as Array<string>,
	}
	const codeOf = (refreshToken: string) => Str.slice(3)(Str.split(".")(refreshToken)[0] ?? "")
	const layer = Layer.succeed(OidcClient)({
		exchange: (input) =>
			Effect.fromOption(Option.fromNullishOr(IDENTITIES.get(input.code))).pipe(
				Effect.mapError(() => new UnauthorizedError({ message: "unknown code" })),
			),
		refresh: (refreshToken) =>
			Effect.suspend((): Effect.Effect<OidcRefreshed, OidcRefreshRejectedError | OidcUnavailableError> => {
				state.refreshCalls.push(refreshToken)
				if (state.mode === "rejected")
					return Effect.fail(new OidcRefreshRejectedError({ message: "invalid_grant" }))
				if (state.mode === "unavailable")
					return Effect.fail(new OidcUnavailableError({ message: "connection refused" }))
				const code = codeOf(refreshToken)
				return Effect.succeed({
					refreshToken: `rt-${code}.${state.refreshCalls.length}`,
					roles: state.refreshRoles.get(code) ?? IDENTITIES.get(code)?.roles ?? [],
				})
			}),
		logout: (refreshToken) => Effect.sync(() => void state.logoutCalls.push(refreshToken)),
	})
	return { state, layer }
}

const noEdgeCacheApi: EdgeCacheServiceApi = {
	getOrCompute: (_options, compute) =>
		compute.pipe(Effect.map((value) => ({ value, status: "miss", readMs: 0, wrote: false }))),
	invalidate: () => Effect.void,
	rawGetDetailed: () => Effect.succeed({ status: "miss", value: Option.none(), readMs: 0 }),
	rawGet: () => Effect.succeedNone,
	rawPut: () => Effect.void,
	rawDelete: () => Effect.void,
}
const noEdgeCache = Layer.succeed(EdgeCacheService, noEdgeCacheApi)

const sentEmails: Array<{ readonly to: string; readonly subject: string; readonly html: string }> = []
const fakeEmail = Layer.succeed(EmailService)({
	isConfigured: true,
	send: (to, subject, html) => Effect.sync(() => void sentEmails.push({ to, subject, html })),
})

// ClickHouse provisioning has its own test; here an org only needs its directory rows.
const fakeProvisioner = Layer.succeed(OrgProvisioner)({
	provision: () => Effect.void,
	purge: () => Effect.void,
})

const ROOT_PASSWORD = "test-root-password"
// The key a session is signed with when no MAPLE_SESSION_SIGNING_SECRET is set.
const ROOT_KEY = Effect.runSync(
	selfHostedSessionKey({
		MAPLE_ROOT_PASSWORD: Option.some(Redacted.make(ROOT_PASSWORD)),
		MAPLE_SESSION_SIGNING_SECRET: Option.none(),
	}),
)

const makeLayer = (
	testDb: TestDb,
	idp: Layer.Layer<OidcClient>,
	overrides: Record<string, string> = {},
) => {
	const env = Env.layer.pipe(
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					PORT: "3472",
					TINYBIRD_HOST: "https://api.tinybird.co",
					TINYBIRD_TOKEN: "test-token",
					MAPLE_AUTH_MODE: "self_hosted",
					MAPLE_ROOT_PASSWORD: ROOT_PASSWORD,
					MAPLE_DEFAULT_ORG_ID: "default",
					MAPLE_APP_BASE_URL: "https://app.test",
					MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
					MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "lookup-key",
					MAPLE_OIDC_TOKEN_URL: "http://keycloak.test/realms/maple/protocol/openid-connect/token",
					MAPLE_OIDC_CLIENT_ID: "maple-web",
					...overrides,
				}),
			),
		),
	)
	const base = Layer.mergeAll(env, testDb.layer)
	const revocation = MembershipRevocationService.layer.pipe(
		Layer.provide(Layer.mergeAll(noEdgeCache, AuditLogService.layerMemory)),
	)
	const directory = Layer.effect(DirectoryService, DirectoryService.make).pipe(
		Layer.provide(Layer.mergeAll(idp, fakeProvisioner, fakeEmail, revocation)),
	)
	// The real AuthService, renewing against the same fake IdP.
	const auth = Layer.effect(AuthService, AuthService.make).pipe(Layer.provide(idp))
	const apiKeys = ApiKeysService.layer.pipe(Layer.provide(base))
	return Layer.mergeAll(
		directory,
		auth,
		apiKeys,
		CliDeviceAuthService.layer.pipe(Layer.provide(apiKeys)),
		McpOAuthService.layer,
	).pipe(Layer.provide(base))
}

const run = <A, E>(
	testDb: TestDb,
	body: Effect.Effect<
		A,
		E,
		DirectoryService | AuthService | ApiKeysService | CliDeviceAuthService | McpOAuthService
	>,
	idp: Layer.Layer<OidcClient> = makeIdp().layer,
	overrides: Record<string, string> = {},
) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW_MS)
		return yield* body
	}).pipe(Effect.provide(makeLayer(testDb, idp, overrides)))

/** Sign in through the callback and resolve the minted token the way every Worker does. */
const signIn = (code: string, orgId?: OrgId) =>
	Effect.gen(function* () {
		const directory = yield* DirectoryService
		const auth = yield* AuthService
		const request = { code, codeVerifier: "verifier", redirectUri: "https://app.test/sign-in" }
		const login = yield* directory.callback(
			orgId === undefined
				? new OidcCallbackRequest(request)
				: new OidcCallbackRequest({ ...request, orgId }),
		)
		const tenant = yield* auth.resolveTenant({ authorization: `Bearer ${login.token}` })
		return { login, tenant }
	})

const createOrg = (id: OrgId, adminEmail: string) =>
	Effect.flatMap(DirectoryService, (directory) =>
		directory.createOrg(ROOT, new CreateOrgRequest({ id, name: id, adminEmail })),
	)

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => Option.getOrUndefined(Exit.findErrorOption(exit))

describe("DirectoryService", () => {
	it.effect("callback mints a token for the only org", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			Effect.gen(function* () {
				yield* createOrg(ACME, "alice@acme.test")
				const { login, tenant } = yield* signIn("alice")

				assert.strictEqual(tenant.orgId, ACME)
				assert.strictEqual(tenant.userId, "alice-sub")
				assert.deepStrictEqual(tenant.roles, [asRole("org:admin")])
				assert.strictEqual(login.expiresAt, NOW_MS + OIDC_TTL_SECONDS * 1000)
				assert.strictEqual(login.sessionExpiresAt, NOW_MS + 12 * 60 * 60 * 1000)
			}),
		)
	})

	it.effect("callback with no membership fails NoOrganizationError", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			Effect.gen(function* () {
				yield* createOrg(ACME, "alice@acme.test")
				const exit = yield* Effect.exit(signIn("bob"))
				assert.instanceOf(failureOf(exit), NoOrganizationError)
			}),
		)
	})

	it.effect("verified email accepts pending invitation", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			Effect.gen(function* () {
				const directory = yield* DirectoryService
				yield* createOrg(ACME, "alice@acme.test")
				const asRootInAcme = { ...ROOT, orgId: ACME }
				const before = yield* directory.listMembers(asRootInAcme)
				assert.deepStrictEqual(
					Arr.map(before.invitations, (invitation) => invitation.email),
					["alice@acme.test"],
				)

				yield* signIn("alice")

				const after = yield* directory.listMembers(asRootInAcme)
				assert.deepStrictEqual(
					Arr.map(after.members, (member) => [member.user.id, member.role]),
					[["alice-sub", "org:admin"]],
				)
				assert.deepStrictEqual(after.invitations, [])
			}),
		)
	})

	it.effect("unverified email cannot sign in and leaves the invitation pending", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			Effect.gen(function* () {
				const directory = yield* DirectoryService
				yield* createOrg(ACME, "alice@acme.test")

				const exit = yield* Effect.exit(signIn("alice-unverified"))
				assert.instanceOf(failureOf(exit), DirectoryEmailNotVerifiedError)

				const members = yield* directory.listMembers({ ...ROOT, orgId: ACME })
				assert.deepStrictEqual(members.members, [])
				assert.deepStrictEqual(
					Arr.map(members.invitations, (invitation) => invitation.email),
					["alice@acme.test"],
				)
				// The user is still recorded, unverified, for IT to see.
				const users = yield* directory.listUsers(ROOT)
				assert.deepStrictEqual(
					Arr.map(users.users, (row) => [row.user.id, row.user.emailVerified]),
					[["alice-sub", false]],
				)

				// Once verified, the same sign-in accepts the invitation.
				const { tenant } = yield* signIn("alice")
				assert.strictEqual(tenant.orgId, ACME)
			}),
		)
	})

	it.effect("an unverified IT user is refused too", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			Effect.gen(function* () {
				const exit = yield* Effect.exit(signIn("it-unverified"))
				assert.instanceOf(failureOf(exit), DirectoryEmailNotVerifiedError)
			}),
		)
	})

	it.effect("callback refuses a redirect URI other than the sign-in page", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			Effect.gen(function* () {
				const directory = yield* DirectoryService
				yield* createOrg(ACME, "alice@acme.test")
				const exit = yield* Effect.exit(
					directory.callback(
						new OidcCallbackRequest({
							code: "alice",
							codeVerifier: "verifier",
							redirectUri: "https://evil.test/sign-in",
						}),
					),
				)
				assert.instanceOf(failureOf(exit), UnauthorizedError)
			}),
		)
	})

	it.effect("createOrg makes only a verified known user admin directly; anyone else is invited", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			Effect.gen(function* () {
				const directory = yield* DirectoryService
				// Both have signed in once before any org exists; only bob's address is verified.
				yield* Effect.exit(signIn("alice-unverified"))
				yield* Effect.exit(signIn("bob"))

				yield* createOrg(ACME, "alice@acme.test")
				yield* createOrg(GLOBEX, "bob@acme.test")

				const acme = yield* directory.listMembers({ ...ROOT, orgId: ACME })
				assert.deepStrictEqual(acme.members, [])
				assert.deepStrictEqual(
					Arr.map(acme.invitations, (invitation) => invitation.email),
					["alice@acme.test"],
				)
				const globex = yield* directory.listMembers({ ...ROOT, orgId: GLOBEX })
				assert.deepStrictEqual(
					Arr.map(globex.members, (member) => [member.user.id, member.role]),
					[["bob-sub", "org:admin"]],
				)
				assert.deepStrictEqual(globex.invitations, [])
			}),
		)
	})

	it.effect("root may select any org", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			Effect.gen(function* () {
				yield* createOrg(ACME, "alice@acme.test")
				yield* createOrg(GLOBEX, "ops@globex.test")

				const { tenant } = yield* signIn("it", GLOBEX)
				assert.strictEqual(tenant.orgId, GLOBEX)
				assert.deepStrictEqual(tenant.roles, [asRole("root")])

				const { login } = yield* signIn("it", GLOBEX)
				const directory = yield* DirectoryService
				const switched = yield* directory.switchOrg(tenant, login.token, ACME)
				assert.strictEqual(switched.orgId, ACME)
				// The switch keeps the sign-in's deadline rather than starting a new one.
				assert.strictEqual(switched.sessionExpiresAt, login.sessionExpiresAt)
			}),
		)
	})

	it.effect("switchOrg to non-member org fails DirectoryForbiddenError", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			Effect.gen(function* () {
				const directory = yield* DirectoryService
				yield* createOrg(ACME, "alice@acme.test")
				yield* createOrg(GLOBEX, "ops@globex.test")
				const { login, tenant } = yield* signIn("alice")

				// Control: the same session may switch into an org it belongs to.
				const own = yield* directory.switchOrg(tenant, login.token, ACME)
				assert.strictEqual(own.orgId, ACME)

				const exit = yield* Effect.exit(directory.switchOrg(tenant, login.token, GLOBEX))
				assert.instanceOf(failureOf(exit), DirectoryForbiddenError)
			}),
		)
	})

	it.effect("an invitation emails the invitee a sign-in link", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			Effect.gen(function* () {
				const directory = yield* DirectoryService
				yield* createOrg(ACME, "alice@acme.test")
				const alice = yield* signIn("alice")
				sentEmails.length = 0
				yield* directory.createInvitation(alice.tenant, "Bob@Acme.test", "org:member")
				assert.deepStrictEqual(
					Arr.map(sentEmails, (mail) => mail.to),
					["bob@acme.test"],
				)
				assert.include(sentEmails[0]?.html ?? "", "/sign-in")
			}),
		)
	})

	it.effect("refresh check after removal fails", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			Effect.gen(function* () {
				const directory = yield* DirectoryService
				const auth = yield* AuthService
				yield* createOrg(ACME, "alice@acme.test")
				const alice = yield* signIn("alice")
				yield* directory.createInvitation(alice.tenant, "Bob@Acme.test", "org:member")
				const bob = yield* signIn("bob")

				// Control: a current member renews, and only for the short OIDC lifetime.
				const renewed = yield* auth.refreshSelfHostedSession(bob.login.token)
				assert.strictEqual(renewed.expiresAt, NOW_MS + OIDC_TTL_SECONDS * 1000)

				yield* directory.removeMember(alice.tenant, bob.tenant.userId)

				const exit = yield* Effect.exit(auth.refreshSelfHostedSession(bob.login.token))
				assert.instanceOf(failureOf(exit), UnauthorizedError)
			}),
		)
	})

	it.effect("member cannot manage members", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			Effect.gen(function* () {
				const directory = yield* DirectoryService
				yield* createOrg(ACME, "alice@acme.test")
				const alice = yield* signIn("alice")
				yield* directory.createInvitation(alice.tenant, "bob@acme.test", "org:member")
				const bob = yield* signIn("bob")

				const list = yield* Effect.exit(directory.listMembers(bob.tenant))
				assert.instanceOf(failureOf(list), DirectoryForbiddenError)
				const promote = yield* Effect.exit(
					directory.updateMember(bob.tenant, bob.tenant.userId, "org:admin"),
				)
				assert.instanceOf(failureOf(promote), DirectoryForbiddenError)

				const members = yield* directory.listMembers(alice.tenant)
				assert.deepStrictEqual(
					Arr.map(members.members, (member) => [member.user.id, member.role]),
					[
						["alice-sub", "org:admin"],
						["bob-sub", "org:member"],
					],
				)
			}),
		)
	})

	it.effect("last admin cannot be demoted or removed", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			Effect.gen(function* () {
				const directory = yield* DirectoryService
				yield* createOrg(ACME, "alice@acme.test")
				const alice = yield* signIn("alice")
				yield* directory.createInvitation(alice.tenant, "bob@acme.test", "org:member")
				const bob = yield* signIn("bob")

				const demote = yield* Effect.exit(
					directory.updateMember(alice.tenant, alice.tenant.userId, "org:member"),
				)
				assert.instanceOf(failureOf(demote), DirectoryConflictError)
				const remove = yield* Effect.exit(directory.removeMember(alice.tenant, alice.tenant.userId))
				assert.instanceOf(failureOf(remove), DirectoryConflictError)

				// With a second admin the first may step down.
				yield* directory.updateMember(alice.tenant, bob.tenant.userId, "org:admin")
				yield* directory.updateMember(alice.tenant, alice.tenant.userId, "org:member")
				const members = yield* directory.listMembers(bob.tenant)
				assert.deepStrictEqual(
					Arr.map(members.members, (member) => [member.user.id, member.role]),
					[
						["alice-sub", "org:member"],
						["bob-sub", "org:admin"],
					],
				)
			}),
		)
	})

	it.effect("removing a member retires the API keys they created", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			Effect.gen(function* () {
				const directory = yield* DirectoryService
				const apiKeys = yield* ApiKeysService
				yield* createOrg(ACME, "alice@acme.test")
				const alice = yield* signIn("alice")
				yield* directory.createInvitation(alice.tenant, "bob@acme.test", "org:member")
				const bob = yield* signIn("bob")
				const key = yield* apiKeys.create(ACME, bob.tenant.userId, { name: "bob's laptop" })
				assert.isTrue(Option.isSome(yield* apiKeys.resolveByKey(key.secret)))

				yield* directory.removeMember(alice.tenant, bob.tenant.userId)

				assert.isTrue(Option.isNone(yield* apiKeys.resolveByKey(key.secret)))
			}),
		)
	})

	it.effect("callback opens a server-side session the token names", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			Effect.gen(function* () {
				const directory = yield* DirectoryService
				yield* createOrg(ACME, "alice@acme.test")
				const first = yield* signIn("alice")
				yield* TestClock.adjust("1 minute")
				const second = yield* signIn("alice")

				const sessions = yield* directory.listSessions(second.login.token)
				assert.deepStrictEqual(
					Arr.map(sessions.sessions, (session) => [session.createdAt, session.current]),
					[
						[NOW_MS + 60_000, true],
						[NOW_MS, false],
					],
				)
				// The other sign-in sees the same two, with itself current.
				const fromFirst = yield* directory.listSessions(first.login.token)
				assert.deepStrictEqual(
					Arr.map(fromFirst.sessions, (session) => session.current),
					[false, true],
				)
			}),
		)
	})

	it.effect("logout ends renewal, switching orgs and the IdP session", () => {
		const testDb = createTestDb(trackedDbs)
		const idp = makeIdp()
		return run(
			testDb,
			Effect.gen(function* () {
				const directory = yield* DirectoryService
				const auth = yield* AuthService
				yield* createOrg(ACME, "alice@acme.test")
				const kept = yield* signIn("alice")
				const { login, tenant } = yield* signIn("alice")

				yield* directory.logout(login.token)
				assert.deepStrictEqual(idp.state.logoutCalls, ["rt-alice"])

				const renewal = yield* Effect.exit(auth.refreshSelfHostedSession(login.token))
				assert.instanceOf(failureOf(renewal), UnauthorizedError)
				const switched = yield* Effect.exit(directory.switchOrg(tenant, login.token, ACME))
				assert.instanceOf(failureOf(switched), DirectoryForbiddenError)
				// Only that sign-in ended; the other one still renews.
				yield* auth.refreshSelfHostedSession(kept.login.token)
			}),
			idp.layer,
			{ MAPLE_OIDC_LOGOUT_URL: "http://keycloak.test/logout" },
		)
	})

	it.effect("logout-all signs out every session at the IdP", () => {
		const testDb = createTestDb(trackedDbs)
		const idp = makeIdp()
		return run(
			testDb,
			Effect.gen(function* () {
				const directory = yield* DirectoryService
				const auth = yield* AuthService
				yield* createOrg(ACME, "alice@acme.test")
				const first = yield* signIn("alice")
				const second = yield* signIn("alice")

				yield* directory.logoutAll(second.login.token)

				assert.deepStrictEqual(idp.state.logoutCalls, ["rt-alice", "rt-alice"])
				for (const token of [first.login.token, second.login.token]) {
					const renewal = yield* Effect.exit(auth.refreshSelfHostedSession(token))
					assert.instanceOf(failureOf(renewal), UnauthorizedError)
				}
				const sessions = yield* directory.listSessions(second.login.token)
				assert.deepStrictEqual(sessions.sessions, [])
			}),
			idp.layer,
		)
	})

	it.effect("renewal fails once the IdP refuses the refresh token, and stays failed", () => {
		const testDb = createTestDb(trackedDbs)
		const idp = makeIdp()
		return run(
			testDb,
			Effect.gen(function* () {
				const auth = yield* AuthService
				yield* createOrg(ACME, "alice@acme.test")
				const { login } = yield* signIn("alice")
				yield* TestClock.adjust("31 seconds")
				idp.state.mode = "rejected"

				const exit = yield* Effect.exit(auth.refreshSelfHostedSession(login.token))
				assert.instanceOf(failureOf(exit), UnauthorizedError)
				assert.deepStrictEqual(idp.state.refreshCalls, ["rt-alice"])

				// The session was revoked, so a recovered IdP does not bring it back.
				idp.state.mode = "ok"
				const again = yield* Effect.exit(auth.refreshSelfHostedSession(login.token))
				assert.instanceOf(failureOf(again), UnauthorizedError)
			}),
			idp.layer,
		)
	})

	it.effect("renewal survives an unreachable IdP on membership alone", () => {
		const testDb = createTestDb(trackedDbs)
		const idp = makeIdp()
		return run(
			testDb,
			Effect.gen(function* () {
				const auth = yield* AuthService
				yield* createOrg(ACME, "alice@acme.test")
				const { login } = yield* signIn("alice")
				yield* TestClock.adjust("31 seconds")
				idp.state.mode = "unavailable"

				const renewed = yield* auth.refreshSelfHostedSession(login.token)
				assert.strictEqual(renewed.expiresAt, NOW_MS + 31_000 + OIDC_TTL_SECONDS * 1000)
				assert.deepStrictEqual(idp.state.refreshCalls, ["rt-alice"])
			}),
			idp.layer,
		)
	})

	it.effect("renewal asks the IdP at most every 30 seconds and keeps its rotated token", () => {
		const testDb = createTestDb(trackedDbs)
		const idp = makeIdp()
		return run(
			testDb,
			Effect.gen(function* () {
				const auth = yield* AuthService
				yield* createOrg(ACME, "alice@acme.test")
				const { login } = yield* signIn("alice")
				const soon = yield* auth.refreshSelfHostedSession(login.token)
				assert.deepStrictEqual(idp.state.refreshCalls, [])

				yield* TestClock.adjust("31 seconds")
				const later = yield* auth.refreshSelfHostedSession(soon.token)
				yield* TestClock.adjust("31 seconds")
				yield* auth.refreshSelfHostedSession(later.token)
				assert.deepStrictEqual(idp.state.refreshCalls, ["rt-alice", "rt-alice.1"])
			}),
			idp.layer,
		)
	})

	it.effect("renewal drops root when the refreshed token no longer carries the IdP role", () => {
		const testDb = createTestDb(trackedDbs)
		const idp = makeIdp()
		return run(
			testDb,
			Effect.gen(function* () {
				const auth = yield* AuthService
				// IT signs in once (recording a verified address), then becomes admin of ACME.
				yield* signIn("it")
				yield* createOrg(ACME, "it@corp.test")
				yield* createOrg(GLOBEX, "ops@globex.test")
				const inAcme = yield* signIn("it", ACME)
				const inGlobex = yield* signIn("it", GLOBEX)
				assert.deepStrictEqual(inAcme.tenant.roles, [asRole("root")])

				yield* TestClock.adjust("31 seconds")
				idp.state.refreshRoles.set("it", ["offline_access"])

				const renewed = yield* auth.refreshSelfHostedSession(inAcme.login.token)
				const tenant = yield* auth.resolveTenant({ authorization: `Bearer ${renewed.token}` })
				assert.deepStrictEqual(tenant.roles, [asRole("org:admin")])
				// Not a member of GLOBEX: without root that session ends.
				const exit = yield* Effect.exit(auth.refreshSelfHostedSession(inGlobex.login.token))
				assert.instanceOf(failureOf(exit), UnauthorizedError)
			}),
			idp.layer,
		)
	})

	it.effect("an OIDC token without a session id cannot be renewed", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			Effect.gen(function* () {
				const auth = yield* AuthService
				yield* createOrg(ACME, "alice@acme.test")
				const { tenant } = yield* signIn("alice")
				// What a sign-in minted before sessions existed looks like.
				const legacy = mintSessionToken(
					{
						sub: tenant.userId,
						orgId: ACME,
						roles: tenant.roles,
						nowSeconds: NOW_MS / 1000,
						ttlSeconds: OIDC_TTL_SECONDS,
						sessionExpiresAt: NOW_MS / 1000 + 3600,
					},
					ROOT_KEY,
				)
				// It still verifies until it expires...
				yield* auth.resolveTenant({ authorization: `Bearer ${legacy.token}` })
				// ...but it cannot be renewed.
				const exit = yield* Effect.exit(auth.refreshSelfHostedSession(legacy.token))
				assert.instanceOf(failureOf(exit), UnauthorizedError)
			}),
		)
	})

	it.effect("the root-password session still renews with OIDC on and the IdP down", () => {
		const testDb = createTestDb(trackedDbs)
		const idp = makeIdp()
		idp.state.mode = "unavailable"
		return run(
			testDb,
			Effect.gen(function* () {
				const auth = yield* AuthService
				const login = yield* auth.loginSelfHosted(ROOT_PASSWORD)
				yield* TestClock.adjust("1 hour")
				const renewed = yield* auth.refreshSelfHostedSession(login.token)
				assert.strictEqual(renewed.userId, "root")
				assert.deepStrictEqual(idp.state.refreshCalls, [])
			}),
			idp.layer,
		)
	})

	it.effect("session lifetimes come from the env, clamped to their bounds", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			Effect.gen(function* () {
				yield* createOrg(ACME, "alice@acme.test")
				const { login } = yield* signIn("alice")
				assert.strictEqual(login.expiresAt, NOW_MS + 120 * 1000)
				assert.strictEqual(login.sessionExpiresAt, NOW_MS + 604800 * 1000)
			}),
			makeIdp().layer,
			{ MAPLE_OIDC_SESSION_TTL_SECONDS: "30", MAPLE_OIDC_SESSION_MAX_LIFETIME_SECONDS: "99999999" },
		)
	})

	it.effect("a separate session secret signs OIDC and root-password sessions alike", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			Effect.gen(function* () {
				const auth = yield* AuthService
				yield* createOrg(ACME, "alice@acme.test")
				const { login } = yield* signIn("alice")
				const root = yield* auth.loginSelfHosted(ROOT_PASSWORD)
				yield* auth.refreshSelfHostedSession(login.token)
				yield* auth.refreshSelfHostedSession(root.token)
				const legacy = mintSessionToken(
					{
						sub: root.userId,
						orgId: root.orgId,
						roles: [asRole("root")],
						nowSeconds: NOW_MS / 1000,
						ttlSeconds: 600,
						sessionExpiresAt: NOW_MS / 1000 + 3600,
					},
					ROOT_KEY,
				)
				// A token signed with the root password no longer verifies.
				const exit = yield* Effect.exit(auth.resolveTenant({ authorization: `Bearer ${legacy.token}` }))
				assert.instanceOf(failureOf(exit), UnauthorizedError)
			}),
			makeIdp().layer,
			{ MAPLE_SESSION_SIGNING_SECRET: "a-separate-session-secret" },
		)
	})

	it.effect("an idle tab's expired token can still log out, and nothing else", () => {
		const testDb = createTestDb(trackedDbs)
		const idp = makeIdp()
		return run(
			testDb,
			Effect.gen(function* () {
				const directory = yield* DirectoryService
				const auth = yield* AuthService
				yield* createOrg(ACME, "alice@acme.test")
				const idle = yield* signIn("alice")
				yield* TestClock.adjust("15 minutes")

				// Past `exp`: no other endpoint accepts it.
				const resolved = yield* Effect.exit(auth.resolveTenant({ authorization: `Bearer ${idle.login.token}` }))
				assert.instanceOf(failureOf(resolved), UnauthorizedError)
				const listed = yield* Effect.exit(directory.listSessions(idle.login.token))
				assert.instanceOf(failureOf(listed), UnauthorizedError)
				const all = yield* Effect.exit(directory.logoutAll(idle.login.token))
				assert.instanceOf(failureOf(all), UnauthorizedError)

				yield* directory.logout(idle.login.token)
				assert.deepStrictEqual(idp.state.logoutCalls, ["rt-alice"])
				const fresh = yield* signIn("alice")
				const sessions = yield* directory.listSessions(fresh.login.token)
				assert.deepStrictEqual(
					Arr.map(sessions.sessions, (session) => session.current),
					[true],
				)
			}),
			idp.layer,
		)
	})

	it.effect("logout refuses an expired token without a session, a tampered one, and one past its sign-in", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			Effect.gen(function* () {
				const directory = yield* DirectoryService
				yield* createOrg(ACME, "alice@acme.test")
				const { login, tenant } = yield* signIn("alice")
				const legacy = mintSessionToken(
					{
						sub: tenant.userId,
						orgId: ACME,
						roles: tenant.roles,
						nowSeconds: NOW_MS / 1000,
						ttlSeconds: OIDC_TTL_SECONDS,
						sessionExpiresAt: NOW_MS / 1000 + 3600,
					},
					ROOT_KEY,
				)
				const [header, payload, signature] = Str.split(".")(login.token)
				const claims = JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8"))
				const tampered = `${header}.${Buffer.from(JSON.stringify({ ...claims, sub: "bob-sub" })).toString("base64url")}.${signature}`

				yield* TestClock.adjust("15 minutes")
				for (const token of [legacy.token, tampered]) {
					const exit = yield* Effect.exit(directory.logout(token))
					assert.instanceOf(failureOf(exit), UnauthorizedError)
				}
				// Past the one-hour sign-in: the session is over and logout has nothing to accept.
				yield* TestClock.adjust("1 hour")
				const late = yield* Effect.exit(directory.logout(login.token))
				assert.instanceOf(failureOf(late), UnauthorizedError)
			}),
			makeIdp().layer,
			{ MAPLE_OIDC_SESSION_MAX_LIFETIME_SECONDS: "3600" },
		)
	})

	it.effect("a removed member's still-valid token cannot approve a CLI login", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			Effect.gen(function* () {
				const directory = yield* DirectoryService
				const cli = yield* CliDeviceAuthService
				yield* createOrg(ACME, "alice@acme.test")
				const alice = yield* signIn("alice")
				yield* directory.createInvitation(alice.tenant, "bob@acme.test", "org:member")
				const bob = yield* signIn("bob")
				const approveAs = (tenant: TenantContext) =>
					Effect.flatMap(cli.start("laptop", "127.0.0.1"), (started) =>
						cli.approve(started.userCode, { ...tenant, userEmail: null }),
					)
				// Control: a current member may approve.
				yield* approveAs(bob.tenant)

				yield* directory.removeMember(alice.tenant, bob.tenant.userId)

				const exit = yield* Effect.exit(approveAs(bob.tenant))
				assert.instanceOf(failureOf(exit), OrganizationAccessDeniedError)
			}),
		)
	})

	it.effect("a CLI login approved before a removal yields no key", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			Effect.gen(function* () {
				const directory = yield* DirectoryService
				const cli = yield* CliDeviceAuthService
				yield* createOrg(ACME, "alice@acme.test")
				const alice = yield* signIn("alice")
				yield* directory.createInvitation(alice.tenant, "bob@acme.test", "org:member")
				const bob = yield* signIn("bob")
				const started = yield* cli.start("laptop", "127.0.0.1")
				yield* cli.approve(started.userCode, { ...bob.tenant, userEmail: null })

				yield* directory.removeMember(alice.tenant, bob.tenant.userId)

				const polled = yield* Effect.exit(cli.poll(started.deviceCode))
				assert.isFalse(Exit.isSuccess(polled) && polled.value.status === "complete")
			}),
		)
	})

	it.effect("a CLI login approved before the membership vanished is denied at poll", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			Effect.gen(function* () {
				const directory = yield* DirectoryService
				const cli = yield* CliDeviceAuthService
				yield* createOrg(ACME, "alice@acme.test")
				const alice = yield* signIn("alice")
				yield* directory.createInvitation(alice.tenant, "bob@acme.test", "org:member")
				const bob = yield* signIn("bob")
				const started = yield* cli.start("laptop", "127.0.0.1")
				yield* cli.approve(started.userCode, { ...bob.tenant, userEmail: null })
				// The membership is gone but no sweep ran (the poll must not rely on one).
				yield* Effect.promise(() =>
					executeSql(testDb, "DELETE FROM directory_members WHERE user_id = 'bob-sub'"),
				)

				const polled = yield* cli.poll(started.deviceCode)
				assert.strictEqual(polled.status, "denied")
			}),
		)
	})

	it.effect("IT signed out everywhere cannot approve a CLI login with a leftover token", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			Effect.gen(function* () {
				const directory = yield* DirectoryService
				const cli = yield* CliDeviceAuthService
				const it = yield* signIn("it")
				yield* directory.logoutAll(it.login.token)
				const started = yield* cli.start("laptop", "127.0.0.1")
				const exit = yield* Effect.exit(cli.approve(started.userCode, { ...it.tenant, userEmail: null }))
				assert.instanceOf(failureOf(exit), OrganizationAccessDeniedError)
			}),
		)
	})

	it.effect("a removed member's still-valid token cannot approve an MCP grant", () => {
		const testDb = createTestDb(trackedDbs)
		const redirectUri = "http://127.0.0.1:49152/callback"
		const resource = "https://api.example.com/mcp"
		return run(
			testDb,
			Effect.gen(function* () {
				const directory = yield* DirectoryService
				const oauth = yield* McpOAuthService
				yield* createOrg(ACME, "alice@acme.test")
				const alice = yield* signIn("alice")
				yield* directory.createInvitation(alice.tenant, "bob@acme.test", "org:member")
				const bob = yield* signIn("bob")
				const client = yield* oauth.register(
					{ clientName: "Bob's agent", redirectUris: [redirectUri] },
					"127.0.0.1",
				)
				const started = yield* oauth.startAuthorization(
					{
						clientId: client.client_id,
						redirectUri,
						responseType: "code",
						codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
						codeChallengeMethod: "S256",
						resource,
						expectedResource: resource,
					},
					"127.0.0.1",
				)
				const requestId = new URL(started.consentUrl).searchParams.get("request_id") ?? ""

				yield* directory.removeMember(alice.tenant, bob.tenant.userId)

				const exit = yield* Effect.exit(oauth.approve(requestId, { ...bob.tenant, userEmail: null }))
				assert.instanceOf(failureOf(exit), OrganizationAccessDeniedError)
			}),
		)
	})

	it.effect("switching org never extends the caller's token, even with the IdP refusing", () => {
		const testDb = createTestDb(trackedDbs)
		const idp = makeIdp()
		return run(
			testDb,
			Effect.gen(function* () {
				const directory = yield* DirectoryService
				yield* createOrg(ACME, "alice@acme.test")
				const { login, tenant } = yield* signIn("alice")
				idp.state.mode = "rejected"
				let token = login.token
				for (let step = 0; step < 2; step++) {
					yield* TestClock.adjust("4 minutes")
					const switched = yield* directory.switchOrg(tenant, token, ACME)
					assert.strictEqual(switched.expiresAt, login.expiresAt)
					token = switched.token
				}
				// The original deadline passes and the chain ends there.
				yield* TestClock.adjust("3 minutes")
				const exit = yield* Effect.exit(directory.switchOrg(tenant, token, ACME))
				assert.instanceOf(failureOf(exit), DirectoryForbiddenError)
			}),
			idp.layer,
		)
	})

	it.effect("removing a member again retries a sweep that failed after the delete", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			Effect.gen(function* () {
				const directory = yield* DirectoryService
				const apiKeys = yield* ApiKeysService
				yield* createOrg(ACME, "alice@acme.test")
				const alice = yield* signIn("alice")
				yield* directory.createInvitation(alice.tenant, "bob@acme.test", "org:member")
				const bob = yield* signIn("bob")
				const key = yield* apiKeys.create(ACME, bob.tenant.userId, { name: "bob's laptop" })
				// What a failed sweep leaves behind: the membership is gone, the key is not.
				yield* Effect.promise(() =>
					executeSql(testDb, "DELETE FROM directory_members WHERE user_id = 'bob-sub'"),
				)
				assert.isTrue(Option.isSome(yield* apiKeys.resolveByKey(key.secret)))

				const exit = yield* Effect.exit(directory.removeMember(alice.tenant, bob.tenant.userId))
				assert.instanceOf(failureOf(exit), DirectoryNotFoundError)
				assert.isTrue(Option.isNone(yield* apiKeys.resolveByKey(key.secret)))
			}),
		)
	})
})
