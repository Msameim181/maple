import { OrgId } from "@maple/primitives"
import { Effect, Option, pipe, Schema, String as Str } from "effect"

// OIDC authorization-code sign-in with PKCE (RFC 7636) against the deployment's identity provider.
// The verifier, state and return path wait in sessionStorage across the provider's redirect.

const PENDING_KEY = "maple.oidc.pending"
/** The org the user last switched to; the callback asks to land there again. */
export const LAST_ORG_KEY = "maple.directory.lastOrg"

const PendingSignIn = Schema.Struct({
	verifier: Schema.String,
	state: Schema.String,
	returnTo: Schema.NullOr(Schema.String),
})
export type PendingSignIn = typeof PendingSignIn.Type
const PendingJson = Schema.fromJsonString(PendingSignIn)

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
	return url.toString()
}

export const savePendingSignIn = (pending: PendingSignIn): Effect.Effect<void> =>
	Schema.encodeEffect(PendingJson)(pending).pipe(
		Effect.flatMap((json) => Effect.sync(() => sessionStorage.setItem(PENDING_KEY, json))),
		Effect.ignore,
	)

/** The pending sign-in, removed as it is read: a code is redeemed at most once. */
export const takePendingSignIn: Effect.Effect<Option.Option<PendingSignIn>> = Effect.sync(() => {
	const raw = sessionStorage.getItem(PENDING_KEY)
	sessionStorage.removeItem(PENDING_KEY)
	return raw
}).pipe(
	Effect.map((raw) => Option.flatMap(Option.fromNullishOr(raw), Schema.decodeUnknownOption(PendingJson))),
	Effect.orElseSucceed(() => Option.none<PendingSignIn>()),
)

export const readLastOrg: Effect.Effect<Option.Option<OrgId>> = Effect.sync(() =>
	localStorage.getItem(LAST_ORG_KEY),
).pipe(
	Effect.map((raw) => Option.flatMap(Option.fromNullishOr(raw), Schema.decodeUnknownOption(OrgId))),
	Effect.orElseSucceed(() => Option.none<OrgId>()),
)

export const writeLastOrg = (orgId: string): Effect.Effect<void> =>
	Effect.sync(() => localStorage.setItem(LAST_ORG_KEY, orgId)).pipe(Effect.ignore)
