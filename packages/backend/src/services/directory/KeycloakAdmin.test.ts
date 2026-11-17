import { afterEach, assert, describe, it } from "@effect/vitest"
import * as PG from "@maple-dev/effect-orm/postgres"
import { DirectoryUsers } from "@maple/db/tables"
import {
	DirectoryDisabledError,
	DirectoryForbiddenError,
	DirectoryNotFoundError,
	OrgId,
	RoleName,
	type TenantContext,
	UserId,
} from "@maple/domain/http"
import { ConfigProvider, Effect, Exit, Layer, Option, Schema, Array as Arr } from "effect"
import { HttpClient, HttpClientResponse, type HttpClientRequest, UrlParams } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { KeycloakAdmin } from "./KeycloakAdmin"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const asRole = Schema.decodeUnknownSync(RoleName)

const ROOT: TenantContext = {
	orgId: asOrgId("default"),
	userId: asUserId("it-sub"),
	roles: [asRole("root")],
	authMode: "self_hosted",
}
const ORG_ADMIN: TenantContext = {
	orgId: asOrgId("acme"),
	userId: asUserId("alice-sub"),
	roles: [asRole("org:admin")],
	authMode: "self_hosted",
}

const ADMIN_URL = "http://keycloak.test/admin/realms/maple"
const TOKEN_URL = "http://keycloak.test/realms/maple/protocol/openid-connect/token"

const BASE_ENV = {
	PORT: "3472",
	TINYBIRD_HOST: "https://api.tinybird.co",
	TINYBIRD_TOKEN: "test-token",
	MAPLE_AUTH_MODE: "self_hosted",
	MAPLE_ROOT_PASSWORD: "test-root-password",
	MAPLE_DEFAULT_ORG_ID: "default",
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "lookup-key",
	MAPLE_APP_BASE_URL: "https://maple.test",
	MAPLE_OIDC_TOKEN_URL: TOKEN_URL,
	MAPLE_OIDC_CLIENT_ID: "maple-web",
}
const ADMIN_ENV = {
	...BASE_ENV,
	MAPLE_OIDC_ADMIN_URL: ADMIN_URL,
	MAPLE_OIDC_ADMIN_CLIENT_SECRET: "admin-secret",
}

interface Captured {
	readonly method: string
	readonly url: string
	readonly params: URLSearchParams
	readonly headers: Record<string, string>
	readonly body: string
}

/**
 * A fake Keycloak: issues a token, answers the user search with `listed`, serves `storedUser` (or 404
 * when absent), accepts every PUT.
 */
const fakeKeycloak = (
	storedUser: Record<string, unknown> | undefined,
	listed: ReadonlyArray<Record<string, unknown>> = [],
) => {
	const captured: Array<Captured> = []
	const client = HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
		Effect.sync(() => {
			const body = request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : ""
			captured.push({
				method: request.method,
				url: request.url,
				params: new URLSearchParams(UrlParams.toString(request.urlParams)),
				headers: { ...request.headers },
				body,
			})
			const reply = (status: number, json?: unknown) =>
				HttpClientResponse.fromWeb(
					request,
					new Response(json === undefined ? null : JSON.stringify(json), { status }),
				)
			if (request.url === TOKEN_URL) return reply(200, { access_token: "sa-token", expires_in: 300 })
			if (request.url === `${ADMIN_URL}/users`) return reply(200, listed)
			if (request.method === "GET")
				return storedUser === undefined ? reply(404) : reply(200, storedUser)
			return reply(204)
		}),
	)
	return { client, captured }
}

const insertUser = (id: string, email: string, emailVerified: boolean, createdAt: number) =>
	Effect.flatMap(Database, (database) =>
		database.execute((db) =>
			db.run(
				PG.insertInto(DirectoryUsers).values({
					id: asUserId(id),
					email,
					emailVerified,
					name: id,
					lastSeenAt: null,
					createdAt,
				}),
			),
		),
	)

const run = <A, E>(
	testDb: TestDb,
	envValues: Record<string, string>,
	client: HttpClient.HttpClient,
	body: Effect.Effect<A, E, KeycloakAdmin | Database>,
) => {
	const env = Env.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(envValues))))
	const service = Layer.effect(KeycloakAdmin, KeycloakAdmin.make).pipe(
		Layer.provide(Layer.mergeAll(env, testDb.layer, Layer.succeed(HttpClient.HttpClient)(client))),
	)
	return body.pipe(Effect.provide(Layer.merge(service, testDb.layer)))
}

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => Option.getOrUndefined(Exit.findErrorOption(exit))

