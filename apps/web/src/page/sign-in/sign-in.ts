import { Effect, Option, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { load, replaceUrl } from "foldkit/navigation"
import { OidcCallbackRequest } from "@maple/domain/http"
import { defineMessageUnion } from "foldkit/message"
import { defineTaggedUnion } from "foldkit/schema"
import { modifyFields } from "foldkit/struct"
import { MapleAuthApi } from "../../platform/auth-api"
import { apiErrorMessage } from "../../data/directory-me"
import {
	authorizeUrlOf,
	codeChallengeOf,
	randomToken,
	readLastOrg,
	redirectUriOf,
	savePendingSignIn,
	takePendingSignIn,
} from "../../platform/oidc"

/** Why the root password was not accepted; the view turns it into copy. */
export const SignInFailure = defineTaggedUnion({
	Rejected: { message: Schema.String },
	/** OIDC: the provider vouched for the user, but no org has them yet. */
	NoOrganization: {},
	Unreachable: {},
	Unexpected: {},
})
export type SignInFailure = typeof SignInFailure.Type

export const Submission = defineTaggedUnion({
	NotSubmitted: {},
	Submitting: {},
	Failed: { failure: SignInFailure },
})
export type Submission = typeof Submission.Type

/** The deployment's OIDC provider, when it has one (`GET /api/auth/oidc/config`). */
export const OidcProvider = Schema.Struct({ authorizeUrl: Schema.String, clientId: Schema.String })
export type OidcProvider = typeof OidcProvider.Type

export const Model = Schema.Struct({
	/** `null` until the config answers, and for good without OIDC. */
	oidc: Schema.NullOr(OidcProvider),
	/** With OIDC on, the root-password form waits behind "Use root password". */
	isRootPasswordShown: Schema.Boolean,
	sso: Submission,
	password: Schema.String,
	/** Base UI field state: focused now, and blurred at least once. */
	isPasswordFocused: Schema.Boolean,
	isPasswordTouched: Schema.Boolean,
	submission: Submission,
})
export type Model = typeof Model.Type

export const init = (): Model => ({
	oidc: null,
	isRootPasswordShown: false,
	sso: Submission.NotSubmitted(),
	password: "",
	isPasswordFocused: false,
	isPasswordTouched: false,
	submission: Submission.NotSubmitted(),
})

export const Message = defineMessageUnion({
	UpdatedPassword: { value: Schema.String },
	FocusedPassword: {},
	BlurredPassword: {},
	SubmittedSignIn: {},
	SucceededSignInWithRootPassword: { token: Schema.String },
	FailedSignInWithRootPassword: { failure: SignInFailure },
	LoadedOidcConfig: { oidc: Schema.NullOr(OidcProvider) },
	ClickedSignInWithSso: {},
	ClickedUseRootPassword: {},
	RedirectedToSso: {},
	SucceededSignInWithSso: { token: Schema.String, returnTo: Schema.NullOr(Schema.String) },
	FailedSignInWithSso: { failure: SignInFailure },
})
export type Message = typeof Message.Type

export const OutMessage = defineMessageUnion({
	/** `returnTo`: where an OIDC sign-in started, since the provider returns to a bare `/sign-in`. */
	SucceededSignIn: { token: Schema.String, returnTo: Schema.optionalKey(Schema.String) },
})
export type OutMessage = typeof OutMessage.Type

const rejected = (error: { readonly message: string }) =>
	Effect.succeed(
		Message.FailedSignInWithRootPassword({ failure: SignInFailure.Rejected({ message: error.message }) }),
	)

/** `POST /api/auth/login` with the root password. */
export const SignInWithRootPassword = Command.define("SignInWithRootPassword", {
	args: { password: Schema.String },
	messages: [Message.SucceededSignInWithRootPassword, Message.FailedSignInWithRootPassword],
	execute: ({ password }) =>
		Effect.gen(function* () {
			const auth = yield* MapleAuthApi
			const session = yield* auth.login(password)
			return Message.SucceededSignInWithRootPassword({ token: session.token })
		}).pipe(
			Effect.catchTags({
				"@maple/http/errors/SelfHostedInvalidPasswordError": rejected,
				"@maple/http/errors/SelfHostedAuthDisabledError": rejected,
				HttpClientError: (error) =>
					Effect.succeed(
						Message.FailedSignInWithRootPassword({
							failure:
								error.reason._tag === "TransportError"
									? SignInFailure.Unreachable()
									: SignInFailure.Unexpected(),
						}),
					),
			}),
			Effect.orElseSucceed(() =>
				Message.FailedSignInWithRootPassword({ failure: SignInFailure.Unexpected() }),
			),
		),
})

const failedSso = (failure: SignInFailure) => Message.FailedSignInWithSso({ failure })

/** `GET /api/auth/oidc/config`; any failure reads as no provider, leaving the root password. */
export const LoadOidcConfig = Command.define("LoadOidcConfig", {
	messages: [Message.LoadedOidcConfig],
	execute: Effect.gen(function* () {
		const config = yield* (yield* MapleAuthApi).oidcConfig
		return Message.LoadedOidcConfig({
			oidc: config.enabled ? { authorizeUrl: config.authorizeUrl, clientId: config.clientId } : null,
		})
	}).pipe(Effect.orElseSucceed(() => Message.LoadedOidcConfig({ oidc: null }))),
})

/** PKCE: keep the verifier, state and return path for the callback, then leave for the provider. */
export const BeginOidcSignIn = Command.define("BeginOidcSignIn", {
	args: { authorizeUrl: Schema.String, clientId: Schema.String },
	messages: [Message.RedirectedToSso, Message.FailedSignInWithSso],
	execute: ({ authorizeUrl, clientId }) =>
		Effect.gen(function* () {
			const { verifier, state, returnTo, origin } = yield* Effect.sync(() => ({
				verifier: randomToken(),
				state: randomToken(),
				returnTo: new URLSearchParams(window.location.search).get("redirect_url"),
				origin: window.location.origin,
			}))
			const challenge = yield* codeChallengeOf(verifier)
			yield* savePendingSignIn({ verifier, state, returnTo })
			yield* load(
				authorizeUrlOf({
					authorizeUrl,
					clientId,
					redirectUri: redirectUriOf(origin),
					challenge,
					state,
				}),
			)
			return Message.RedirectedToSso()
		}).pipe(Effect.catchDefect(() => Effect.succeed(failedSso(SignInFailure.Unexpected())))),
})

/** The provider's redirect back: the state must be the one this tab sent, then the code is redeemed. */
export const CompleteOidcSignIn = Command.define("CompleteOidcSignIn", {
	args: { code: Schema.String, state: Schema.String },
	messages: [Message.SucceededSignInWithSso, Message.FailedSignInWithSso],
	execute: ({ code, state }) =>
		Effect.gen(function* () {
			const origin = yield* Effect.sync(() => window.location.origin)
			// The code is single-use: off the URL (and history) before anything else.
			yield* replaceUrl("/sign-in")
			const pending = yield* takePendingSignIn
			if (Option.isNone(pending) || pending.value.state !== state)
				return failedSso(SignInFailure.Rejected({ message: "This sign-in expired. Sign in again." }))
			const lastOrg = yield* readLastOrg
			const fields = { code, codeVerifier: pending.value.verifier, redirectUri: redirectUriOf(origin) }
			const request = Option.match(lastOrg, {
				onNone: () => new OidcCallbackRequest(fields),
				onSome: (orgId) => new OidcCallbackRequest({ ...fields, orgId }),
			})
			const session = yield* (yield* MapleAuthApi).oidcCallback(request)
			return Message.SucceededSignInWithSso({ token: session.token, returnTo: pending.value.returnTo })
		}).pipe(
			Effect.catchTags({
				"@maple/http/errors/NoOrganizationError": () =>
					Effect.succeed(failedSso(SignInFailure.NoOrganization())),
				HttpClientError: (error) =>
					Effect.succeed(
						failedSso(
							error.reason._tag === "TransportError"
								? SignInFailure.Unreachable()
								: SignInFailure.Unexpected(),
						),
					),
			}),
			Effect.catch((error) => {
				const message = apiErrorMessage(error, "")
				return Effect.succeed(
					failedSso(
						message === "" ? SignInFailure.Unexpected() : SignInFailure.Rejected({ message }),
					),
				)
			}),
		),
})

/** Entering `/sign-in`: ask for the provider, and redeem a code the provider just sent back. */
export const enter = (
	model: Model,
	search: Readonly<{ code?: string | undefined; state?: string | undefined }>,
): Update.ReturnWithOutMessage<Model, Message, OutMessage, MapleAuthApi> =>
	search.code !== undefined && search.state !== undefined
		? {
				model: modifyFields(model, { sso: () => Submission.Submitting() }),
				commands: [LoadOidcConfig(), CompleteOidcSignIn({ code: search.code, state: search.state })],
			}
		: { model, commands: [LoadOidcConfig()] }

type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, OutMessage, MapleAuthApi>

export const update = (model: Model, message: Message) =>
	Message.match<UpdateReturn>(message, {
		UpdatedPassword: ({ value }) => ({ model: modifyFields(model, { password: () => value }) }),
		FocusedPassword: () => ({ model: modifyFields(model, { isPasswordFocused: () => true }) }),
		BlurredPassword: () => ({
			model: modifyFields(model, { isPasswordFocused: () => false, isPasswordTouched: () => true }),
		}),
		SubmittedSignIn: () =>
			Submission.match(model.submission, {
				Submitting: () => ({ model }),
				NotSubmitted: () => submit(model),
				Failed: () => submit(model),
			}),
		SucceededSignInWithRootPassword: ({ token }) => ({
			model,
			outMessage: OutMessage.SucceededSignIn({ token }),
		}),
		FailedSignInWithRootPassword: ({ failure }) => ({
			model: modifyFields(model, { submission: () => Submission.Failed({ failure }) }),
		}),
		LoadedOidcConfig: ({ oidc }) => ({ model: modifyFields(model, { oidc: () => oidc }) }),
		ClickedSignInWithSso: () =>
			model.oidc === null || model.sso._tag === "Submitting"
				? { model }
				: {
						model: modifyFields(model, { sso: () => Submission.Submitting() }),
						commands: [BeginOidcSignIn(model.oidc)],
					},
		ClickedUseRootPassword: () => ({ model: modifyFields(model, { isRootPasswordShown: () => true }) }),
		RedirectedToSso: () => ({ model }),
		SucceededSignInWithSso: ({ token, returnTo }) => ({
			model,
			outMessage: OutMessage.SucceededSignIn(returnTo === null ? { token } : { token, returnTo }),
		}),
		FailedSignInWithSso: ({ failure }) => ({
			model: modifyFields(model, { sso: () => Submission.Failed({ failure }) }),
		}),
	})

const submit = (model: Model): UpdateReturn => ({
	model: modifyFields(model, { submission: () => Submission.Submitting() }),
	commands: [SignInWithRootPassword({ password: model.password })],
})
