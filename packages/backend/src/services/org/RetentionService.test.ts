import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, RoleName, UserId, OrgRetentionUpsertRequest } from "@maple/domain/http"
import { ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import { TestClock } from "effect/testing"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { ClickHouseAdmin } from "@maple/backend/services/directory/OrgProvisioner"
import { RetentionService } from "./RetentionService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ACME = Schema.decodeSync(OrgId)("acme")
const USER = Schema.decodeSync(UserId)("alice")
const ADMIN = [Schema.decodeSync(RoleName)("org:admin")]
const MEMBER = [Schema.decodeSync(RoleName)("org:member")]
// 2026-11-22 12:00 UTC; with 7 days the cutoff partition is 20261115.
const NOW = Date.UTC(2026, 10, 22, 12)

const harness = (instanceMax?: string) => {
	const testDb = createTestDb(trackedDbs)
	const executed: Array<string> = []
	const queried: Array<string> = []
	const admin = Layer.succeed(ClickHouseAdmin)({
		exec: (sql) => Effect.sync(() => void executed.push(sql)),
		query: (sql) =>
			Effect.sync(() => {
				queried.push(sql)
				// system.parts.partition reads `2026-10-01` for toDate(); only partition_id is `20261001`.
				if (!sql.includes("table = 'traces'") || !sql.includes("partition_id AS partition")) return []
				return [
					{ partition: "20261001", bytes: "100" },
					{ partition: "20261115", bytes: "50" },
					{ partition: "20261120", bytes: "10" },
					{ partition: "202610", bytes: "999" }, // monthly id, never dropped
					{ partition: "2026'; DROP", bytes: "1" }, // malformed, never dropped
				]
			}),
	})
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
					...(instanceMax === undefined ? {} : { MAPLE_RETENTION_MAX_DAYS: instanceMax }),
				}),
			),
		),
	)
	const layer = Layer.effect(RetentionService, RetentionService.make).pipe(
		Layer.provide(Layer.mergeAll(admin, env, testDb.layer)),
	)
	const run = <A, E>(body: Effect.Effect<A, E, RetentionService>) => body.pipe(Effect.provide(layer))
	return { executed, queried, run }
}

const save = (days: number | null) =>
	Effect.flatMap(RetentionService, (s) =>
		s.set(ACME, USER, ADMIN, new OrgRetentionUpsertRequest({ maxAgeDays: days })),
	)

describe("RetentionService", () => {
	it.effect("sweep drops only expired daily partitions of allowlisted tables", () => {
		const h = harness()
		return h.run(
			Effect.gen(function* () {
				yield* TestClock.setTime(NOW)
				yield* save(7)
				const s = yield* RetentionService
				const [report] = yield* s.sweep()
				assert.deepStrictEqual(
					report?.dropped.map((d) => d.partition),
					["20261001"],
				)
				assert.deepStrictEqual(h.executed, ["ALTER TABLE `org_acme`.`traces` DROP PARTITION ID '20261001'"])
				assert.isTrue(h.queried.every((q) => q.includes("database = 'org_acme'")))
				const row = yield* s.get(ACME, ADMIN)
				assert.strictEqual(row.lastSweepDropped, 1)
			}),
		)
	})

	it.effect("dry run reports but drops nothing and records nothing", () => {
		const h = harness()
		return h.run(
			Effect.gen(function* () {
				yield* TestClock.setTime(NOW)
				yield* save(7)
				const s = yield* RetentionService
				const [report] = yield* s.sweep({ dryRun: true })
				assert.strictEqual(report?.dropped.length, 1)
				assert.deepStrictEqual(h.executed, [])
				assert.isNull((yield* s.get(ACME, ADMIN)).lastSweepAt)
			}),
		)
	})

	it.effect("a null max age is skipped, and the instance ceiling clamps the saved value", () => {
		const h = harness("3")
		return h.run(
			Effect.gen(function* () {
				const s = yield* RetentionService
				assert.strictEqual((yield* save(30)).maxAgeDays, 3)
				yield* save(null)
				assert.deepStrictEqual(yield* s.sweep(), [])
				assert.deepStrictEqual(h.queried, [])
			}),
		)
	})

	it.effect("non-admins are refused every call", () => {
		const h = harness()
		return h.run(
			Effect.gen(function* () {
				const s = yield* RetentionService
				const exits = [
					yield* Effect.exit(s.get(ACME, MEMBER)),
					yield* Effect.exit(s.storage(ACME, MEMBER)),
					yield* Effect.exit(s.set(ACME, USER, MEMBER, new OrgRetentionUpsertRequest({ maxAgeDays: 5 }))),
				]
				for (const exit of exits) assert.isTrue(Exit.isFailure(exit))
				assert.deepStrictEqual(h.queried, [])
			}),
		)
	})

	it.effect("storage reads system.parts for the org database", () => {
		const h = harness()
		return h.run(
			Effect.gen(function* () {
				const s = yield* RetentionService
				const storage = yield* s.storage(ACME, ADMIN)
				assert.strictEqual(storage.database, "org_acme")
				assert.isTrue(Option.isSome(Option.some(h.queried[0])) && h.queried[0]!.includes("system.parts"))
			}),
		)
	})
})
