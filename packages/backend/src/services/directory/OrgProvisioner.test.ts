import { afterEach, assert, describe, it } from "@effect/vitest"
import {
	CreateOrgRequest,
	DirectoryConflictError,
	OrgId,
	RoleName,
	type TenantContext,
	UnauthorizedError,
	UserId,
} from "@maple/domain/http"
import { type EdgeCacheBackend, EdgeCacheService, makeEdgeCacheService } from "@maple/cache"
import { ConfigProvider, Effect, Exit, Layer, Option, Schema, Array as Arr } from "effect"
import { FetchHttpClient } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { SchemaApplyWorkflow } from "@maple/backend/platform/bindings"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/testing/test-pglite"
import { AutumnClient } from "@maple/backend/services/billing/autumn-http"
import { OrgClickHouseSettingsService } from "@maple/backend/services/org/OrgClickHouseSettingsService"
import { OrganizationRegionService } from "@maple/backend/services/org/OrganizationRegionService"
import { OrganizationService } from "@maple/backend/services/org/OrganizationService"
import { DirectoryService } from "./DirectoryService"
import { EmailService } from "@maple/backend/platform/EmailService"
import { OidcClient } from "./OidcClient"
import { ClickHouseAdmin, OrgProvisioner } from "./OrgProvisioner"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const SELFHOST_CLICKHOUSE_URL = "http://clickhouse:8123"
const ACME = Schema.decodeSync(OrgId)("acme")
const ROOT: TenantContext = {
	orgId: Schema.decodeSync(OrgId)("default"),
	userId: Schema.decodeSync(UserId)("root"),
	roles: [Schema.decodeSync(RoleName)("root")],
	authMode: "self_hosted",
}

const missBackend: EdgeCacheBackend = {
	name: "memory",
	get: () => Effect.undefined,
	put: () => Effect.void,
	delete: () => Effect.void,
}

/**
 * The real BYO settings and org purge over PGlite; ClickHouse admin DDL is recorded instead of sent.
 * The BYO save's own `SELECT 1` goes through `fetch`, recorded in `byoRequests`.
 */
const makeHarness = (testDb: TestDb) => {
	const statements: Array<string> = []
	const byoRequests: Array<{ url: string; user: string | null; key: string | null }> = []
	const fetchImpl: typeof globalThis.fetch = async (input, init) => {
		const headers = new Headers(init?.headers)
		byoRequests.push({
			url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
			user: headers.get("X-ClickHouse-User"),
			key: headers.get("X-ClickHouse-Key"),
		})
		return new Response("1\n", { status: 200 })
	}
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
					MAPLE_OIDC_TOKEN_URL: "http://keycloak.test/token",
					MAPLE_OIDC_CLIENT_ID: "maple-web",
					MAPLE_SELFHOST_CLICKHOUSE_URL: SELFHOST_CLICKHOUSE_URL,
					MAPLE_SELFHOST_CLICKHOUSE_ADMIN_USER: "admin",
					MAPLE_SELFHOST_CLICKHOUSE_ADMIN_PASSWORD: "admin-password",
				}),
			),
		),
	)
	const admin = Layer.succeed(ClickHouseAdmin)({
		exec: (sql) => Effect.sync(() => void statements.push(sql)),
	})
	const organizations = Layer.effect(OrganizationService, OrganizationService.make).pipe(
		Layer.provide(
			Layer.mergeAll(AutumnClient.layer, OrganizationRegionService.servesAll, FetchHttpClient.layer),
		),
	)
	const provisioner = Layer.effect(OrgProvisioner, OrgProvisioner.make).pipe(
		Layer.provide(Layer.mergeAll(admin, OrgClickHouseSettingsService.layer, organizations)),
	)
	const noOidc = Layer.succeed(OidcClient)({
		exchange: () => Effect.fail(new UnauthorizedError({ message: "not used" })),
	})
	const noEmail = Layer.succeed(EmailService)({ isConfigured: false, send: () => Effect.void })
	const directory = Layer.effect(DirectoryService, DirectoryService.make).pipe(
		Layer.provide(Layer.mergeAll(provisioner, noOidc, noEmail)),
	)
	const layer = Layer.mergeAll(directory, OrgClickHouseSettingsService.layer).pipe(
		Layer.provide(
			Layer.mergeAll(
				env,
				testDb.layer,
				Layer.succeed(EdgeCacheService)(makeEdgeCacheService(missBackend)),
				Layer.succeed(SchemaApplyWorkflow)({ create: () => Effect.void }),
			),
		),
	)
	const run = <A, E>(body: Effect.Effect<A, E, DirectoryService | OrgClickHouseSettingsService>) =>
		body.pipe(Effect.provide(layer), Effect.provideService(FetchHttpClient.Fetch, fetchImpl))
	return { statements, byoRequests, run }
}

