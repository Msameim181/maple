import { OrgId } from "@maple/domain"
import { CreateOrgRequest, RenameOrgRequest } from "@maple/domain/http"
import { Array as Arr, Effect, Option, Result, Schema, String as Str } from "effect"
import { Command } from "foldkit"
import { AsyncData } from "foldkit"
import { settleTo } from "@maple/views/data/load-failure"
import { readClock } from "@maple/views/data/timing"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"
import { apiErrorMessage, DirectoryMe } from "../../data/directory-me"
import { MapleApiClient } from "../../platform/api-clients"
import { type PageContext, PageOutMessage, type PageReturn } from "../contract"
import { Message, type Model } from "./model"

type Return = PageReturn<Model, Message>

const ReadAdminClock = readClock("ReadAdminClock", Message.ReadClock)

const directory = Effect.gen(function* () {
	return (yield* MapleApiClient).directory
})

const LoadViewer = Command.define("LoadAdminViewer", {
	messages: [Message.CompletedLoadViewer],
	execute: Effect.gen(function* () {
		const viewer = yield* (yield* DirectoryMe).get
		return Message.CompletedLoadViewer({ isRoot: Option.exists(viewer, (found) => found.isRoot) })
	}),
})

export const LoadOrgs = Command.define("LoadDirectoryOrgs", {
	messages: [Message.CompletedLoadOrgs],
	execute: Effect.flatMap(directory, (api) => api.listOrgs()).pipe(
		Effect.map((response) =>
			Arr.map(response.orgs, (org) => ({
				id: org.id,
				name: org.name,
				status: org.status,
				memberCount: org.memberCount,
				createdAt: org.createdAt,
			})),
		),
		settleTo((result) => Message.CompletedLoadOrgs({ result })),
	),
})

export const LoadUsers = Command.define("LoadDirectoryUsers", {
	messages: [Message.CompletedLoadUsers],
	execute: Effect.flatMap(directory, (api) => api.listUsers()).pipe(
		Effect.map((response) =>
			Arr.map(response.users, (row) => ({
				id: row.user.id,
				email: row.user.email,
				name: row.user.name,
				lastSeenAt: row.user.lastSeenAt,
				orgs: Arr.map(row.orgs, (org) => ({ id: org.id, role: org.role })),
			})),
		),
		settleTo((result) => Message.CompletedLoadUsers({ result })),
	),
})

/** A write settled to `Result<void, message>`; the API's own message when it has one. */
const settleWrite =
	<B>(fallback: string, toMessage: (result: Result.Result<void, string>) => B) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(
			Effect.asVoid,
			Effect.mapError((error) => apiErrorMessage(error, fallback)),
			Effect.result,
			Effect.map(toMessage),
		)

const decodeOrgId = (raw: string) =>
	Schema.decodeEffect(OrgId)(raw).pipe(
		Effect.mapError(() => "Organization ids are 3 to 40 lowercase letters, digits and dashes"),
	)

const CreateOrg = Command.define("CreateDirectoryOrg", {
	args: { id: Schema.String, name: Schema.String, adminEmail: Schema.String },
	messages: [Message.CompletedCreate],
	execute: ({ id, name, adminEmail }) =>
		Effect.all([directory, decodeOrgId(id)]).pipe(
			Effect.flatMap(([api, orgId]) =>
				api.createOrg({ payload: new CreateOrgRequest({ id: orgId, name, adminEmail }) }),
			),
			settleWrite("Couldn't create the organization", (result) =>
				Message.CompletedCreate({ id, result }),
			),
		),
})

const RenameOrg = Command.define("RenameDirectoryOrg", {
	args: { id: Schema.String, name: Schema.String },
	messages: [Message.CompletedRename],
	execute: ({ id, name }) =>
		Effect.all([directory, decodeOrgId(id)]).pipe(
			Effect.flatMap(([api, orgId]) =>
				api.renameOrg({ params: { orgId }, payload: new RenameOrgRequest({ name }) }),
			),
			settleWrite("Couldn't rename the organization", (result) => Message.CompletedRename({ result })),
		),
})

