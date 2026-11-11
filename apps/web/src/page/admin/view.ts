import { formatDateInTimezone } from "@maple/ui/lib/timezone-format"
import { Array as Arr, String as Str } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureMessage, type LoadFailure } from "@maple/views/data/load-failure"
import { button } from "@maple/views/ui/button"
import { emptyMessage } from "@maple/views/ui/empty"
import * as Field from "@maple/views/ui/field"
import { field, type FieldIds, fieldLabel, input } from "@maple/views/ui/field"
import { formDialog } from "@maple/views/ui/form-dialog"
import { hstack } from "@maple/views/ui/stack"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "@maple/views/ui/table"
import { orgRoleLabel } from "../settings/kit/org-membership"
import type { PageViewInputs } from "../contract"
import { dashboardPage } from "../kit/dashboard-page"
import { settingsSection, settingsSections } from "../kit/settings-section"
import type { BreadcrumbEntry } from "../../shell"
import { type AdminOrg, type AdminUser, Message, type Model } from "./model"
import { isDeleteConfirmed } from "./update"

type H = HtmlBuilder<Message>

export const breadcrumbs = (): ReadonlyArray<BreadcrumbEntry> => [{ label: "Admin" }]

const idsOf = (name: string): FieldIds => ({
	control: `admin-${name}`,
	label: `admin-${name}-label`,
	error: `admin-${name}-error`,
})

/** One labelled text field over a `Field.Model`. */
const textField = (
	h: H,
	options: Readonly<{
		name: string
		label: string
		model: Field.Model
		type?: string
		placeholder?: string
		toMessage: (message: Field.Message) => Message
	}>,
): Html => {
	const ids = idsOf(options.name)
	const state = Field.stateOf(options.model, false)
	return field(h, { state }, [
		fieldLabel(h, { ids, state }, options.label),
		input(h, {
			ids,
			state,
			attributes: [
				h.Type(options.type ?? "text"),
				...(options.placeholder === undefined ? [] : [h.Placeholder(options.placeholder)]),
				...Field.controlAttributes(h, options.model, options.toMessage),
			],
		}),
	])
}

/** Loading, failed or empty: the table's one-line note, else its rows (kept while they refresh). */
const rowsOr = <A>(
	h: H,
	data: AsyncData.AsyncData<ReadonlyArray<A>, LoadFailure>,
	noun: string,
	render: (rows: ReadonlyArray<A>) => Html,
): Html => {
	const rowsView = (rows: ReadonlyArray<A>) =>
		rows.length === 0 ? emptyMessage(h, {}, [`No ${noun} yet`]) : render(rows)
	return AsyncData.match(data, {
		onIdle: () => emptyMessage(h, {}, [`Loading ${noun}…`]),
		onLoading: () => emptyMessage(h, {}, [`Loading ${noun}…`]),
		onRefreshing: rowsView,
		onFailure: (error) => emptyMessage(h, {}, [failureMessage(error)]),
		onStale: ({ data: rows }) => rowsView(rows),
		onSuccess: rowsView,
	})
}

const dateOf = (ms: number | null, timeZone: string): string =>
	ms === null ? "Never" : formatDateInTimezone(ms, { timeZone })

const orgRow = (h: H, org: AdminOrg, timeZone: string): Html =>
	tableRow(h, [
		tableCell(h, [org.id], "font-mono"),
		tableCell(h, [org.name]),
		tableCell(h, [org.status]),
		tableCell(h, [String(org.memberCount)]),
		tableCell(h, [dateOf(org.createdAt, timeZone)]),
		tableCell(h, [
			hstack(h, { gap: "1", justify: "end" }, [
				button(
					h,
					{
						variant: "ghost",
						size: "sm",
						attributes: [
							h.AriaLabel(`Rename ${org.id}`),
							h.OnClick(Message.ClickedRename({ id: org.id, name: org.name })),
						],
					},
					["Rename"],
				),
				button(
					h,
					{
						variant: "destructive-ghost",
						size: "sm",
						attributes: [
							h.AriaLabel(`Delete ${org.id}`),
							h.OnClick(Message.ClickedDelete({ id: org.id })),
						],
					},
					["Delete"],
				),
			]),
		]),
	])

const orgsSection = (h: H, model: Model, timeZone: string): Html =>
	settingsSection(
		h,
		{
			id: "admin-orgs",
			title: "Organizations",
			padded: false,
			actions: button(h, { attributes: [h.OnClick(Message.ClickedCreate())] }, ["Create organization"]),
		},
		[
			rowsOr(h, model.orgs, "organizations", (orgs) =>
				table(h, { ariaLabel: "Organizations" }, [
					tableHeader(h, [
						tableRow(h, [
							tableHead(h, ["ID"]),
							tableHead(h, ["Name"]),
							tableHead(h, ["Status"]),
							tableHead(h, ["Members"]),
							tableHead(h, ["Created"]),
							tableHead(h, []),
						]),
					]),
					tableBody(
						h,
						Arr.map(orgs, (org) => orgRow(h, org, timeZone)),
					),
				]),
			),
		],
	)