const createAcme = Effect.flatMap(DirectoryService, (directory) =>
	directory.createOrg(
		ROOT,
		new CreateOrgRequest({ id: ACME, name: "Acme", adminEmail: "alice@acme.test" }),
	),
)

describe("OrgProvisioner", () => {
	it.effect(
		"provision issues create database, user, grant in order, then upserts BYO with database org_acme",
		() => {
			const testDb = createTestDb(trackedDbs)
			const harness = makeHarness(testDb)
			return harness.run(
				Effect.gen(function* () {
					yield* createAcme

					const password = /IDENTIFIED BY '([0-9a-f]{32})'/.exec(harness.statements[1] ?? "")?.[1]
					assert.isDefined(password)
					assert.deepStrictEqual(harness.statements, [
						"CREATE DATABASE IF NOT EXISTS `org_acme`",
						`CREATE USER IF NOT EXISTS \`org_acme\` IDENTIFIED BY '${password}'`,
						`ALTER USER \`org_acme\` IDENTIFIED BY '${password}'`,
						"GRANT ALL ON `org_acme`.* TO `org_acme`",
					])

					// The org's queries now route to its own database, as its own user, never the shared credential.
					const byo = yield* OrgClickHouseSettingsService
					const runtime = yield* byo.resolveRuntimeConfig(ACME)
					assert.deepStrictEqual(Option.getOrUndefined(runtime), {
						backend: "clickhouse",
						url: SELFHOST_CLICKHOUSE_URL,
						user: "org_acme",
						password,
						database: "org_acme",
					})
					// The BYO save checked the connection with the new user's credentials over plain HTTP.
					assert.deepStrictEqual(
						Arr.map(harness.byoRequests, (request) => [request.url, request.user, request.key]),
						[[`${SELFHOST_CLICKHOUSE_URL}/?database=org_acme`, "org_acme", password]],
					)
					const run = yield* Effect.promise(() =>
						queryFirstRow<{ status: string }>(
							testDb,
							"SELECT status FROM org_clickhouse_schema_apply_runs WHERE org_id = $1",
							[ACME],
						),
					)
					assert.strictEqual(run?.status, "queued")
				}),
			)
		},
	)

	it.effect("purge drops database and user and removes org row; slug then reusable", () => {
		const testDb = createTestDb(trackedDbs)
		const harness = makeHarness(testDb)
		return harness.run(
			Effect.gen(function* () {
				const directory = yield* DirectoryService
				const byo = yield* OrgClickHouseSettingsService
				yield* createAcme
				harness.statements.length = 0

				yield* directory.deleteOrg(ROOT, ACME)

				assert.deepStrictEqual(harness.statements, [
					"DROP DATABASE IF EXISTS `org_acme`",
					"DROP USER IF EXISTS `org_acme`",
				])
				assert.deepStrictEqual((yield* directory.listOrgs(ROOT)).orgs, [])
				assert.isTrue(Option.isNone(yield* byo.resolveRuntimeConfig(ACME)))
				const invitations = yield* Effect.promise(() =>
					queryFirstRow<{ n: number }>(
						testDb,
						"SELECT count(*)::int AS n FROM directory_invitations WHERE org_id = $1",
						[ACME],
					),
				)
				assert.strictEqual(invitations?.n, 0)
				// A stale schema-apply run would block the re-created org's first apply.
				const applyRuns = yield* Effect.promise(() =>
					queryFirstRow<{ n: number }>(
						testDb,
						"SELECT count(*)::int AS n FROM org_clickhouse_schema_apply_runs WHERE org_id = $1",
						[ACME],
					),
				)
				assert.strictEqual(applyRuns?.n, 0)

				const recreated = yield* createAcme
				assert.strictEqual(recreated.status, "active")
				assert.deepStrictEqual(
					Arr.map((yield* directory.listOrgs(ROOT)).orgs, (org) => org.id),
					[ACME],
				)
			}),
		)
	})

	it.effect("create org rejects slug of an org still deleting", () => {
		const testDb = createTestDb(trackedDbs)
		const harness = makeHarness(testDb)
		return harness.run(
			Effect.gen(function* () {
				yield* Effect.promise(() =>
					executeSql(
						testDb,
						"INSERT INTO directory_orgs (id, name, status, created_at, created_by) VALUES ($1, 'Acme', 'deleting', now(), 'root')",
						[ACME],
					),
				)

				const exit = yield* Effect.exit(createAcme)

				assert.instanceOf(Option.getOrUndefined(Exit.findErrorOption(exit)), DirectoryConflictError)
				assert.deepStrictEqual(harness.statements, [])
				assert.deepStrictEqual(harness.byoRequests, [])
			}),
		)
	})
})