const DeleteOrg = Command.define("DeleteDirectoryOrg", {
	args: { id: Schema.String },
	messages: [Message.CompletedDelete],
	execute: ({ id }) =>
		Effect.all([directory, decodeOrgId(id)]).pipe(
			Effect.flatMap(([api, orgId]) => api.deleteOrg({ params: { orgId } })),
			settleWrite("Couldn't delete the organization", (result) =>
				Message.CompletedDelete({ id, result }),
			),
		),
})

export const init = (_route: unknown, _context: PageContext): Return => ({
	model: {
		isRoot: null,
		nowMs: 0,
		orgs: AsyncData.Loading(),
		users: AsyncData.Loading(),
		createDialog: Dialog.init("admin-create-org", "dialog"),
		createId: Field.init(),
		createName: Field.init(),
		createEmail: Field.init(),
		isCreating: false,
		renaming: null,
		renameDialog: Dialog.init("admin-rename-org", "dialog"),
		renameName: Field.init(),
		isRenaming: false,
		deleting: null,
		deleteDialog: Dialog.init("admin-delete-org", "alert-dialog"),
		deleteConfirm: Field.init(),
		isDeleting: false,
	},
	commands: [ReadAdminClock(), LoadViewer()],
})

const toast = (type: "success" | "error", title: string) =>
	PageOutMessage.RequestedToast({ type, title, description: "" })

type DialogKey = "createDialog" | "renameDialog" | "deleteDialog"
type FieldKey = "createId" | "createName" | "createEmail" | "renameName" | "deleteConfirm"

const liftDialog = (
	model: Model,
	key: DialogKey,
	step: ReturnType<typeof Dialog.update>,
	wrap: (message: Dialog.Message) => Message,
): Return => ({
	model: { ...model, [key]: step.model },
	commands: Command.mapMessages(step.commands ?? [], wrap),
})

const toCreateDialog = (message: Dialog.Message) => Message.GotCreateDialogMessage({ message })
const toRenameDialog = (message: Dialog.Message) => Message.GotRenameDialogMessage({ message })
const toDeleteDialog = (message: Dialog.Message) => Message.GotDeleteDialogMessage({ message })

const liftField = (
	model: Model,
	key: FieldKey,
	child: Field.Message,
	wrap: (message: Field.Message) => Message,
): Return => {
	const step = Field.update(model[key], child)
	return {
		model: { ...model, [key]: step.model },
		commands: Command.mapMessages(step.commands ?? [], wrap),
	}
}

/** A write landed: close its dialog, read both tables again, and say so. */
const settled = (
	model: Model,
	key: DialogKey,
	wrap: (message: Dialog.Message) => Message,
	title: string,
): Return => {
	const closed = liftDialog(model, key, Dialog.close(model[key]), wrap)
	return {
		model: closed.model,
		commands: [...(closed.commands ?? []), LoadOrgs(), LoadUsers()],
		outMessage: toast("success", title),
	}
}