describe("KeycloakAdmin", () => {
	it.effect("resendVerification asks the IdP to mail a link back to Maple's sign-in", () => {
		const keycloak = fakeKeycloak({ id: "bob-sub" })
		return run(
			createTestDb(trackedDbs),
			ADMIN_ENV,
			keycloak.client,
			Effect.gen(function* () {
				const admin = yield* KeycloakAdmin
				yield* admin.resendVerification(ROOT, asUserId("bob-sub"))

				const call = Arr.findFirst(keycloak.captured, (request) => request.url !== TOKEN_URL)
				assert.isTrue(Option.isSome(call))
				const sent = Option.getOrThrow(call)
				assert.strictEqual(sent.method, "PUT")
				assert.strictEqual(sent.url, `${ADMIN_URL}/users/bob-sub/send-verify-email`)
				assert.strictEqual(sent.params.get("client_id"), "maple-web")
				assert.strictEqual(sent.params.get("redirect_uri"), "https://maple.test/sign-in")
				assert.strictEqual(sent.headers.authorization, "Bearer sa-token")
			}),
		)
	})

	it.effect("the service-account token is fetched with the admin client's credentials and reused", () => {
		const keycloak = fakeKeycloak({ id: "bob-sub" })
		return run(
			createTestDb(trackedDbs),
			ADMIN_ENV,
			keycloak.client,
			Effect.gen(function* () {
				const admin = yield* KeycloakAdmin
				yield* admin.resendVerification(ROOT, asUserId("bob-sub"))
				yield* admin.resendVerification(ROOT, asUserId("bob-sub"))

				const tokenCalls = Arr.filter(keycloak.captured, (request) => request.url === TOKEN_URL)
				assert.strictEqual(tokenCalls.length, 1)
				const grant = new URLSearchParams(tokenCalls[0]?.body ?? "")
				assert.strictEqual(grant.get("grant_type"), "client_credentials")
				assert.strictEqual(grant.get("client_id"), "maple-admin")
				assert.strictEqual(grant.get("client_secret"), "admin-secret")
			}),
		)
	})

	it.effect("markVerified verifies the address in the IdP and in Maple, keeping every other field", () => {
		const stored = {
			id: "bob-sub",
			username: "bob",
			email: "bob@acme.test",
			emailVerified: false,
			enabled: true,
			attributes: { locale: ["en"] },
			requiredActions: ["VERIFY_EMAIL", "UPDATE_PASSWORD"],
		}
		const keycloak = fakeKeycloak(stored)
		return run(
			createTestDb(trackedDbs),
			ADMIN_ENV,
			keycloak.client,
			Effect.gen(function* () {
				const admin = yield* KeycloakAdmin
				yield* insertUser("bob-sub", "bob@acme.test", false, 1)

				yield* admin.markVerified(ROOT, asUserId("bob-sub"))

				const update = Arr.findFirst(
					keycloak.captured,
					(request) => request.method === "PUT" && request.url === `${ADMIN_URL}/users/bob-sub`,
				)
				assert.isTrue(Option.isSome(update))
				assert.deepStrictEqual(JSON.parse(Option.getOrThrow(update).body), {
					...stored,
					emailVerified: true,
					requiredActions: ["UPDATE_PASSWORD"],
				})
				const pending = yield* admin.listUnverified(ROOT)
				assert.deepStrictEqual(pending.users, [])
			}),
		)
	})

	it.effect("markVerified of a user the IdP does not know fails DirectoryNotFoundError", () => {
		const keycloak = fakeKeycloak(undefined)
		return run(
			createTestDb(trackedDbs),
			ADMIN_ENV,
			keycloak.client,
			Effect.gen(function* () {
				const admin = yield* KeycloakAdmin
				const exit = yield* Effect.exit(admin.markVerified(ROOT, asUserId("ghost")))
				assert.instanceOf(failureOf(exit), DirectoryNotFoundError)
			}),
		)
	})

	it.effect("markVerified of a user who never reached Maple succeeds and drops VERIFY_EMAIL", () => {
		const stored = {
			id: "dave-sub",
			username: "dave",
			email: "dave@acme.test",
			emailVerified: false,
			requiredActions: ["VERIFY_EMAIL"],
		}
		const keycloak = fakeKeycloak(stored)
		return run(
			createTestDb(trackedDbs),
			ADMIN_ENV,
			keycloak.client,
			Effect.gen(function* () {
				const admin = yield* KeycloakAdmin
				const result = yield* admin.markVerified(ROOT, asUserId("dave-sub"))
				assert.isTrue(result.ok)

				const update = Arr.findFirst(
					keycloak.captured,
					(request) => request.method === "PUT" && request.url === `${ADMIN_URL}/users/dave-sub`,
				)
				assert.deepStrictEqual(JSON.parse(Option.getOrThrow(update).body), {
					...stored,
					emailVerified: true,
					requiredActions: [],
				})
			}),
		)
	})

	it.effect(
		"listUnverified lists Keycloak's unverified people, oldest first, without service accounts",
		() => {
			const keycloak = fakeKeycloak(undefined, [
				{
					id: "erin-sub",
					username: "erin",
					email: "erin@acme.test",
					firstName: "Erin",
					lastName: "Example",
					createdTimestamp: 20,
				},
				{ id: "sa-sub", username: "service-account-maple-admin", createdTimestamp: 1 },
				{
					id: "sa2-sub",
					username: "service-account-other",
					email: "bot@acme.test",
					createdTimestamp: 2,
				},
				{ id: "noemail-sub", username: "noemail", email: "", createdTimestamp: 3 },
				{ id: "frank-sub", username: "frank", email: "frank@acme.test", createdTimestamp: 10 },
			])
			return run(
				createTestDb(trackedDbs),
				ADMIN_ENV,
				keycloak.client,
				Effect.gen(function* () {
					const admin = yield* KeycloakAdmin
					const pending = yield* admin.listUnverified(ROOT)
					assert.deepStrictEqual(
						Arr.map(pending.users, (user) => [user.id, user.email, user.name, user.createdAt]),
						[
							["frank-sub", "frank@acme.test", null, 10],
							["erin-sub", "erin@acme.test", "Erin Example", 20],
						],
					)
					const search = Arr.findFirst(
						keycloak.captured,
						(request) => request.url === `${ADMIN_URL}/users`,
					)
					assert.strictEqual(Option.getOrThrow(search).params.get("emailVerified"), "false")
				}),
			)
		},
	)

	it.effect(
		"listUnverified adds unverified Maple users Keycloak did not return, and no verified ones",
		() => {
			const keycloak = fakeKeycloak(undefined, [
				{ id: "bob-sub", username: "bob", email: "bob@acme.test", createdTimestamp: 2 },
			])
			return run(
				createTestDb(trackedDbs),
				ADMIN_ENV,
				keycloak.client,
				Effect.gen(function* () {
					const admin = yield* KeycloakAdmin
					yield* insertUser("alice-sub", "alice@acme.test", true, 1)
					yield* insertUser("bob-sub", "bob@acme.test", false, 2)
					yield* insertUser("carol-sub", "carol@acme.test", false, 3)

					const pending = yield* admin.listUnverified(ROOT)
					assert.deepStrictEqual(
						Arr.map(pending.users, (user) => [user.id, user.email, user.createdAt]),
						[
							["bob-sub", "bob@acme.test", 2],
							["carol-sub", "carol@acme.test", 3],
						],
					)
				}),
			)
		},
	)

	it.effect("an org admin is forbidden every verification action and reaches no IdP", () => {
		const keycloak = fakeKeycloak({ id: "bob-sub" })
		return run(
			createTestDb(trackedDbs),
			ADMIN_ENV,
			keycloak.client,
			Effect.gen(function* () {
				const admin = yield* KeycloakAdmin
				const bob = asUserId("bob-sub")
				const exits = [
					yield* Effect.exit(admin.listUnverified(ORG_ADMIN)),
					yield* Effect.exit(admin.resendVerification(ORG_ADMIN, bob)),
					yield* Effect.exit(admin.markVerified(ORG_ADMIN, bob)),
				]
				for (const exit of exits) assert.instanceOf(failureOf(exit), DirectoryForbiddenError)
				assert.deepStrictEqual(keycloak.captured, [])
			}),
		)
	})

	it.effect("without the admin URL and secret the IdP actions report not configured", () => {
		const keycloak = fakeKeycloak({ id: "bob-sub" })
		return run(
			createTestDb(trackedDbs),
			BASE_ENV,
			keycloak.client,
			Effect.gen(function* () {
				const admin = yield* KeycloakAdmin
				const bob = asUserId("bob-sub")
				const resend = yield* Effect.exit(admin.resendVerification(ROOT, bob))
				const mark = yield* Effect.exit(admin.markVerified(ROOT, bob))
				assert.instanceOf(failureOf(resend), DirectoryDisabledError)
				assert.instanceOf(failureOf(mark), DirectoryDisabledError)
				assert.deepStrictEqual(keycloak.captured, [])
			}),
		)
	})
})
