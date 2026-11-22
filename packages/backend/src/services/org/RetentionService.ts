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
const DAY_MS = 86_400_000
/** Daily partitions (`toDate(...)`) have partition_id like `20261101` (`partition` reads `2026-11-01`, which `DROP PARTITION ID` rejects); anything else is never dropped. */
const DAILY_PARTITION = /^\d{8}$/u
/** The table allowlist: raw tables only, never input. */
const SWEEP_TABLES = Object.keys(RETENTION_TABLE_TTL_DAYS) as ReadonlyArray<keyof typeof RETENTION_TABLE_TTL_DAYS>

const persistence = (error: unknown) =>
	new OrgClickHouseSettingsPersistenceError({
		message: error instanceof Error ? error.message : "Retention persistence failed",
	})

export interface DroppedPartition {
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
	/** Drops expired daily partitions for every org with a max age. `dryRun` only reports them. */
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
				const now = yield* Clock.currentTimeMillis
				yield* dbExecute((db) =>
					db.run(
						PG.insertInto(OrgRetentionSettings)
							.values({
								orgId,
								maxAgeDays,
								maxBytes: null,
								lastSweepAt: null,
								lastSweepDropped: null,
								updatedBy: userId,
								updatedAt: now,
							})
							.onConflictDoUpdate({
								target: ["orgId"],
								set: { maxAgeDays, updatedBy: userId, updatedAt: now },
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

			const sweepOrg = (orgId: OrgId, maxAgeDays: number, nowMs: number, dryRun: boolean) =>
				Effect.gen(function* () {
					const name = yield* dbNameFor(orgId)
					const dropped: Array<DroppedPartition> = []
					for (const table of SWEEP_TABLES) {
						// A larger N than the shipped TTL has no effect: the TTL already removes that data.
						const days = Math.min(maxAgeDays, RETENTION_TABLE_TTL_DAYS[table])
						const cutoff = new Date(nowMs - days * DAY_MS).toISOString().slice(0, 10).replaceAll("-", "")
						const parts = yield* admin.query(
							`SELECT partition_id AS partition, sum(bytes_on_disk) AS bytes FROM system.parts WHERE database = '${name}' AND table = '${table}' AND active GROUP BY partition_id`,
						)
						for (const part of parts) {
							const partition = String(part.partition)
							if (!DAILY_PARTITION.test(partition) || partition >= cutoff) continue
							const bytes = Number(part.bytes)
							yield* Effect.logInfo("Retention: dropping partition").pipe(
								Effect.annotateLogs({ orgId, table, partition, bytes, dryRun }),
							)
							if (!dryRun)
								yield* admin.exec(`ALTER TABLE \`${name}\`.\`${table}\` DROP PARTITION ID '${partition}'`)
							dropped.push({ table, partition, bytes })
						}
					}
					return dropped
				})

			const sweep = Effect.fn("RetentionService.sweep")(function* (options?: { readonly dryRun?: boolean }) {
				const dryRun = options?.dryRun === true
				const nowMs = yield* Clock.currentTimeMillis
				const rows = yield* dbExecute((db) => db.run(PG.from(OrgRetentionSettings).select()))
				const reports: Array<OrgSweepReport> = []
				for (const row of rows) {
					if (row.maxAgeDays === null) continue
					const days = instanceMax === null ? row.maxAgeDays : Math.min(row.maxAgeDays, instanceMax)
					// One org failing (database gone, ClickHouse down) must not stop the others.
					const result = yield* sweepOrg(row.orgId, days, nowMs, dryRun).pipe(
						Effect.map((dropped) => ({ dropped, error: null as string | null })),
						Effect.catch((e: { readonly message: string }) =>
							Effect.logWarning("Retention sweep failed for org").pipe(
								Effect.annotateLogs({ orgId: row.orgId, error: e.message }),
								Effect.as({ dropped: [] as ReadonlyArray<DroppedPartition>, error: e.message as string | null }),
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
				return reports
			})

			return { get, set, storage, sweep } satisfies RetentionServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(ClickHouseAdmin.layer))
}
