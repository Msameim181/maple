import { OrgId } from "@maple/primitives"
import { Array as Arr, Clock, Duration, Effect, Option, pipe, Schema, String as Str } from "effect"
import { load } from "foldkit/navigation"
import { MapleAuthApi } from "./auth-api"

// OIDC authorization-code sign-in with PKCE (RFC 7636) against the deployment's identity provider.
// The verifier, state and return path wait in localStorage, keyed by state, across the provider's
// redirect: the provider may come back in another tab (an email verification link).

const PENDING_PREFIX = "maple.oidc.pending."
const PENDING_TTL_MS = Duration.toMillis(Duration.minutes(10))
/** Per tab: this tab already restarted a sign-in whose state it did not know. */
const RESTART_KEY = "maple.oidc.restarted"
/** The org the user last switched to; the callback asks to land there again. */
export const LAST_ORG_KEY = "maple.directory.lastOrg"

/** Keycloak application-initiated actions (`kc_action`), run before the provider returns. */
export const OidcAction = Schema.Literals(["UPDATE_PASSWORD", "CONFIGURE_TOTP", "UPDATE_PROFILE"])
export type OidcAction = typeof OidcAction.Type

const PendingSignIn = Schema.Struct({
	verifier: Schema.String,
	state: Schema.String,
	returnTo: Schema.NullOr(Schema.String),
})
export type PendingSignIn = typeof PendingSignIn.Type
const StoredPendingJson = Schema.fromJsonString(
	Schema.Struct({ ...PendingSignIn.fields, createdAt: Schema.Number }),
)
const decodeStored = Schema.decodeUnknownOption(StoredPendingJson)

/** Web Storage threw (disabled, full, or blocked): the sign-in simply is not remembered. */
class OidcStorageError extends Schema.TaggedError<OidcStorageError>()("@maple/web/OidcStorageError", {
	cause: Schema.Defect(),
}) {}

const tryStorage = <A>(run: () => A) =>
	Effect.try({ try: run, catch: (cause) => new OidcStorageError({ cause }) })

const isLive = (now: number) => (entry: { readonly createdAt: number }) =>
	now - entry.createdAt < PENDING_TTL_MS

const base64Url = (bytes: Uint8Array): string =>
	pipe(
		btoa(String.fromCharCode(...bytes)),
		Str.replaceAll("+", "-"),
		Str.replaceAll("/", "_"),
		// Padding only ever trails.
		Str.replaceAll("=", ""),
	)

/** 32 random bytes, base64url: a 43-character verifier or state. */
export const randomToken = (): string => base64Url(crypto.getRandomValues(new Uint8Array(32)))

/** `BASE64URL(SHA256(verifier))`, the S256 code challenge. */
export const codeChallengeOf = (verifier: string): Effect.Effect<string> =>
	Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))).pipe(
		Effect.map((digest) => base64Url(new Uint8Array(digest))),
	)

/** Where the provider sends the browser back: exactly this, so the callback can repeat it. */
export const redirectUriOf = (origin: string): string => `${origin}/sign-in`

export const authorizeUrlOf = (
	options: Readonly<{
		authorizeUrl: string
		clientId: string
		redirectUri: string
		challenge: string
		state: string
		action?: OidcAction | undefined
	}>,
): string => {
	const url = new URL(options.authorizeUrl)
	url.searchParams.set("response_type", "code")
	url.searchParams.set("client_id", options.clientId)
	url.searchParams.set("redirect_uri", options.redirectUri)
	url.searchParams.set("scope", "openid email profile")
	url.searchParams.set("code_challenge", options.challenge)
	url.searchParams.set("code_challenge_method", "S256")
	url.searchParams.set("state", options.state)
	if (options.action !== undefined) url.searchParams.set("kc_action", options.action)
	return url.toString()
}

/** Saves under its state, and drops expired or unreadable entries other sign-ins left behind. */
export const savePendingSignIn = (pending: PendingSignIn): Effect.Effect<void> =>
	Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis
		const json = yield* Schema.encodeEffect(StoredPendingJson)({ ...pending, createdAt: now })
		yield* tryStorage(() => {
			const keys = Arr.filter(
				Arr.makeBy(localStorage.length, (index) => localStorage.key(index) ?? ""),
				Str.startsWith(PENDING_PREFIX),
			)
			for (const key of keys) {
				if (!Option.exists(decodeStored(localStorage.getItem(key)), isLive(now)))
					localStorage.removeItem(key)
			}
			localStorage.setItem(`${PENDING_PREFIX}${pending.state}`, json)
		})
	}).pipe(Effect.ignore)

