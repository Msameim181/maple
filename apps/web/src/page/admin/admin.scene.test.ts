import { OrgId } from "@maple/domain"
import { Array as Arr, Result } from "effect"
import { Command, expect, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect as expectVitest, test } from "vitest"
import type { PageContext } from "../contract"
import { Message, type Model } from "./model"
import { init, LoadOrgs, LoadUsers, update } from "./update"
import { view } from "./view"
import * as Field from "@maple/views/ui/field"

const changed = (value: string) => Field.Message.ChangedValue({ value })

const context: PageContext = { orgId: OrgId.make("acme"), pinnedNamespace: null, timeZone: "UTC" }
const adminView = withViewInputs(view, { context })()
const updateAdmin = (model: Model, message: Message) => update(model, message, context)

const acme = { id: "acme", name: "Acme", status: "active", memberCount: 3, createdAt: 0 }

describe("/admin", () => {
	test("a non-root viewer is told the page is root's, and nothing is read", () => {
		const step = updateAdmin(
			init(undefined, context).model,
			Message.CompletedLoadViewer({ isRoot: false }),
		)
		expectVitest(step.commands ?? []).toEqual([])
		scene(
			{ update: updateAdmin, view: adminView },
			given(step.model),
			expect(text("Only the root administrator can open this page")).toExist(),
			expect(role("table", { name: "Organizations" })).toBeAbsent(),
		)
	})

	test("root sees the organizations, and deleting one waits for its id typed back", () => {
		const rootStep = updateAdmin(
			init(undefined, context).model,
			Message.CompletedLoadViewer({ isRoot: true }),
		)
		const loaded = updateAdmin(
			rootStep.model,
			Message.CompletedLoadOrgs({ result: Result.succeed([acme]) }),
		)
		const withUsers = updateAdmin(
			loaded.model,
			Message.CompletedLoadUsers({ result: Result.succeed([]) }),
		)
		expectVitest(Arr.map(rootStep.commands ?? [], (command) => command.name)).toEqual([
			LoadOrgs.name,
			LoadUsers.name,
		])
		const asking = updateAdmin(withUsers.model, Message.ClickedDelete({ id: "acme" })).model
		const mistyped = updateAdmin(
			asking,
			Message.GotDeleteConfirmMessage({ message: changed("acm") }),
		).model
		expectVitest(updateAdmin(mistyped, Message.SubmittedDelete()).commands ?? []).toEqual([])
		const typed = updateAdmin(asking, Message.GotDeleteConfirmMessage({ message: changed("acme") })).model
		expectVitest(
			Arr.map(updateAdmin(typed, Message.SubmittedDelete()).commands ?? [], (command) => command.args),
		).toEqual([{ id: "acme" }])
		scene(
			{ update: updateAdmin, view: adminView },
			given(withUsers.model),
			expect(role("table", { name: "Organizations" })).toExist(),
			expect(role("button", { name: "Delete acme" })).toExist(),
			Command.expectNone(),
		)
	})
})
