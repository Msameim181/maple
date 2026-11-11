import { randomBytes } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import { DirectoryOrgs } from "@maple/db/tables"
import {
	DIRECTORY_ORG_ID_PATTERN,
	DirectoryPersistenceError,
	DirectoryValidationError,
	type OrgId,
	OrgClickHouseSettingsUpsertRequest,
	RoleName,
	type UserId,
} from "@maple/domain/http"
import { Context, Effect, Layer, Option, Redacted, Schema, String as Str } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { OrgClickHouseSettingsService } from "@maple/backend/services/org/OrgClickHouseSettingsService"
import { OrganizationService } from "@maple/backend/services/org/OrganizationService"

const persistence = (error: { readonly message: string }) =>
	new DirectoryPersistenceError({ message: error.message })

const notConfigured = () =>
	new DirectoryPersistenceError({
		message:
			"Self-hosted ClickHouse is not configured (MAPLE_SELFHOST_CLICKHOUSE_URL, MAPLE_SELFHOST_CLICKHOUSE_ADMIN_USER)",
	})

export interface ClickHouseAdminApi {
	/** Runs one statement as the ClickHouse admin; no database is selected. */
	readonly exec: (sql: string) => Effect.Effect<void, DirectoryPersistenceError>
}

/** DDL against the self-hosted ClickHouse with the admin credentials, over its HTTP interface. */
export class ClickHouseAdmin extends Context.Service<ClickHouseAdmin, ClickHouseAdminApi>()(
	"@maple/backend/services/ClickHouseAdmin",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const httpClient = yield* HttpClient.HttpClient

			const exec = Effect.fn("ClickHouseAdmin.exec")(function* (sql: string) {
				if (
					Option.isNone(env.MAPLE_SELFHOST_CLICKHOUSE_URL) ||
					Option.isNone(env.MAPLE_SELFHOST_CLICKHOUSE_ADMIN_USER)
				) {
					return yield* notConfigured()
				}
				const password = Option.match(env.MAPLE_SELFHOST_CLICKHOUSE_ADMIN_PASSWORD, {
					onNone: () => "",
					onSome: Redacted.value,
				})
				const unkeyed = HttpClientRequest.post(env.MAPLE_SELFHOST_CLICKHOUSE_URL.value, {
					headers: {
						"Content-Type": "text/plain",
						"X-ClickHouse-User": env.MAPLE_SELFHOST_CLICKHOUSE_ADMIN_USER.value,
					},
				}).pipe(HttpClientRequest.bodyText(sql))
				const request =
					password.length > 0
						? unkeyed.pipe(HttpClientRequest.setHeader("X-ClickHouse-Key", password))
						: unkeyed
				const { status, text } = yield* Effect.gen(function* () {
					const response = yield* httpClient.execute(request)
					return { status: response.status, text: yield* response.text }
				}).pipe(
					Effect.timeout("30 seconds"),
					Effect.mapError(
						() =>
							new DirectoryPersistenceError({
								message: "Could not reach the self-hosted ClickHouse",
							}),
					),
				)
				if (status !== 200) {
					return yield* new DirectoryPersistenceError({
						message: `ClickHouse refused the statement (${status}): ${Str.slice(0, 300)(text)}`,
					})
				}
			})

			return { exec } satisfies ClickHouseAdminApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}

/** The org's ClickHouse database and user. Slugs never contain `_`, so the mapping is one to one. */
export const orgDatabaseName = (orgId: OrgId): string => `org_${Str.replaceAll("-", "_")(orgId)}`

const ROOT_ROLES = [Schema.decodeSync(RoleName)("root")]

export interface OrgProvisionerApi {
	/** Database, user and grant, then the org's BYO ClickHouse settings and schema. Idempotent. */
	readonly provision: (
		orgId: OrgId,
		actor: UserId,
	) => Effect.Effect<void, DirectoryPersistenceError | DirectoryValidationError>
	/**
	 * Every Postgres row of the org, its ClickHouse database and user, then its directory row, which
	 * frees the slug. Idempotent, so a failed purge is retried by running it again.
	 */
	readonly purge: (
		orgId: OrgId,
	) => Effect.Effect<void, DirectoryPersistenceError | DirectoryValidationError>
}

export class OrgProvisioner extends Context.Service<OrgProvisioner, OrgProvisionerApi>()(
	"@maple/backend/services/OrgProvisioner",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "OrgProvisioner", persistence)
			const admin = yield* ClickHouseAdmin
			const byo = yield* OrgClickHouseSettingsService
			const organizations = yield* OrganizationService

			// The name is spliced into DDL, so the slug shape is re-checked here, not trusted.
			const nameFor = (orgId: OrgId) =>
				DIRECTORY_ORG_ID_PATTERN.test(orgId)
					? Effect.succeed(orgDatabaseName(orgId))
					: Effect.fail(
							new DirectoryValidationError({ message: `Invalid organization id: ${orgId}` }),
						)

			const provision = Effect.fn("OrgProvisioner.provision")(function* (orgId: OrgId, actor: UserId) {
				yield* Effect.annotateCurrentSpan("orgId", orgId)
				const name = yield* nameFor(orgId)
				if (Option.isNone(env.MAPLE_SELFHOST_CLICKHOUSE_URL)) return yield* notConfigured()
				const password = randomBytes(16).toString("hex")
				yield* admin.exec(`CREATE DATABASE IF NOT EXISTS \`${name}\``)
				yield* admin.exec(`CREATE USER IF NOT EXISTS \`${name}\` IDENTIFIED BY '${password}'`)
				// A user left behind by an earlier attempt keeps its old password; reset it to the one stored below.
				yield* admin.exec(`ALTER USER \`${name}\` IDENTIFIED BY '${password}'`)
				yield* admin.exec(`GRANT ALL ON \`${name}\`.* TO \`${name}\``)
				yield* byo
					.upsert(
						orgId,
						actor,
						ROOT_ROLES,
						new OrgClickHouseSettingsUpsertRequest({
							url: env.MAPLE_SELFHOST_CLICKHOUSE_URL.value,
							user: name,
							password,
							database: name,
						}),
					)
					.pipe(Effect.mapError(persistence))
				yield* byo.applySchema(orgId, actor, ROOT_ROLES).pipe(Effect.mapError(persistence))
			})

			const purge = Effect.fn("OrgProvisioner.purge")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan("orgId", orgId)
				const name = yield* nameFor(orgId)
				// Through the service rather than the purge below: it also drops the cached runtime config.
				yield* byo.delete(orgId, ROOT_ROLES).pipe(Effect.mapError(persistence))
				// The org-scoped Postgres purge (directory members and invitations included).
				yield* organizations.delete(orgId, ROOT_ROLES).pipe(Effect.mapError(persistence))
				yield* admin.exec(`DROP DATABASE IF EXISTS \`${name}\``)
				yield* admin.exec(`DROP USER IF EXISTS \`${name}\``)
				yield* dbExecute((db) => db.run(PG.deleteFrom(DirectoryOrgs).where(($) => [$.id.eq(orgId)])))
			})

			return { provision, purge } satisfies OrgProvisionerApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				ClickHouseAdmin.layer,
				OrgClickHouseSettingsService.layer,
				OrganizationService.layer,
			),
		),
	)
}
