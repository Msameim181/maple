import { afterEach, assert, describe, it } from "@effect/vitest"
import {
	CreateOrgRequest,
	DirectoryConflictError,
	DirectoryForbiddenError,
	NoOrganizationError,
	OidcCallbackRequest,
	OrgId,
	RoleName,
	type TenantContext,
	UnauthorizedError,
	UserId,
} from "@maple/domain/http"
import { ConfigProvider, Effect, Exit, Layer, Option, Schema, Array as Arr } from "effect"
import { TestClock } from "effect/testing"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { DirectoryService, OIDC_SESSION_TTL_SECONDS } from "./DirectoryService"
import { OidcClient, type OidcIdentity } from "./OidcClient"
import { OrgProvisioner } from "./OrgProvisioner"

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

const identity = (sub: string, email: string, overrides: Partial<OidcIdentity> = {}): OidcIdentity => ({
	sub,
	email,
	emailVerified: true,
	name: sub,
	roles: [],
	...overrides,
})

/** Codes the fake IdP redeems: `<code>` signs in as that identity. */
const IDENTITIES = new Map([
	["alice", identity("alice-sub", "alice@acme.test")],
	["alice-unverified", identity("alice-sub", "alice@acme.test", { emailVerified: false })],
	["bob", identity("bob-sub", "bob@acme.test")],
	["it", identity("it-sub", "it@corp.test", { roles: ["offline_access", "maple-root"] })],
])

const fakeOidc = Layer.succeed(OidcClient)({
	exchange: (input) =>
		Effect.fromOption(Option.fromNullishOr(IDENTITIES.get(input.code))).pipe(
			Effect.mapError(() => new UnauthorizedError({ message: "unknown code" })),
		),
})

// ClickHouse provisioning has its own test; here an org only needs its directory rows.
const fakeProvisioner = Layer.succeed(OrgProvisioner)({
	provision: () => Effect.void,
	purge: () => Effect.void,
})

const makeLayer = (testDb: TestDb) => {
	const env = Env.layer.pipe(
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					PORT: "3472",
					TINYBIRD_HOST: "https://api.tinybird.co",
					TINYBIRD_TOKEN: "test-token",
					MAPLE_AUTH_MODE: "self_hosted",
					MAPLE_ROOT_PASSWORD: "test-root-password",
					MAPLE_DEFAULT_ORG_ID: "default",
					MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
					MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "lookup-key",
					MAPLE_OIDC_TOKEN_URL: "http://keycloak.test/realms/maple/protocol/openid-connect/token",
					MAPLE_OIDC_CLIENT_ID: "maple-web",
				}),
			),
		),
	)
	const directory = Layer.effect(DirectoryService, DirectoryService.make).pipe(
		Layer.provide(Layer.mergeAll(fakeOidc, fakeProvisioner)),
	)
	return Layer.mergeAll(directory, AuthService.layer).pipe(Layer.provide(Layer.mergeAll(env, testDb.layer)))
}

const run = <A, E>(testDb: TestDb, body: Effect.Effect<A, E, DirectoryService | AuthService>) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW_MS)
		return yield* body
	}).pipe(Effect.provide(makeLayer(testDb)))

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
				assert.strictEqual(login.expiresAt, NOW_MS + OIDC_SESSION_TTL_SECONDS * 1000)
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

	it.effect("unverified email leaves invitation pending", () => {
		const testDb = createTestDb(trackedDbs)
		return run(
			testDb,
			Effect.gen(function* () {
				const directory = yield* DirectoryService
				yield* createOrg(ACME, "alice@acme.test")

				const exit = yield* Effect.exit(signIn("alice-unverified"))
				assert.instanceOf(failureOf(exit), NoOrganizationError)

				const members = yield* directory.listMembers({ ...ROOT, orgId: ACME })
				assert.deepStrictEqual(members.members, [])
				assert.deepStrictEqual(
					Arr.map(members.invitations, (invitation) => invitation.email),
					["alice@acme.test"],
				)
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
				assert.strictEqual(renewed.expiresAt, NOW_MS + OIDC_SESSION_TTL_SECONDS * 1000)

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
})
