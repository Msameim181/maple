import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { LoadFailure } from "@maple/views/data/load-failure"
import * as Dialog from "@maple/views/ui/dialog"
import * as Field from "@maple/views/ui/field"

// `/admin`: the self-hosted directory's IT page, root only. Organizations (create, rename, delete)
// and every user with their org roles.

export const AdminOrg = Schema.Struct({
	id: Schema.String,
	name: Schema.String,
	status: Schema.String,
	memberCount: Schema.Number,
	createdAt: Schema.Number,
})
export type AdminOrg = typeof AdminOrg.Type

export const AdminUser = Schema.Struct({
	id: Schema.String,
	email: Schema.String,
	name: Schema.NullOr(Schema.String),
	lastSeenAt: Schema.NullOr(Schema.Number),
	orgs: Schema.Array(Schema.Struct({ id: Schema.String, role: Schema.String })),
})
export type AdminUser = typeof AdminUser.Type

export const OrgsData = AsyncData.Schema(Schema.Array(AdminOrg), LoadFailure)
export const UsersData = AsyncData.Schema(Schema.Array(AdminUser), LoadFailure)

export const Model = Schema.Struct({
	/** `null` until the directory answers: only root may use the page. */
	isRoot: Schema.NullOr(Schema.Boolean),
	nowMs: Schema.Number,
	orgs: OrgsData.schema,
	users: UsersData.schema,
	createDialog: Dialog.Model,
	createId: Field.Model,
	createName: Field.Model,
	createEmail: Field.Model,
	isCreating: Schema.Boolean,
	renaming: Schema.NullOr(Schema.String),
	renameDialog: Dialog.Model,
	renameName: Field.Model,
	isRenaming: Schema.Boolean,
	deleting: Schema.NullOr(Schema.String),
	deleteDialog: Dialog.Model,
	deleteConfirm: Field.Model,
	isDeleting: Schema.Boolean,
})
export type Model = typeof Model.Type

const done = { result: Schema.Result(Schema.Void, Schema.String) }

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	CompletedLoadViewer: { isRoot: Schema.Boolean },
	CompletedLoadOrgs: { result: Schema.Result(Schema.Array(AdminOrg), LoadFailure) },
	CompletedLoadUsers: { result: Schema.Result(Schema.Array(AdminUser), LoadFailure) },
	ClickedCreate: {},
	GotCreateDialogMessage: { message: Dialog.Message },
	GotCreateIdMessage: { message: Field.Message },
	GotCreateNameMessage: { message: Field.Message },
	GotCreateEmailMessage: { message: Field.Message },
	SubmittedCreate: {},
	CompletedCreate: { id: Schema.String, ...done },
	ClickedRename: { id: Schema.String, name: Schema.String },
	GotRenameDialogMessage: { message: Dialog.Message },
	GotRenameNameMessage: { message: Field.Message },
	SubmittedRename: {},
	CompletedRename: done,
	ClickedDelete: { id: Schema.String },
	GotDeleteDialogMessage: { message: Dialog.Message },
	GotDeleteConfirmMessage: { message: Field.Message },
	SubmittedDelete: {},
	CompletedDelete: { id: Schema.String, ...done },
})
export type Message = typeof Message.Type
