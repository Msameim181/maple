import { readClock } from "@maple/views/data/timing"
import { isClerkAuthEnabled } from "../../../platform/auth-mode"
import { Command } from "foldkit"
import { Effect, Option, Result } from "effect"
import { load } from "foldkit/navigation"
import { settleTo } from "@maple/views/data/load-failure"
import { AsyncData } from "foldkit"
import { MapleApiClient } from "../../../platform/api-clients"
import { clearSessionToken } from "../../../platform/auth-api"
import { beginOidcAccountAction } from "../../../platform/oidc"
import { apiErrorMessage, DirectoryMe } from "../../../data/directory-me"
import { MapleAuthApi } from "../../../platform/auth-api"
import { REVERIFICATION_CANCELLED } from "../../../platform/clerk"
import { AppRoute, hrefOf } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { AccountAction, Message, type Model, type TabModel } from "./model"
import { type AccountTab, resolveActiveAccountTab } from "./nav"
import * as Profile from "./profile/update"
import * as EmailPreferences from "./email-preferences/update"
import * as TwoFactor from "./two-factor/update"
import * as Sessions from "./sessions/update"
import * as Connections from "./connections/update"
import * as Passkeys from "./passkeys/update"
import * as Emails from "./emails/update"
import * as Password from "./password/update"

type Return = PageReturn<Model, Message>
type AccountRoute = Extract<AppRoute, { readonly _tag: "Account" }>

const ReadAccountClock = readClock("ReadAccountClock", Message.ReadClock)

/** Signed in through the directory: who they are, the provider's endpoints, and (root only) its console. */
export const LoadAccount = Command.define("LoadAccount", {
	messages: [Message.LoadedAccount],
	execute: Effect.gen(function* () {
		const viewer = yield* (yield* DirectoryMe).get
		if (Option.isNone(viewer)) return Message.LoadedAccount({ account: null })
		const config = yield* (yield* MapleAuthApi).oidcConfig
		if (!config.enabled) return Message.LoadedAccount({ account: null })
		const me = yield* (yield* MapleApiClient).directory.me()
		return Message.LoadedAccount({
			account: {
				person: { name: me.user.name, email: me.user.email, isRoot: me.isRoot },
				oidc: { authorizeUrl: config.authorizeUrl, clientId: config.clientId },
				// The identity provider's URL is for IT only.
				accountUrl: me.isRoot && config.accountUrl !== "" ? config.accountUrl : null,
			},
		})
	}).pipe(Effect.orElseSucceed(() => Message.LoadedAccount({ account: null }))),
})

export const LoadSessions = Command.define("LoadAccountSessions", {
	messages: [Message.CompletedLoadSessions],
	execute: Effect.gen(function* () {
		const client = yield* MapleApiClient
		return (yield* client.auth.listSessions()).sessions
	}).pipe(settleTo((result) => Message.CompletedLoadSessions({ result }))),
})

/** PKCE sign-in with a Keycloak Application-Initiated Action (`kc_action`), landing back on the account page. */
export const BeginAccountAction = Command.define("BeginAccountAction", {
	args: { action: AccountAction },
	messages: [Message.FailedAccountAction],
	execute: ({ action }) =>
		beginOidcAccountAction(action).pipe(Effect.as(Message.FailedAccountAction())),
})

/** Ends every session here and at the provider, then drops the local token and goes to sign-in. */
export const SignOutEverywhere = Command.define("SignOutEverywhere", {
	messages: [Message.CompletedSignOutEverywhere],
	execute: Effect.gen(function* () {
		const client = yield* MapleApiClient
		yield* client.auth.logoutAll()
	}).pipe(
		Effect.andThen(clearSessionToken),
		Effect.andThen(load("/sign-in")),
		Effect.as(Message.CompletedSignOutEverywhere({ result: Result.succeed(undefined) })),
		Effect.catch((error) =>
			Effect.succeed(
				Message.CompletedSignOutEverywhere({
					result: Result.fail(apiErrorMessage(error, "Couldn't sign you out everywhere")),
				}),
			),
		),
	),
})

const toSettings = PageOutMessage.RequestedNavigation({
	url: hrefOf(AppRoute.Settings({ search: {} })),
	isReplace: true,
})

