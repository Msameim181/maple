import {
	OrgClickHouseApplySchemaStarted,
	OrgClickHouseApplySchemaStatus,
	OrgClickHouseSettingsResponse,
	OrgRetentionResponse,
} from "@maple/domain/http"
import { Result, Schema, Array as Arr } from "effect"
import { describe, expect, test } from "vitest"
import { PageOutMessage } from "../../contract"
import { Message, type Model } from "./model"
import { init, isRetentionHidden, isRunActive, update } from "./update"

const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const settings = Schema.decodeSync(OrgClickHouseSettingsResponse)({
	configured: true,
	chUrl: "https://ch.acme.test:8443",
	chUser: "maple_writer",
	chDatabase: "maple",
	syncStatus: "connected",
	lastSyncAt: "2026-10-17T11:56:00.000Z",
	lastSyncError: null,
	schemaVersion: "2026-09-30.1",
})
const status = (value: "running" | "succeeded") =>
	Schema.decodeSync(OrgClickHouseApplySchemaStatus)({
		status: value,
		phase: null,
		currentMigration: null,
		stepsTotal: null,
		stepsDone: null,
		appliedVersions: [],
		skipped: [],
		errorMessage: null,
		startedAt: null,
		finishedAt: null,
	})

const loaded = () =>
	update(init().model, Message.CompletedFetchSettings({ result: Result.succeed(settings) }))

describe("data platform tab", () => {
	test("a configured cluster also reads the apply status", () => {
		expect(names(init().commands)).toEqual(
			expect.arrayContaining([
				"FetchOrgClickHouseSettings",
				"FetchOrgClickHouseSchemaDiff",
				"FetchDataPlatformUsage",
			]),
		)
		expect(names(init().commands)).not.toContain("FetchOrgClickHouseApplyStatus")
		expect(names(loaded().commands)).toEqual(["FetchOrgClickHouseApplyStatus"])
	})

	test("Save sends the trimmed connection of an edit", () => {
		const edited = update(
			loaded().model,
			Message.ChangedConnection({ field: "database", value: " maple_prod " }),
		).model
		expect(update(edited, Message.ClickedSave()).commands?.[0]).toMatchObject({
			name: "SaveOrgClickHouseConnection",
			args: {
				request: { url: "https://ch.acme.test:8443", user: "maple_writer", database: "maple_prod" },
			},
		})
	})

	const answer = (model: Model, sequence: number, value: "running" | "succeeded") =>
		update(model, Message.CompletedFetchApplyStatus({ sequence, result: Result.succeed(status(value)) }))

	test("a run that finishes refreshes the connection and says so", () => {
		const running = answer(loaded().model, 1, "running").model
		const polled = update(running, Message.TickedApplyPoll()).model
		const done = answer(polled, 2, "succeeded")
		expect(names(done.commands)).toContain("FetchOrgClickHouseSettings")
		expect(names(done.commands)).toContain("FetchOrgClickHouseSchemaDiff")
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "Schema applied", description: "" }),
		)
	})

	test("a poll tick waits on a read still out, and a late running answer cannot undo a finished run", () => {
		const running = answer(loaded().model, 1, "running").model
		const polled = update(running, Message.TickedApplyPoll())
		expect(names(polled.commands)).toEqual(["FetchOrgClickHouseApplyStatus"])
		expect(names(update(polled.model, Message.TickedApplyPoll()).commands)).toEqual([])
		// A second read (the run was started again) answers first with the finished run.
		const started = update(
			polled.model,
			Message.CompletedApply({
				result: Result.succeed(new OrgClickHouseApplySchemaStarted({ status: "already_running" })),
			}),
		).model
		const done = answer(started, 3, "succeeded")
		expect(done.outMessage).toEqual(
			PageOutMessage.RequestedToast({ type: "success", title: "Schema applied", description: "" }),
		)
		const late = answer(done.model, 2, "running")
		expect(late.outMessage).toBeUndefined()
		expect(isRunActive(late.model)).toBe(false)
	})

	const retention = (maxAgeDays: number | null) =>
		Schema.decodeSync(OrgRetentionResponse)({
			maxAgeDays,
			maxBytes: null,
			instanceMaxDays: null,
			instanceMaxBytes: null,
			lastSweepAt: null,
			lastSweepDropped: null,
		})

	test("retention loads on open, Save sends the typed days, and blank clears the limit", () => {
		expect(names(init().commands)).toEqual(expect.arrayContaining(["FetchOrgRetention", "FetchOrgStorage"]))
		const read = update(init().model, Message.CompletedFetchRetention({ result: Result.succeed(retention(30)) })).model
		const typed = update(read, Message.ChangedRetentionDays({ value: "14" })).model
		expect(update(typed, Message.ClickedSaveRetention()).commands?.[0]).toMatchObject({
			name: "SaveOrgRetention",
			args: { maxAgeDays: 14, maxBytes: null },
		})
		const blank = update(read, Message.ChangedRetentionDays({ value: " " })).model
		expect(update(blank, Message.ClickedSaveRetention()).commands?.[0]).toMatchObject({
			args: { maxAgeDays: null },
		})
	})

	test("Save sends the typed max storage in bytes, blank clears it, and a bad value does not save", () => {
		const read = update(init().model, Message.CompletedFetchRetention({ result: Result.succeed(retention(null)) })).model
		const typed = update(read, Message.ChangedMaxGb({ value: "5" })).model
		expect(update(typed, Message.ClickedSaveRetention()).commands?.[0]).toMatchObject({
			args: { maxAgeDays: null, maxBytes: 5_000_000_000 },
		})
		const half = update(read, Message.ChangedMaxGb({ value: "0.5" })).model
		expect(update(half, Message.ClickedSaveRetention()).commands?.[0]).toMatchObject({
			args: { maxBytes: 500_000_000 },
		})
		const bad = update(read, Message.ChangedMaxGb({ value: "-1" })).model
		expect(update(bad, Message.ClickedSaveRetention()).commands).toBeUndefined()
	})

	test("an invalid days value does not save, and a saved value replaces the draft", () => {
		const bad = update(init().model, Message.ChangedRetentionDays({ value: "0" })).model
		expect(update(bad, Message.ClickedSaveRetention()).commands).toBeUndefined()
		const saving = update(
			update(init().model, Message.ChangedRetentionDays({ value: "7" })).model,
			Message.ClickedSaveRetention(),
		).model
		const done = update(saving, Message.CompletedSaveRetention({ result: Result.succeed(retention(7)) }))
		expect(done.model.retentionDraft).toBeNull()
		expect(done.model.isSavingRetention).toBe(false)
	})

	test("the panel is hidden once the API says the caller may not manage the warehouse", () => {
		expect(isRetentionHidden(init().model)).toBe(false)
		const forbidden = update(
			init().model,
			Message.CompletedFetchRetention({
				result: Result.fail({
					_tag: "@maple/http/errors/OrgClickHouseSettingsForbiddenError",
					type: "api_error",
					code: "clickhouse_settings_forbidden",
					title: "Permission required",
					message: "Only org admins can manage the data warehouse",
					retryable: false,
					recovery: "request_access",
				} as never),
			}),
		).model
		expect(isRetentionHidden(forbidden)).toBe(true)
	})
})
