import { Schema } from "effect"
import { AsyncData } from "foldkit"
import { LoadFailure } from "@maple/views/data/load-failure"
import { defineMessageUnion } from "foldkit/message"
import { accountTabValues, AccountSearch } from "../../../route/search"
import * as Profile from "./profile/model"
import * as EmailPreferences from "./email-preferences/model"
import * as TwoFactor from "./two-factor/model"
import * as Sessions from "./sessions/model"
import * as Connections from "./connections/model"
import * as Passkeys from "./passkeys/model"
import * as Emails from "./emails/model"
import * as Password from "./password/model"

// `/account`: the account nav rail and the active tab. Clerk only; self-hosted has a single root pseudo-user
// and redirects to `/settings`.

/** The active tab's state; a tab switch drops the old one (the section unmounts). */
export const TabModel = Schema.Union([
	Schema.TaggedStruct("Profile", { model: Profile.Model }),
	Schema.TaggedStruct("Password", { model: Password.Model }),
	Schema.TaggedStruct("Emails", { model: Emails.Model }),
	Schema.TaggedStruct("Passkeys", { model: Passkeys.Model }),
	Schema.TaggedStruct("Connections", { model: Connections.Model }),
	Schema.TaggedStruct("Sessions", { model: Sessions.Model }),
	Schema.TaggedStruct("TwoFactor", { model: TwoFactor.Model }),
	Schema.TaggedStruct("EmailPreferences", { model: EmailPreferences.Model }),
])
export type TabModel = typeof TabModel.Type

/** Self-hosted with OIDC: the signed-in person, read from the directory. */
export const AccountPerson = Schema.Struct({
	name: Schema.NullOr(Schema.String),
	email: Schema.String,
	isRoot: Schema.Boolean,
})
export type AccountPerson = typeof AccountPerson.Type

export const OidcEndpoint = Schema.Struct({ authorizeUrl: Schema.String, clientId: Schema.String })

export const AccountSession = Schema.Struct({
	id: Schema.String,
	createdAt: Schema.Number,
	refreshedAt: Schema.Number,
	current: Schema.Boolean,
})
export type AccountSession = typeof AccountSession.Type

/** Keycloak Application-Initiated Actions the person can start from their account. */
export const AccountAction = Schema.Literals(["UPDATE_PASSWORD", "CONFIGURE_TOTP", "UPDATE_PROFILE"])
export type AccountAction = typeof AccountAction.Type

export const SessionsData = AsyncData.Schema(Schema.Array(AccountSession), LoadFailure)

export const Model = Schema.Struct({
	search: AccountSearch,
	/** The clock at entry, for relative times. */
	nowMs: Schema.Number,
	/** `null` while redirecting (self-hosted), and with the OIDC directory. */
	tab: Schema.NullOr(TabModel),
	/** Self-hosted with OIDC: who is signed in; `null` until the directory answers. */
	person: Schema.NullOr(AccountPerson),
	oidc: Schema.NullOr(OidcEndpoint),
	/** The identity provider's console, kept only for root (IT): everyone else never sees the URL. */
	accountUrl: Schema.NullOr(Schema.String),
	sessions: SessionsData.schema,
	isSigningOut: Schema.Boolean,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
	ReadClock: { nowMs: Schema.Number },
	/** `null`: no identity provider, so self-hosted has nothing to manage here. */
	LoadedAccount: {
		account: Schema.NullOr(
			Schema.Struct({ person: AccountPerson, oidc: OidcEndpoint, accountUrl: Schema.NullOr(Schema.String) }),
		),
	},
	CompletedLoadSessions: { result: Schema.Result(Schema.Array(AccountSession), LoadFailure) },
	ClickedAccountAction: { action: AccountAction },
	FailedAccountAction: {},
	ClickedSignOutEverywhere: {},
	CompletedSignOutEverywhere: { result: Schema.Result(Schema.Void, Schema.String) },
	ClickedTab: { tab: Schema.Literals(accountTabValues) },
	GotProfileMessage: { message: Profile.Message },
	GotEmailPreferencesMessage: { message: EmailPreferences.Message },
	GotTwoFactorMessage: { message: TwoFactor.Message },
	GotSessionsMessage: { message: Sessions.Message },
	GotConnectionsMessage: { message: Connections.Message },
	GotPasskeysMessage: { message: Passkeys.Message },
	GotEmailsMessage: { message: Emails.Message },
	GotPasswordMessage: { message: Password.Message },
})
export type Message = typeof Message.Type
