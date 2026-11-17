import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { BreadcrumbEntry } from "../../../shell"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { navShell } from "../../kit/nav-shell"
import { type AccountAction, type AccountPerson, type AccountSession, Message, type Model } from "./model"
import { accountNavSections, accountTabLabels } from "./nav"
import * as ProfileView from "./profile/view"
import * as EmailPreferencesView from "./email-preferences/view"
import * as TwoFactorView from "./two-factor/view"
import * as SessionsView from "./sessions/view"
import * as ConnectionsView from "./connections/view"
import * as PasskeysView from "./passkeys/view"
import * as EmailsView from "./emails/view"
import * as PasswordView from "./password/view"
import { activeTabOf } from "./update"
import { formatDateInTimezone } from "@maple/ui/lib/timezone-format"
import { Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import { failureMessage } from "@maple/views/data/load-failure"
import { button, linkButton } from "@maple/views/ui/button"
import { badge } from "@maple/views/ui/display"
import { emptyMessage } from "@maple/views/ui/empty"
import { keyValue, keyValueList } from "@maple/views/ui/key-value"
import { listRow } from "@maple/views/ui/list-row"
import { dividedList } from "@maple/views/ui/rule"
import { hstack } from "@maple/views/ui/stack"
import { settingsSection, settingsSections } from "../../kit/settings-section"

type H = HtmlBuilder<Message>

export const breadcrumbs = (model: Model): ReadonlyArray<BreadcrumbEntry> =>
	model.person === null
		? [{ label: "Account", href: "/account" }, { label: accountTabLabels[activeTabOf(model)] }]
		: [{ label: "Account" }]

const ACTIONS: ReadonlyArray<
	Readonly<{ action: AccountAction; label: string; description: string }>
> = [
	{ action: "UPDATE_PASSWORD", label: "Change password", description: "Choose a new password." },
	{
		action: "CONFIGURE_TOTP",
		label: "Two-factor authentication",
		description: "Add an authenticator app for a second sign-in step.",
	},
	{ action: "UPDATE_PROFILE", label: "Edit profile", description: "Change your name and email." },
]

const sessionRow = (h: H, session: AccountSession, timeZone: string): Html =>
	listRow(
		h,
		{
			as: "li",
			title: session.current ? "This device" : "Another device",
			meta: `Signed in ${formatDateInTimezone(session.createdAt, { timeZone })}, active ${formatDateInTimezone(session.refreshedAt, { timeZone })}`,
			trailing: session.current ? [badge(h, { variant: "secondary" }, ["Current"])] : [],
		},
		[h.Key(session.id)],
	)

const sessionsSection = (h: H, model: Model, timeZone: string): Html =>
	settingsSection(
		h,
		{
			id: "account-sessions",
			title: "Your sessions",
			description: ["Where you are signed in to Maple."],
			padded: false,
			actions: button(
				h,
				{
					variant: "destructive-ghost",
					size: "sm",
					isLoading: model.isSigningOut,
					attributes: [h.OnClick(Message.ClickedSignOutEverywhere())],
				},
				["Sign out everywhere"],
			),
		},
		[
			AsyncData.match(model.sessions, {
				onIdle: () => emptyMessage(h, {}, ["Loading sessions…"]),
				onLoading: () => emptyMessage(h, {}, ["Loading sessions…"]),
				onRefreshing: (rows) => sessionRows(h, rows, timeZone),
				onFailure: (error) => emptyMessage(h, {}, [failureMessage(error)]),
				onStale: ({ data: rows }) => sessionRows(h, rows, timeZone),
				onSuccess: (rows) => sessionRows(h, rows, timeZone),
			}),
		],
	)

const sessionRows = (h: H, rows: ReadonlyArray<AccountSession>, timeZone: string): Html =>
	rows.length === 0
		? emptyMessage(h, {}, ["No sessions"])
		: dividedList(h, { as: "ul", bordered: false }, Arr.map(rows, (row) => sessionRow(h, row, timeZone)))

/** The OIDC directory: Maple shows the person and starts password, 2FA and profile changes at the provider. */
const nativeAccount = (h: H, model: Model, person: AccountPerson, timeZone: string): ReadonlyArray<Html> => [
	settingsSection(h, { id: "account-you", title: "Your account" }, [
		keyValueList(h, { divided: true }, [
			keyValue(h, { label: "Name" }, [person.name ?? person.email]),
			keyValue(h, { label: "Email" }, [person.email]),
		]),
		hstack(h, { gap: "2", wrap: true, className: "pt-3" }, [
			...Arr.map(ACTIONS, (entry) =>
				button(
					h,
					{
						variant: "outline",
						size: "sm",
						attributes: [
							h.Title(entry.description),
							h.OnClick(Message.ClickedAccountAction({ action: entry.action })),
						],
					},
					[entry.label],
				),
			),
		]),
	]),
	sessionsSection(h, model, timeZone),
	// Root (IT) only: the update step drops the URL for everyone else.
	...(model.accountUrl === null
		? []
		: [
				settingsSection(
					h,
					{
						id: "account-idp",
						title: "Identity provider console",
						description: ["For IT administrators: manage realms, users and login settings."],
					},
					[
						linkButton(
							h,
							{
								href: model.accountUrl,
								variant: "outline",
								size: "sm",
								attributes: [
									h.Attribute("rel", "noopener noreferrer"),
									h.Attribute("target", "_blank"),
								],
							},
							["Open console"],
						),
					],
				),
			]),
]

const tabContent = (h: H, model: Model, inputs: PageViewInputs): ReadonlyArray<Html> => {
	const tab = model.tab
	if (tab === null) return []
	switch (tab._tag) {
		case "Profile":
			return [
				h.submodel({
					slotId: "account-profile",
					model: tab.model,
					view: ProfileView.view,
					toParentMessage: (message) => Message.GotProfileMessage({ message }),
					viewInputs: {},
				}),
			]
		case "Password":
			return [
				h.submodel({
					slotId: "account-password",
					model: tab.model,
					view: PasswordView.view,
					toParentMessage: (message) => Message.GotPasswordMessage({ message }),
					viewInputs: {},
				}),
			]
		case "Emails":
			return [
				h.submodel({
					slotId: "account-emails",
					model: tab.model,
					view: EmailsView.view,
					toParentMessage: (message) => Message.GotEmailsMessage({ message }),
					viewInputs: {},
				}),
			]
		case "Passkeys":
			return [
				h.submodel({
					slotId: "account-passkeys",
					model: tab.model,
					view: PasskeysView.view,
					toParentMessage: (message) => Message.GotPasskeysMessage({ message }),
					viewInputs: { timeZone: inputs.context.timeZone, nowMs: model.nowMs },
				}),
			]
		case "Connections":
			return [
				h.submodel({
					slotId: "account-connections",
					model: tab.model,
					view: ConnectionsView.view,
					toParentMessage: (message) => Message.GotConnectionsMessage({ message }),
					viewInputs: {},
				}),
			]
		case "Sessions":
			return [
				h.submodel({
					slotId: "account-sessions",
					model: tab.model,
					view: SessionsView.view,
					toParentMessage: (message) => Message.GotSessionsMessage({ message }),
					viewInputs: { nowMs: model.nowMs, timeZone: inputs.context.timeZone },
				}),
			]
		case "TwoFactor":
			return [
				h.submodel({
					slotId: "account-two-factor",
					model: tab.model,
					view: TwoFactorView.view,
					toParentMessage: (message) => Message.GotTwoFactorMessage({ message }),
					viewInputs: {},
				}),
			]
		case "EmailPreferences":
			return [
				h.submodel({
					slotId: "account-email-preferences",
					model: tab.model,
					view: EmailPreferencesView.view,
					toParentMessage: (message) => Message.GotEmailPreferencesMessage({ message }),
					viewInputs: {},
				}),
			]
	}
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	model.tab === null
		? dashboardPage(
				h,
				{ width: "settings" },
				model.person === null
					? []
					: [settingsSections(h, nativeAccount(h, model, model.person, inputs.context.timeZone))],
			)
		: dashboardPage(
				h,
				{
					filtersLabel: "Account settings",
					filters: navShell(h, accountNavSections, activeTabOf(model), (tab) =>
						Message.ClickedTab({ tab }),
					),
					width: "settings",
				},
				tabContent(h, model, inputs),
			),
)