export const update = (model: Model, message: Message, _context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedLoadViewer: ({ isRoot }) => ({
			model: { ...model, isRoot },
			commands: isRoot ? [LoadOrgs(), LoadUsers()] : [],
		}),
		CompletedLoadOrgs: ({ result }) => ({
			model: { ...model, orgs: AsyncData.settle(model.orgs, result) },
		}),
		CompletedLoadUsers: ({ result }) => ({
			model: { ...model, users: AsyncData.settle(model.users, result) },
		}),
		ClickedCreate: () =>
			liftDialog(model, "createDialog", Dialog.open(model.createDialog), toCreateDialog),
		GotCreateDialogMessage: ({ message: child }) =>
			liftDialog(model, "createDialog", Dialog.update(model.createDialog, child), toCreateDialog),
		GotCreateIdMessage: ({ message: child }) =>
			liftField(model, "createId", child, (inner) => Message.GotCreateIdMessage({ message: inner })),
		GotCreateNameMessage: ({ message: child }) =>
			liftField(model, "createName", child, (inner) =>
				Message.GotCreateNameMessage({ message: inner }),
			),
		GotCreateEmailMessage: ({ message: child }) =>
			liftField(model, "createEmail", child, (inner) =>
				Message.GotCreateEmailMessage({ message: inner }),
			),
		SubmittedCreate: () => {
			const id = Str.trim(model.createId.value)
			const name = Str.trim(model.createName.value)
			const adminEmail = Str.trim(model.createEmail.value)
			if (model.isCreating || id === "" || name === "" || adminEmail === "") return { model }
			return { model: { ...model, isCreating: true }, commands: [CreateOrg({ id, name, adminEmail })] }
		},
		CompletedCreate: ({ id, result }) =>
			Result.match(result, {
				onSuccess: () =>
					settled(
						{
							...model,
							isCreating: false,
							createId: Field.init(),
							createName: Field.init(),
							createEmail: Field.init(),
						},
						"createDialog",
						toCreateDialog,
						`Created ${id}`,
					),
				onFailure: (error) => ({
					model: { ...model, isCreating: false },
					outMessage: toast("error", error),
				}),
			}),
		ClickedRename: ({ id, name }) =>
			liftDialog(
				{ ...model, renaming: id, renameName: Field.init(name) },
				"renameDialog",
				Dialog.open(model.renameDialog),
				toRenameDialog,
			),
		GotRenameDialogMessage: ({ message: child }) =>
			liftDialog(model, "renameDialog", Dialog.update(model.renameDialog, child), toRenameDialog),
		GotRenameNameMessage: ({ message: child }) =>
			liftField(model, "renameName", child, (inner) =>
				Message.GotRenameNameMessage({ message: inner }),
			),
		SubmittedRename: () => {
			const name = Str.trim(model.renameName.value)
			if (model.isRenaming || model.renaming === null || name === "") return { model }
			return {
				model: { ...model, isRenaming: true },
				commands: [RenameOrg({ id: model.renaming, name })],
			}
		},
		CompletedRename: ({ result }) =>
			Result.match(result, {
				onSuccess: () =>
					settled(
						{ ...model, isRenaming: false },
						"renameDialog",
						toRenameDialog,
						"Organization renamed",
					),
				onFailure: (error) => ({
					model: { ...model, isRenaming: false },
					outMessage: toast("error", error),
				}),
			}),
		ClickedDelete: ({ id }) =>
			liftDialog(
				{ ...model, deleting: id, deleteConfirm: Field.init() },
				"deleteDialog",
				Dialog.open(model.deleteDialog),
				toDeleteDialog,
			),
		GotDeleteDialogMessage: ({ message: child }) =>
			liftDialog(model, "deleteDialog", Dialog.update(model.deleteDialog, child), toDeleteDialog),
		GotDeleteConfirmMessage: ({ message: child }) =>
			liftField(model, "deleteConfirm", child, (inner) =>
				Message.GotDeleteConfirmMessage({ message: inner }),
			),
		SubmittedDelete: () =>
			// The typed id must match: a purge cannot be undone.
			model.isDeleting || model.deleting === null || !isDeleteConfirmed(model)
				? { model }
				: { model: { ...model, isDeleting: true }, commands: [DeleteOrg({ id: model.deleting })] },
		CompletedDelete: ({ id, result }) =>
			Result.match(result, {
				onSuccess: () =>
					settled(
						{ ...model, isDeleting: false, deleting: null },
						"deleteDialog",
						toDeleteDialog,
						`Deleted ${id}`,
					),
				onFailure: (error) => ({
					model: { ...model, isDeleting: false },
					outMessage: toast("error", error),
				}),
			}),
	})

export const isDeleteConfirmed = (model: Model): boolean =>
	model.deleting !== null && Str.trim(model.deleteConfirm.value) === model.deleting
