import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant, MapleInternalApi } from "@maple/domain/http"
import { Effect } from "effect"
import { recordHttpAudit } from "@maple/backend/services/audit/AuditLogService"
import { RetentionService } from "@maple/backend/services/org/RetentionService"
import { OrgClickHouseSettingsService } from "@maple/backend/services/org/OrgClickHouseSettingsService"

export const HttpOrgClickHouseSettingsLive = HttpApiBuilder.group(
	MapleInternalApi,
	"orgClickHouseSettings",
	(handlers) =>
		Effect.gen(function* () {
			const service = yield* OrgClickHouseSettingsService
			const retention = yield* RetentionService

			return handlers
				.handle("get", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						return yield* service.get(tenant.orgId, tenant.roles)
					}),
				)
				.handle("upsert", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const updated = yield* service.upsert(
							tenant.orgId,
							tenant.userId,
							tenant.roles,
							payload,
						)
						// URL/user/database identify the connection; the password in the
						// payload is write-only and never reaches an audit row.
						yield* recordHttpAudit("warehouse_settings.updated", {
							metadata: { url: payload.url, user: payload.user, database: payload.database },
						})
						return updated
					}),
				)
				.handle("schemaDiff", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						return yield* service.schemaDiff(tenant.orgId, tenant.roles)
					}),
				)
				.handle("applySchema", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const applied = yield* service.applySchema(tenant.orgId, tenant.userId, tenant.roles)
						yield* recordHttpAudit("warehouse_settings.schema_applied")
						return applied
					}),
				)
				.handle("applySchemaStatus", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						return yield* service.applySchemaStatus(tenant.orgId, tenant.roles)
					}),
				)
				.handle("collectorConfig", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						return yield* service.collectorConfig(tenant.orgId, tenant.roles)
					}),
				)
				.handle("getRetention", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						return yield* retention.get(tenant.orgId, tenant.roles)
					}),
				)
				.handle("setRetention", ({ payload }) =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						return yield* retention.set(tenant.orgId, tenant.userId, tenant.roles, payload)
					}),
				)
				.handle("getStorage", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						return yield* retention.storage(tenant.orgId, tenant.roles)
					}),
				)
				.handle("delete", () =>
					Effect.gen(function* () {
						const tenant = yield* CurrentTenant.Context
						const deleted = yield* service.delete(tenant.orgId, tenant.roles)
						yield* recordHttpAudit("warehouse_settings.deleted")
						return deleted
					}),
				)
		}),
)