const userRow = (h: H, user: AdminUser, timeZone: string): Html =>
	tableRow(h, [
		tableCell(h, [user.email]),
		tableCell(h, [user.name ?? ""]),
		tableCell(h, [
			Arr.join(
				Arr.map(user.orgs, (org) => `${org.id} (${orgRoleLabel(org.role)})`),
				", ",
			),
		]),
		tableCell(h, [dateOf(user.lastSeenAt, timeZone)]),
	])

const usersSection = (h: H, model: Model, timeZone: string): Html =>
	settingsSection(h, { id: "admin-users", title: "Users", padded: false }, [
		rowsOr(h, model.users, "users", (users) =>
			table(h, { ariaLabel: "Users" }, [
				tableHeader(h, [
					tableRow(h, [
						tableHead(h, ["Email"]),
						tableHead(h, ["Name"]),
						tableHead(h, ["Organizations"]),
						tableHead(h, ["Last seen"]),
					]),
				]),
				tableBody(
					h,
					Arr.map(users, (user) => userRow(h, user, timeZone)),
				),
			]),
		),
	])

const dialogs = (h: H, model: Model): ReadonlyArray<Html> => [
	formDialog(h, {
		slotId: "admin-create-org",
		model: model.createDialog,
		toParentMessage: (message) => Message.GotCreateDialogMessage({ message }),
		title: "Create organization",
		description: "The id is permanent: it names the organization's own database.",
		onSubmit: Message.SubmittedCreate(),
		submitLabel: "Create",
		isPending: model.isCreating,
		isSubmitDisabled:
			Str.trim(model.createId.value) === "" ||
			Str.trim(model.createName.value) === "" ||
			Str.trim(model.createEmail.value) === "",
		fields: [
			textField(h, {
				name: "create-id",
				label: "ID",
				model: model.createId,
				placeholder: "acme",
				toMessage: (message) => Message.GotCreateIdMessage({ message }),
			}),
			textField(h, {
				name: "create-name",
				label: "Name",
				model: model.createName,
				placeholder: "Acme Inc.",
				toMessage: (message) => Message.GotCreateNameMessage({ message }),
			}),
			textField(h, {
				name: "create-email",
				label: "First admin's email",
				type: "email",
				model: model.createEmail,
				placeholder: "admin@acme.com",
				toMessage: (message) => Message.GotCreateEmailMessage({ message }),
			}),
		],
	}),
	formDialog(h, {
		slotId: "admin-rename-org",
		model: model.renameDialog,
		toParentMessage: (message) => Message.GotRenameDialogMessage({ message }),
		title: "Rename organization",
		onSubmit: Message.SubmittedRename(),
		submitLabel: "Rename",
		isPending: model.isRenaming,
		isSubmitDisabled: Str.trim(model.renameName.value) === "",
		fields: [
			textField(h, {
				name: "rename-name",
				label: "Name",
				model: model.renameName,
				toMessage: (message) => Message.GotRenameNameMessage({ message }),
			}),
		],
	}),
	formDialog(h, {
		slotId: "admin-delete-org",
		model: model.deleteDialog,
		toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
		title: "Delete organization?",
		description: `This permanently purges all of ${model.deleting ?? ""}'s data: telemetry, members, invitations and settings. It cannot be undone.`,
		onSubmit: Message.SubmittedDelete(),
		submitLabel: "Delete permanently",
		submitVariant: "destructive",
		isPending: model.isDeleting,
		isSubmitDisabled: !isDeleteConfirmed(model),
		fields: [
			textField(h, {
				name: "delete-confirm",
				label: `Type ${model.deleting ?? ""} to confirm`,
				model: model.deleteConfirm,
				toMessage: (message) => Message.GotDeleteConfirmMessage({ message }),
			}),
		],
	}),
]

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) => {
	const timeZone = inputs.context.timeZone
	if (model.isRoot === null) return dashboardPage(h, { title: "Admin", width: "settings" }, [])
	if (!model.isRoot)
		return dashboardPage(h, { title: "Admin", width: "settings" }, [
			emptyMessage(h, {}, ["Only the root administrator can open this page"]),
		])
	return dashboardPage(h, { title: "Admin", width: "settings" }, [
		settingsSections(h, [
			orgsSection(h, model, timeZone),
			usersSection(h, model, timeZone),
			...dialogs(h, model),
		]),
	])
})
