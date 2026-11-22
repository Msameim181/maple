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
// 2026-11-22 12:00 UTC.
const NOW = Date.UTC(2026, 10, 22, 12)

type Row = Record<string, unknown>
const part = (database: string, table: string, partition: string, bytes: number): Row => ({
	database,
	table,
	partition,
	bytes: String(bytes),
})
// system.parts.partition reads `2026-10-01` for toDate(); only partition_id is `20261001`.
const ACME_TRACES = [
	part("org_acme", "traces", "20261001", 100),
	part("org_acme", "traces", "20261115", 50),
	part("org_acme", "traces", "20261120", 10),
	part("org_acme", "traces", "202610", 999), // monthly id, never dropped
	part("org_acme", "traces", "2026'; DROP", 1), // malformed, never dropped
]

interface Options {
	readonly instanceMax?: string
	readonly instanceMaxBytes?: string
	readonly minFree?: string
	/** The ClickHouse server's today(), which need not match the UTC clock. */
	readonly today?: string
	readonly parts?: ReadonlyArray<Row>
	readonly disk?: { readonly free: number; readonly total: number }
}

const harness = (options: Options = {}) => {
	const testDb = createTestDb(trackedDbs)
	const executed: Array<string> = []
	const queried: Array<string> = []
	const parts = options.parts ?? ACME_TRACES
	const admin = Layer.succeed(ClickHouseAdmin)({
		exec: (sql) => Effect.sync(() => void executed.push(sql)),
		query: (sql) =>
			Effect.sync(() => {
				queried.push(sql)
				if (sql.includes("today()")) return [{ today: options.today ?? "20261122" }]
				if (sql.includes("system.disks")) return [options.disk ?? { free: 50, total: 100 }]
				const org = /database = '(\w+)'/u.exec(sql)?.[1]
				if (sql.includes("partition_id AS partition"))
					return parts.filter((p) => org === undefined || p.database === org)
				return []
			}),
	})
	const base = {
		PORT: "3472",
		TINYBIRD_HOST: "https://api.tinybird.co",
		TINYBIRD_TOKEN: "test-token",
		MAPLE_AUTH_MODE: "self_hosted",
		MAPLE_ROOT_PASSWORD: "test-root-password",
		MAPLE_DEFAULT_ORG_ID: "default",
		MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "lookup-key",
	}
	const config = new Map<string, string>(Object.entries(base))
	if (options.instanceMax !== undefined) config.set("MAPLE_RETENTION_MAX_DAYS", options.instanceMax)
	if (options.instanceMaxBytes !== undefined) config.set("MAPLE_RETENTION_MAX_BYTES", options.instanceMaxBytes)
	if (options.minFree !== undefined) config.set("MAPLE_CLICKHOUSE_MIN_FREE_PERCENT", options.minFree)
	const env = Env.layer.pipe(
		Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(Object.fromEntries(config)))),
	)
	const layer = Layer.effect(RetentionService, RetentionService.make).pipe(
		Layer.provide(Layer.mergeAll(admin, env, testDb.layer)),
	)
	const run = <A, E>(body: Effect.Effect<A, E, RetentionService>) => body.pipe(Effect.provide(layer))
	return { executed, queried, run }
}

