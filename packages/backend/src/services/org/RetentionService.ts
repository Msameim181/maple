import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgRetentionSettings, type OrgRetentionSettingsRow } from "@maple/db/tables"
import {
	DIRECTORY_ORG_ID_PATTERN,
	OrgClickHouseSettingsForbiddenError,
	OrgClickHouseSettingsPersistenceError,
	OrgClickHouseSettingsValidationError,
	type OrgId,
	OrgRetentionResponse,
	type OrgRetentionUpsertRequest,
	OrgStorageResponse,
	OrgStorageTable,
	RETENTION_TABLE_TTL_DAYS,
	type RoleName,
	type UserId,
} from "@maple/domain/http"
import { IsoDateTimeString } from "@maple/primitives"
import * as Policy from "@maple/domain/policy"
import { Clock, Context, Effect, Layer, Option, Schema, Array as Arr } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { ClickHouseAdmin, orgDatabaseName } from "@maple/backend/services/directory/OrgProvisioner"

const toIso = Schema.decodeSync(IsoDateTimeString)
/** Per-sweep ceiling on free-disk drops: dropped parts free space only after ClickHouse removes them, minutes later. */
const MAX_DISK_DROPS = 20
/** The disk guard drops until free space is this many percentage points above the threshold. */
const DISK_MARGIN_PERCENT = 2
/** Org databases (`org_<slug>`): the only databases a drop may name. */
const ORG_DATABASE = /^org_[a-z0-9_]+$/u
/** Daily partitions (`toDate(...)`) have partition_id like `20261101` (`partition` reads `2026-11-01`, which `DROP PARTITION ID` rejects); anything else is never dropped. */
const DAILY_PARTITION = /^\d{8}$/u
/** The table allowlist: raw tables only, never input. */
const SWEEP_TABLES = Object.keys(RETENTION_TABLE_TTL_DAYS) as ReadonlyArray<keyof typeof RETENTION_TABLE_TTL_DAYS>

export type DropReason = "age" | "size" | "disk"

interface Part {
	readonly db: string
	readonly table: string
	readonly partition: string
	readonly bytes: number
}

const parseParts = (rows: ReadonlyArray<Record<string, unknown>>): ReadonlyArray<Part> =>
	rows
		.map((r) => ({ db: String(r.database), table: String(r.table), partition: String(r.partition), bytes: Number(r.bytes) }))
		.filter((p) => ORG_DATABASE.test(p.db))

const isDailyRaw = (p: Part) =>
	DAILY_PARTITION.test(p.partition) && (SWEEP_TABLES as ReadonlyArray<string>).includes(p.table)

/** Calendar arithmetic on a YYYYMMDD id, so it holds in any server timezone. */
const minusDays = (id: string, days: number) =>
	new Date(Date.UTC(Number(id.slice(0, 4)), Number(id.slice(4, 6)) - 1, Number(id.slice(6, 8)) - days))
		.toISOString()
		.slice(0, 10)
		.replaceAll("-", "")

/**
 * Size and disk candidates, oldest partition first (largest table breaks ties). Never today's
 * partition, and never the newest daily partition of a table.
 */
const droppable = (parts: ReadonlyArray<Part>, today: string): ReadonlyArray<Part> => {
	const newest = new Map<string, string>()
	const tableBytes = new Map<string, number>()
	const daily = parts.filter(isDailyRaw)
	for (const p of daily) {
		const key = `${p.db}.${p.table}`
		if (p.partition > (newest.get(key) ?? "")) newest.set(key, p.partition)
		tableBytes.set(key, (tableBytes.get(key) ?? 0) + p.bytes)
	}
	return daily
		.filter((p) => p.partition < today && p.partition !== newest.get(`${p.db}.${p.table}`))
		.sort(
			(a, b) =>
				a.partition.localeCompare(b.partition) ||
				(tableBytes.get(`${b.db}.${b.table}`) ?? 0) - (tableBytes.get(`${a.db}.${a.table}`) ?? 0),
		)
}

/** The org id of an `org_<slug>` database; slugs never contain `_`, so the mapping is one to one. */
const orgIdOfDatabase = (db: string) => db.slice(4).replaceAll("_", "-")

const persistence = (error: unknown) =>
	new OrgClickHouseSettingsPersistenceError({
		message: error instanceof Error ? error.message : "Retention persistence failed",
	})

export interface DroppedPartition {
	readonly database: string
	readonly reason: DropReason
	readonly table: string
	readonly partition: string
	readonly bytes: number
}
export interface OrgSweepReport {
	readonly orgId: string
	readonly dropped: ReadonlyArray<DroppedPartition>
	readonly error: string | null
}