/** The live pending sign-in started with `state`, removed as it is read: a code is redeemed at most once. */
export const takePendingSignIn = (state: string): Effect.Effect<Option.Option<PendingSignIn>> =>
	Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis
		const raw = yield* tryStorage(() => {
			const key = `${PENDING_PREFIX}${state}`
			const value = localStorage.getItem(key)
			localStorage.removeItem(key)
			return value
		})
		return Option.flatMap(Option.fromNullishOr(raw), decodeStored).pipe(
			Option.filter((entry) => entry.state === state && isLive(now)(entry)),
			Option.map((entry) => ({
				verifier: entry.verifier,
				state: entry.state,
				returnTo: entry.returnTo,
			})),
		)
	}).pipe(Effect.orElseSucceed(() => Option.none<PendingSignIn>()))

/**
 * A callback whose state this browser does not know: `true` the first time (the tab may restart
 * the sign-in once), `false` on the next miss, which also resets the guard. Storage that throws
 * answers `false`, so a restart can never loop.
 */
export const claimSignInRestart: Effect.Effect<boolean> = tryStorage(() => {
	if (sessionStorage.getItem(RESTART_KEY) === null) {
		sessionStorage.setItem(RESTART_KEY, "1")
		return true
	}
	sessionStorage.removeItem(RESTART_KEY)
	return false
}).pipe(Effect.orElseSucceed(() => false))

export const clearSignInRestart: Effect.Effect<void> = tryStorage(() =>
	sessionStorage.removeItem(RESTART_KEY),
).pipe(Effect.ignore)

/** PKCE: keep the verifier, state and return path for the callback, then leave for the provider. */
export const beginOidcSignIn = (
	options: Readonly<{
		authorizeUrl: string
		clientId: string
		returnTo: string | null
		action?: OidcAction | undefined
	}>,
): Effect.Effect<void> =>
	Effect.gen(function* () {
		const { verifier, state, origin } = yield* Effect.sync(() => ({
			verifier: randomToken(),
			state: randomToken(),
			origin: window.location.origin,
		}))
		const challenge = yield* codeChallengeOf(verifier)
		yield* savePendingSignIn({ verifier, state, returnTo: options.returnTo })
		yield* load(
			authorizeUrlOf({
				authorizeUrl: options.authorizeUrl,
				clientId: options.clientId,
				redirectUri: redirectUriOf(origin),
				challenge,
				state,
				action: options.action,
			}),
		)
	})

/**
 * Runs a provider account action (change password, set up 2FA, edit profile) and comes back
 * signed in at `returnTo`. `false` when the deployment has no OIDC provider or it could not be
 * reached; on success the page is already leaving for the provider.
 */
export const beginOidcAccountAction = (
	action: OidcAction,
	returnTo = "/settings/account",
): Effect.Effect<boolean, never, MapleAuthApi> =>
	Effect.gen(function* () {
		const config = yield* (yield* MapleAuthApi).oidcConfig
		if (!config.enabled) return false
		yield* beginOidcSignIn({
			authorizeUrl: config.authorizeUrl,
			clientId: config.clientId,
			returnTo,
			action,
		})
		return true
	}).pipe(
		Effect.orElseSucceed(() => false),
		Effect.catchDefect(() => Effect.succeed(false)),
	)

export const readLastOrg: Effect.Effect<Option.Option<OrgId>> = Effect.sync(() =>
	localStorage.getItem(LAST_ORG_KEY),
).pipe(
	Effect.map((raw) => Option.flatMap(Option.fromNullishOr(raw), Schema.decodeUnknownOption(OrgId))),
	Effect.orElseSucceed(() => Option.none<OrgId>()),
)

export const writeLastOrg = (orgId: string): Effect.Effect<void> =>
	Effect.sync(() => localStorage.setItem(LAST_ORG_KEY, orgId)).pipe(Effect.ignore)
