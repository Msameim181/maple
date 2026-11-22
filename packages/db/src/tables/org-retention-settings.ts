import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId } from "@maple/primitives"

/** Per-org data retention for the self-hosted warehouse. Separate from `org_clickhouse_settings`. */
export const OrgRetentionSettings = PG.table("org_retention_settings", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		// Keep this many days of raw telemetry; null keeps the shipped TTLs.
		maxAgeDays: PG.column(PG.nullable(PG.int4), { name: "max_age_days" }),
		// Approximate size cap of the org database; the sweep drops oldest daily partitions above it.
		maxBytes: PG.column(PG.nullable(PG.int8), { name: "max_bytes" }),
		lastSweepAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_sweep_at" }),
		lastSweepDropped: PG.column(PG.nullable(PG.int4), { name: "last_sweep_dropped" }),
		updatedBy: PG.column(PG.text, { name: "updated_by" }),
		updatedAt: PG.column(PG.timestamptzMillis, { name: "updated_at" }),
	},
	primaryKey: { columns: ["orgId"], name: "org_retention_settings_org_id_pk" },
	tenantColumn: "orgId",
})

export type OrgRetentionSettingsRow = PG.SelectRowOf<typeof OrgRetentionSettings>