const save = (days: number | null, bytes: number | null = null) =>
	Effect.flatMap(RetentionService, (s) =>
		s.set(ACME, USER, ADMIN, new OrgRetentionUpsertRequest({ maxAgeDays: days, maxBytes: bytes })),
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
				assert.strictEqual(report?.dropped[0]?.reason, "age")
				assert.deepStrictEqual(h.executed, ["ALTER TABLE `org_acme`.`traces` DROP PARTITION ID '20261001'"])
				assert.isTrue(h.queried.filter((q) => q.includes("system.parts")).every((q) => q.includes("database = 'org_acme'")))
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
		const h = harness({ instanceMax: "3" })
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
				const exits: Array<Exit.Exit<unknown, unknown>> = [
					yield* Effect.exit(s.get(ACME, MEMBER)),
					yield* Effect.exit(s.storage(ACME, MEMBER)),
					yield* Effect.exit(s.set(ACME, USER, MEMBER, new OrgRetentionUpsertRequest({ maxAgeDays: 5, maxBytes: null }))),
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

const SIZED = [
	part("org_acme", "traces", "20261101", 100),
	part("org_acme", "traces", "20261110", 100),
	part("org_acme", "traces", "20261120", 100),
	part("org_acme", "traces", "20261122", 100), // today
	part("org_acme", "logs", "20261101", 50),
	part("org_acme", "logs", "20261121", 50), // newest of its table
	part("org_acme", "traces_hourly", "202611", 500), // not an allowlisted raw table, still counted
]
const names = (xs: ReadonlyArray<{ table: string; partition: string }>) => xs.map((d) => `${d.table} ${d.partition}`)

describe("RetentionService limits", () => {
	it.effect("size cap drops the oldest partitions across tables until under, largest table first on a tie", () => {
		const h = harness({ parts: SIZED })
		return h.run(
			Effect.gen(function* () {
				yield* TestClock.setTime(NOW)
				yield* save(null, 800)
				const [report] = yield* (yield* RetentionService).sweep()
				assert.deepStrictEqual(names(report?.dropped ?? []), [
					"traces 20261101",
					"logs 20261101",
					"traces 20261110",
				])
				assert.isTrue(report?.dropped.every((d) => d.reason === "size"))
			}),
		)
	})

	it.effect("an unreachable cap never drops today's partition or the newest one of a table", () => {
		const h = harness({ parts: SIZED })
		return h.run(
			Effect.gen(function* () {
				yield* TestClock.setTime(NOW)
				yield* save(null, 1)
				const [report] = yield* (yield* RetentionService).sweep()
				assert.deepStrictEqual(names(report?.dropped ?? []).sort(), [
					"logs 20261101",
					"traces 20261101",
					"traces 20261110",
					"traces 20261120",
				])
			}),
		)
	})

	it.effect("age and size both apply, and the instance ceiling clamps the saved cap", () => {
		const h = harness({ parts: SIZED, instanceMaxBytes: "800" })
		return h.run(
			Effect.gen(function* () {
				yield* TestClock.setTime(NOW)
				assert.strictEqual((yield* save(7, 5000)).maxBytes, 800)
				const [report] = yield* (yield* RetentionService).sweep()
				// 7 days: 20261101 and 20261110 expire by age; the cap is then met without more drops.
				assert.deepStrictEqual(
					report?.dropped.map((d) => d.reason),
					["age", "age", "age"],
				)
				assert.deepStrictEqual(names(report?.dropped ?? []).sort(), ["logs 20261101", "traces 20261101", "traces 20261110"])
			}),
		)
	})

	it.effect("the cutoff follows the server's today(), not the UTC clock", () => {
		// The server is a day ahead of UTC: 7 days back is 20261116, so 20261115 is expired too.
		const h = harness({ today: "20261123" })
		return h.run(
			Effect.gen(function* () {
				yield* TestClock.setTime(NOW)
				yield* save(7)
				const [report] = yield* (yield* RetentionService).sweep()
				assert.deepStrictEqual(
					report?.dropped.map((d) => d.partition),
					["20261001", "20261115"],
				)
			}),
		)
	})

	it.effect("free-disk guard drops the oldest partitions of every org, regardless of org settings", () => {
		const h = harness({
			minFree: "10",
			disk: { free: 5, total: 100 },
			parts: [
				part("org_acme", "traces", "20261001", 5),
				part("org_acme", "traces", "20261120", 5),
				part("org_beta", "traces", "20261001", 4),
				part("org_beta", "traces", "20261120", 5),
			],
		})
		return h.run(
			Effect.gen(function* () {
				yield* TestClock.setTime(NOW)
				const reports = yield* (yield* RetentionService).sweep()
				assert.deepStrictEqual(
					reports.map((r) => [r.orgId, r.dropped.map((d) => `${d.reason} ${d.partition}`)]),
					[
						["acme", ["disk 20261001"]],
						["beta", ["disk 20261001"]],
					],
				)
				assert.strictEqual(h.executed.length, 2)
			}),
		)
	})

	it.effect("free-disk guard does nothing above the threshold", () => {
		const h = harness({ minFree: "10", disk: { free: 50, total: 100 } })
		return h.run(
			Effect.gen(function* () {
				yield* TestClock.setTime(NOW)
				assert.deepStrictEqual(yield* (yield* RetentionService).sweep(), [])
				assert.deepStrictEqual(h.executed, [])
			}),
		)
	})
})