export const activeTabOf = (model: Model): AccountTab => resolveActiveAccountTab(model.search.tab)

const TAB_TAGS = {
	profile: "Profile",
	password: "Password",
	emails: "Emails",
	passkeys: "Passkeys",
	connections: "Connections",
	sessions: "Sessions",
	"two-factor": "TwoFactor",
	"email-preferences": "EmailPreferences",
} as const satisfies Record<AccountTab, TabModel["_tag"]>
const tabTag = (tab: AccountTab): TabModel["_tag"] => TAB_TAGS[tab]

const isTabCurrent = (current: TabModel | null, tab: AccountTab): boolean =>
	current !== null && current._tag === tabTag(tab)

const initTab = (model: Model, tab: AccountTab, _context: PageContext): Return => {
	switch (tabTag(tab)) {
		case "Profile": {
			const step = Profile.init()
			return {
				model: { ...model, tab: { _tag: "Profile", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotProfileMessage({ message }),
				),
			}
		}
		case "Password": {
			const step = Password.init()
			return {
				model: { ...model, tab: { _tag: "Password", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotPasswordMessage({ message }),
				),
			}
		}
		case "Emails": {
			const step = Emails.init()
			return {
				model: { ...model, tab: { _tag: "Emails", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotEmailsMessage({ message }),
				),
			}
		}
		case "Passkeys": {
			const step = Passkeys.init()
			return {
				model: { ...model, tab: { _tag: "Passkeys", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotPasskeysMessage({ message }),
				),
			}
		}
		case "Connections": {
			const step = Connections.init()
			return {
				model: { ...model, tab: { _tag: "Connections", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotConnectionsMessage({ message }),
				),
			}
		}
		case "Sessions": {
			const step = Sessions.init()
			return {
				model: { ...model, tab: { _tag: "Sessions", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotSessionsMessage({ message }),
				),
			}
		}
		case "TwoFactor": {
			const step = TwoFactor.init()
			return {
				model: { ...model, tab: { _tag: "TwoFactor", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotTwoFactorMessage({ message }),
				),
			}
		}
		case "EmailPreferences": {
			const step = EmailPreferences.init()
			return {
				model: { ...model, tab: { _tag: "EmailPreferences", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (message) =>
					Message.GotEmailPreferencesMessage({ message }),
				),
			}
		}
	}
}

/** Self-hosted links the identity provider's account page, or has nothing here and goes to `/settings`. */
const enter = (model: Model, context: PageContext): Return => {
	if (!isClerkAuthEnabled)
		return model.person === null
			? { model: { ...model, tab: null }, commands: [LoadAccount()] }
			: { model }
	const tab = activeTabOf(model)
	return isTabCurrent(model.tab, tab) ? { model } : initTab(model, tab, context)
}

export const init = (route: AccountRoute, context: PageContext): Return => {
	const entered = enter(
		{
			search: route.search,
			nowMs: 0,
			tab: null,
			person: null,
			oidc: null,
			accountUrl: null,
			sessions: AsyncData.Loading(),
			isSigningOut: false,
		},
		context,
	)
	return { ...entered, commands: [ReadAccountClock(), ...(entered.commands ?? [])] }
}

export const routeChanged = (model: Model, route: AccountRoute, context: PageContext): Return =>
	enter({ ...model, search: route.search }, context)

/** Dismissing Clerk's re-verification challenge is a no-op, not an error. */
const withoutCancelledToast = (step: Return): Return =>
	step.outMessage !== undefined &&
	step.outMessage._tag === "RequestedToast" &&
	step.outMessage.title === REVERIFICATION_CANCELLED
		? { ...step, outMessage: undefined }
		: step

export const update = (model: Model, message: Message, _context: PageContext): Return =>
	withoutCancelledToast(updateTab(model, message))

const updateTab = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		LoadedAccount: ({ account }) =>
			account === null
				? { model, outMessage: toSettings }
				: {
						model: {
							...model,
							person: account.person,
							oidc: account.oidc,
							accountUrl: account.accountUrl,
						},
						commands: [LoadSessions()],
					},
		CompletedLoadSessions: ({ result }) => ({
			model: { ...model, sessions: AsyncData.settle(model.sessions, result) },
		}),
		ClickedAccountAction: ({ action }) =>
			model.oidc === null
				? { model }
				: { model, commands: [BeginAccountAction({ action })] },
		FailedAccountAction: () => ({
			model,
			outMessage: PageOutMessage.RequestedToast({
				type: "error",
				title: "Couldn't open the sign-in page",
				description: "",
			}),
		}),
		ClickedSignOutEverywhere: () =>
			model.isSigningOut ? { model } : { model: { ...model, isSigningOut: true }, commands: [SignOutEverywhere()] },
		CompletedSignOutEverywhere: ({ result }) =>
			Result.match(result, {
				// The navigation to /sign-in is already under way.
				onSuccess: () => ({ model }),
				onFailure: (title) => ({
					model: { ...model, isSigningOut: false },
					outMessage: PageOutMessage.RequestedToast({ type: "error", title, description: "" }),
				}),
			}),
		ClickedTab: ({ tab }) => ({
			model,
			outMessage: PageOutMessage.RequestedNavigation({
				url: hrefOf(AppRoute.Account({ search: { tab } })),
				isReplace: false,
			}),
		}),
		GotPasswordMessage: ({ message: inner }) => {
			if (model.tab === null || model.tab._tag !== "Password") return { model }
			const step = Password.update(model.tab.model, inner)
			return {
				model: { ...model, tab: { _tag: "Password", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (child) =>
					Message.GotPasswordMessage({ message: child }),
				),
				outMessage: step.outMessage,
			}
		},
		GotEmailsMessage: ({ message: inner }) => {
			if (model.tab === null || model.tab._tag !== "Emails") return { model }
			const step = Emails.update(model.tab.model, inner)
			return {
				model: { ...model, tab: { _tag: "Emails", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (child) =>
					Message.GotEmailsMessage({ message: child }),
				),
				outMessage: step.outMessage,
			}
		},
		GotPasskeysMessage: ({ message: inner }) => {
			if (model.tab === null || model.tab._tag !== "Passkeys") return { model }
			const step = Passkeys.update(model.tab.model, inner)
			return {
				model: { ...model, tab: { _tag: "Passkeys", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (child) =>
					Message.GotPasskeysMessage({ message: child }),
				),
				outMessage: step.outMessage,
			}
		},
		GotConnectionsMessage: ({ message: inner }) => {
			if (model.tab === null || model.tab._tag !== "Connections") return { model }
			const step = Connections.update(model.tab.model, inner)
			return {
				model: { ...model, tab: { _tag: "Connections", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (child) =>
					Message.GotConnectionsMessage({ message: child }),
				),
				outMessage: step.outMessage,
			}
		},
		GotSessionsMessage: ({ message: inner }) => {
			if (model.tab === null || model.tab._tag !== "Sessions") return { model }
			const step = Sessions.update(model.tab.model, inner)
			return {
				model: { ...model, tab: { _tag: "Sessions", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (child) =>
					Message.GotSessionsMessage({ message: child }),
				),
				outMessage: step.outMessage,
			}
		},
		GotTwoFactorMessage: ({ message: inner }) => {
			if (model.tab === null || model.tab._tag !== "TwoFactor") return { model }
			const step = TwoFactor.update(model.tab.model, inner)
			return {
				model: { ...model, tab: { _tag: "TwoFactor", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (child) =>
					Message.GotTwoFactorMessage({ message: child }),
				),
				outMessage: step.outMessage,
			}
		},
		GotEmailPreferencesMessage: ({ message: inner }) => {
			if (model.tab === null || model.tab._tag !== "EmailPreferences") return { model }
			const step = EmailPreferences.update(model.tab.model, inner)
			return {
				model: { ...model, tab: { _tag: "EmailPreferences", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (child) =>
					Message.GotEmailPreferencesMessage({ message: child }),
				),
				outMessage: step.outMessage,
			}
		},
		GotProfileMessage: ({ message: inner }) => {
			if (model.tab === null || model.tab._tag !== "Profile") return { model }
			const step = Profile.update(model.tab.model, inner)
			return {
				model: { ...model, tab: { _tag: "Profile", model: step.model } },
				commands: Command.mapMessages(step.commands ?? [], (child) =>
					Message.GotProfileMessage({ message: child }),
				),
				outMessage: step.outMessage,
			}
		},
	})