export interface RetentionServiceApi {
	readonly get: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<OrgRetentionResponse, OrgClickHouseSettingsForbiddenError | OrgClickHouseSettingsPersistenceError>
	readonly set: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		request: OrgRetentionUpsertRequest,
	) => Effect.Effect<
		OrgRetentionResponse,
		| OrgClickHouseSettingsForbiddenError
		| OrgClickHouseSettingsValidationError
		| OrgClickHouseSettingsPersistenceError
	>
	readonly storage: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
	) => Effect.Effect<OrgStorageResponse, OrgClickHouseSettingsForbiddenError | OrgClickHouseSettingsPersistenceError>
	/**
	 * Drops daily partitions: past each org's max age, then oldest-first while an org is over its size
	 * cap, and, below the free-disk threshold, oldest-first across all orgs. `dryRun` only reports them.
	 */
	readonly sweep: (options?: {
		readonly dryRun?: boolean
	}) => Effect.Effect<ReadonlyArray<OrgSweepReport>, OrgClickHouseSettingsPersistenceError>
}

export class RetentionService extends Context.Service<RetentionService, RetentionServiceApi>()(
	"@maple/backend/services/RetentionService",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "RetentionService", persistence)
			const admin = yield* ClickHouseAdmin
			const instanceMax = Option.getOrNull(env.MAPLE_RETENTION_MAX_DAYS)
			const instanceMaxBytes = Option.getOrNull(env.MAPLE_RETENTION_MAX_BYTES)
			const minFreePercent = Option.getOrNull(env.MAPLE_CLICKHOUSE_MIN_FREE_PERCENT)

			const requireAdmin = (roles: ReadonlyArray<RoleName>) =>
				Policy.check(
					roles,
					"warehouse:manage",
					(denial) => new OrgClickHouseSettingsForbiddenError({ message: denial.message }),
				)

			// The name is spliced into SQL, so the slug shape is re-checked here, not trusted.
			const dbNameFor = (orgId: OrgId) =>
				DIRECTORY_ORG_ID_PATTERN.test(orgId)
					? Effect.succeed(orgDatabaseName(orgId))
					: Effect.fail(new OrgClickHouseSettingsValidationError({ message: `Invalid organization id: ${orgId}` }))

			const selectRow = (orgId: OrgId) =>
				dbExecute((db) =>
					db.run(
						PG.from(OrgRetentionSettings)
							.select()
							.where(($) => [$.orgId.eq(orgId)])
							.limit(1),
					),
				).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])))

			const toResponse = (row: Option.Option<OrgRetentionSettingsRow>) =>
				new OrgRetentionResponse({
					maxAgeDays: Option.isSome(row) ? row.value.maxAgeDays : null,
					maxBytes: Option.isSome(row) && row.value.maxBytes !== null ? Number(row.value.maxBytes) : null,
					instanceMaxDays: instanceMax,
					instanceMaxBytes,
					lastSweepAt:
						Option.isSome(row) && row.value.lastSweepAt !== null
							? toIso(new Date(row.value.lastSweepAt).toISOString())
							: null,
					lastSweepDropped: Option.isSome(row) ? row.value.lastSweepDropped : null,
				})

			const get = Effect.fn("RetentionService.get")(function* (orgId: OrgId, roles: ReadonlyArray<RoleName>) {
				yield* requireAdmin(roles)
				return toResponse(yield* selectRow(orgId))
			})

			const set = Effect.fn("RetentionService.set")(function* (
				orgId: OrgId,
				userId: UserId,
				roles: ReadonlyArray<RoleName>,
				request: OrgRetentionUpsertRequest,
			) {
				yield* requireAdmin(roles)
				// The instance ceiling clamps rather than rejects, so a stale UI value still saves.
				const maxAgeDays =
					request.maxAgeDays !== null && instanceMax !== null
						? Math.min(request.maxAgeDays, instanceMax)
						: request.maxAgeDays
				const maxBytes =
					request.maxBytes !== null && instanceMaxBytes !== null
						? Math.min(request.maxBytes, instanceMaxBytes)
						: request.maxBytes
				const now = yield* Clock.currentTimeMillis
				yield* dbExecute((db) =>
					db.run(
						PG.insertInto(OrgRetentionSettings)
							.values({
								orgId,
								maxAgeDays,
								maxBytes,
								lastSweepAt: null,
								lastSweepDropped: null,
								updatedBy: userId,
								updatedAt: now,
							})
							.onConflictDoUpdate({
								target: ["orgId"],
								set: { maxAgeDays, maxBytes, updatedBy: userId, updatedAt: now },
							}),
					),
				)
				return toResponse(yield* selectRow(orgId))
			})

			const storageOf = (orgId: OrgId) =>
				Effect.gen(function* () {
					const name = yield* dbNameFor(orgId)
					const rows = yield* admin.query(
						`SELECT table, sum(rows) AS rows, sum(bytes_on_disk) AS bytes, uniqExact(partition_id) AS partitions, min(partition_id) AS oldest FROM system.parts WHERE database = '${name}' AND active GROUP BY table ORDER BY bytes DESC`,
					)
					const tables = Arr.map(rows, (row) => {
						const oldest = String(row.oldest ?? "")
						return new OrgStorageTable({
							table: String(row.table),
							rows: Number(row.rows),
							bytes: Number(row.bytes),
							partitions: Number(row.partitions),
							oldestPartition: DAILY_PARTITION.test(oldest) ? oldest : null,
						})
					})
					return new OrgStorageResponse({
						database: name,
						totalBytes: Arr.reduce(tables, 0, (sum, t) => sum + t.bytes),
						tables,
					})
				})

			const storage = Effect.fn("RetentionService.storage")(function* (
				orgId: OrgId,
				roles: ReadonlyArray<RoleName>,
			) {
				yield* requireAdmin(roles)
				return yield* storageOf(orgId).pipe(
					Effect.catchTag("@maple/http/errors/OrgClickHouseSettingsValidationError", (e) =>
						Effect.fail(new OrgClickHouseSettingsPersistenceError({ message: e.message })),
					),
					Effect.catchTag("@maple/http/errors/DirectoryPersistenceError", (e) =>
						Effect.fail(new OrgClickHouseSettingsPersistenceError({ message: e.message })),
					),
				)
			})

			const dropPart = (p: Part, reason: DropReason, dryRun: boolean) =>
				Effect.gen(function* () {
					yield* Effect.logInfo("Retention: dropping partition").pipe(
						Effect.annotateLogs({
							orgId: orgIdOfDatabase(p.db),
							table: p.table,
							partition: p.partition,
							bytes: p.bytes,
							reason,
							dryRun,
						}),
					)
					if (!dryRun)
						yield* admin.exec(`ALTER TABLE \`${p.db}\`.\`${p.table}\` DROP PARTITION ID '${p.partition}'`)
					return { database: p.db, reason, table: p.table, partition: p.partition, bytes: p.bytes }
				})

			/** Drops `droppable` parts, oldest first, until `done(bytesFreed)` or `limit` drops. Pushes into `out` so a failure keeps the earlier drops. */
			const dropOldest = (
				parts: ReadonlyArray<Part>,
				today: string,
				reason: DropReason,
				dryRun: boolean,
				done: (freed: number) => boolean,
				limit: number,
				out: Array<DroppedPartition>,
			) =>
				Effect.gen(function* () {
					let freed = 0
					let count = 0
					for (const p of droppable(parts, today)) {
						if (done(freed) || count >= limit) break
						out.push(yield* dropPart(p, reason, dryRun))
						freed += p.bytes
						count += 1
					}
				})

			// today() follows the ClickHouse server's timezone, which is what toDate() partitions by.
			const serverToday = admin
				.query("SELECT toYYYYMMDD(today()) AS today")
				.pipe(
					Effect.mapError(persistence),
					Effect.flatMap((rows) => {
						const today = String(rows[0]?.today)
						return DAILY_PARTITION.test(today)
							? Effect.succeed(today)
							: Effect.fail(persistence(new Error("ClickHouse returned no date")))
					}),
				)

			const sweepOrg = (orgId: OrgId, maxAgeDays: number | null, maxBytes: number | null, today: string, dryRun: boolean) =>
				Effect.gen(function* () {
					const name = yield* dbNameFor(orgId)
					let parts = parseParts(
						yield* admin.query(
							`SELECT database, table, partition_id AS partition, sum(bytes_on_disk) AS bytes FROM system.parts WHERE database = '${name}' AND active GROUP BY database, table, partition_id`,
						),
					)
					const dropped: Array<DroppedPartition> = []
					if (maxAgeDays !== null) {
						const expired = parts
							.filter((p) => {
								if (!isDailyRaw(p)) return false
								// A larger N than the shipped TTL has no effect: the TTL already removes that data.
								const days = Math.min(maxAgeDays, RETENTION_TABLE_TTL_DAYS[p.table as keyof typeof RETENTION_TABLE_TTL_DAYS])
								return p.partition < minusDays(today, days)
							})
							.sort((a, b) => a.partition.localeCompare(b.partition))
						for (const p of expired) dropped.push(yield* dropPart(p, "age", dryRun))
						parts = parts.filter((p) => !expired.includes(p))
					}
					if (maxBytes !== null) {
						const total = parts.reduce((sum, p) => sum + p.bytes, 0)
						yield* dropOldest(parts, today, "size", dryRun, (freed) => total - freed <= maxBytes, Infinity, dropped)
					}
					return dropped
				})

			/** Below the free-disk threshold, drops the oldest partitions of every org database, ignoring org settings. */
			const diskPass = (today: string, dryRun: boolean) =>
				Effect.gen(function* () {
					const out: Array<DroppedPartition> = []
					if (minFreePercent === null) return out
					const disk = (yield* admin.query(
						"SELECT sum(free_space) AS free, sum(total_space) AS total FROM system.disks WHERE name = 'default'",
					))[0]
					const free = Number(disk?.free)
					const total = Number(disk?.total)
					if (!(total > 0) || !(free >= 0) || (free / total) * 100 >= minFreePercent) return out
					yield* Effect.logWarning("Retention: free disk below threshold").pipe(
						Effect.annotateLogs({ freePercent: (free / total) * 100, minFreePercent }),
					)
					const target = ((minFreePercent + DISK_MARGIN_PERCENT) / 100) * total
					const parts = parseParts(
						yield* admin.query(
							"SELECT database, table, partition_id AS partition, sum(bytes_on_disk) AS bytes FROM system.parts WHERE startsWith(database, 'org_') AND active GROUP BY database, table, partition_id",
						),
					)
					yield* dropOldest(parts, today, "disk", dryRun, (freed) => free + freed >= target, MAX_DISK_DROPS, out)
					return out
				}).pipe(
					Effect.catch((e: { readonly message: string }) =>
						Effect.logWarning("Retention disk guard failed").pipe(
							Effect.annotateLogs({ error: e.message }),
							Effect.as([] as Array<DroppedPartition>),
						),
					),
				)

			const sweep = Effect.fn("RetentionService.sweep")(function* (options?: { readonly dryRun?: boolean }) {
				const dryRun = options?.dryRun === true
				const nowMs = yield* Clock.currentTimeMillis
				const rows = yield* dbExecute((db) => db.run(PG.from(OrgRetentionSettings).select()))
				const limits = rows.map((row) => ({
					row,
					days:
						row.maxAgeDays === null || instanceMax === null
							? row.maxAgeDays
							: Math.min(row.maxAgeDays, instanceMax),
					// An org with no cap of its own gets the instance ceiling.
					bytes:
						row.maxBytes === null
							? instanceMaxBytes
							: instanceMaxBytes === null
								? Number(row.maxBytes)
								: Math.min(Number(row.maxBytes), instanceMaxBytes),
				}))
				if (minFreePercent === null && limits.every((l) => l.days === null && l.bytes === null)) return []
				const today = yield* serverToday
				// Disk first: it is the emergency, and the org passes then read what is left.
				const diskDrops = yield* diskPass(today, dryRun)
				const reports: Array<OrgSweepReport> = []
				const handled = new Set<string>()
				for (const { row, days, bytes } of limits) {
					const name = orgDatabaseName(row.orgId)
					const disk = diskDrops.filter((d) => d.database === name)
					if (days === null && bytes === null) continue
					handled.add(name)
					// One org failing (database gone, ClickHouse down) must not stop the others.
					const result = yield* sweepOrg(row.orgId, days, bytes, today, dryRun).pipe(
						Effect.map((dropped) => ({ dropped: [...disk, ...dropped], error: null as string | null })),
						Effect.catch((e: { readonly message: string }) =>
							Effect.logWarning("Retention sweep failed for org").pipe(
								Effect.annotateLogs({ orgId: row.orgId, error: e.message }),
								Effect.as({ dropped: disk as ReadonlyArray<DroppedPartition>, error: e.message as string | null }),
							),
						),
					)
					reports.push({ orgId: row.orgId, ...result })
					if (!dryRun && result.error === null)
						yield* dbExecute((db) =>
							db.run(
								PG.update(OrgRetentionSettings)
									.set({ lastSweepAt: nowMs, lastSweepDropped: result.dropped.length })
									.where(($) => [$.orgId.eq(row.orgId)]),
							),
						)
				}
				// Disk drops in databases of orgs with no limit of their own.
				for (const name of new Set(diskDrops.map((d) => d.database)))
					if (!handled.has(name))
						reports.push({ orgId: orgIdOfDatabase(name), dropped: diskDrops.filter((d) => d.database === name), error: null })
				return reports
			})

			return { get, set, storage, sweep } satisfies RetentionServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(ClickHouseAdmin.layer))
}
