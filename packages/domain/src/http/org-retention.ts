import { Schema } from "effect"
import { IsoDateTimeString } from "@maple/primitives"

/** Raw tables the retention sweep may touch, with the TTL (days) each ships with. */
export const RETENTION_TABLE_TTL_DAYS = {
	traces: 30,
	logs: 30,
	metrics_sum: 90,
	metrics_gauge: 90,
	metrics_histogram: 90,
	metrics_exponential_histogram: 90,
	error_events: 90,
	profiles: 14,
	session_replays: 30,
	session_replay_events: 30,
	session_events: 30,
} as const

export const RETENTION_MAX_DAYS = 3650

export class OrgRetentionResponse extends Schema.Class<OrgRetentionResponse>("OrgRetentionResponse")({
	/** Days of raw telemetry kept, or null for the shipped TTLs. */
	maxAgeDays: Schema.NullOr(Schema.Number),
	/** Stored but not enforced yet. */
	maxBytes: Schema.NullOr(Schema.Number),
	/** Instance ceiling from `MAPLE_RETENTION_MAX_DAYS`, or null. */
	instanceMaxDays: Schema.NullOr(Schema.Number),
	lastSweepAt: Schema.NullOr(IsoDateTimeString),
	lastSweepDropped: Schema.NullOr(Schema.Number),
}) {}

export class OrgRetentionUpsertRequest extends Schema.Class<OrgRetentionUpsertRequest>(
	"OrgRetentionUpsertRequest",
)({
	maxAgeDays: Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: RETENTION_MAX_DAYS }))),
}) {}

export class OrgStorageTable extends Schema.Class<OrgStorageTable>("OrgStorageTable")({
	table: Schema.String,
	rows: Schema.Number,
	bytes: Schema.Number,
	partitions: Schema.Number,
	/** Oldest daily partition (YYYYMMDD), if the table is daily-partitioned. */
	oldestPartition: Schema.NullOr(Schema.String),
}) {}

export class OrgStorageResponse extends Schema.Class<OrgStorageResponse>("OrgStorageResponse")({
	database: Schema.String,
	totalBytes: Schema.Number,
	tables: Schema.Array(OrgStorageTable),
}) {}
