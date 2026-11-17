import { UnauthorizedError } from "@maple/domain/http"
import { Clock, Context, type Duration, Effect, Layer, Option, Schema, Array as Arr, String as Str } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { Env } from "@maple/backend/platform/Env"

/** Who the IdP says signed in. */
export interface OidcIdentity {
	readonly sub: string
	readonly email: string
	readonly emailVerified: boolean
	readonly name: string | null
	/** Realm roles plus any top-level `roles` claim of the access token. */
	readonly roles: ReadonlyArray<string>
	/** Kept (sealed) per session so renewal can ask the IdP whether the sign-in still stands. */
	readonly refreshToken?: string
	/** The IdP's session id (ID token `sid`). */
	readonly sid?: string
}

export interface OidcCodeExchange {
	readonly code: string
	readonly codeVerifier: string
	readonly redirectUri: string
}

/** What a refresh at the IdP says now. */
export interface OidcRefreshed {
	/** The rotated refresh token; absent when the IdP kept the old one. */
	readonly refreshToken: string | undefined
	readonly roles: ReadonlyArray<string>
}

/** The IdP refused the refresh token (`invalid_grant`, any 4xx): the sign-in is over. */
export class OidcRefreshRejectedError extends Schema.TaggedError<OidcRefreshRejectedError>()(
	"@maple/backend/errors/OidcRefreshRejectedError",
	{ message: Schema.String },
) {}

/** The IdP could not answer (transport error, timeout, 5xx): nothing is known either way. */
export class OidcUnavailableError extends Schema.TaggedError<OidcUnavailableError>()(
	"@maple/backend/errors/OidcUnavailableError",
	{ message: Schema.String },
) {}

export interface OidcClientApi {
	readonly exchange: (input: OidcCodeExchange) => Effect.Effect<OidcIdentity, UnauthorizedError>
	readonly refresh: (
		refreshToken: string,
	) => Effect.Effect<OidcRefreshed, OidcRefreshRejectedError | OidcUnavailableError>
	/** Ends the IdP session behind `refreshToken`. Best effort: never fails, only logs. */
	readonly logout: (refreshToken: string) => Effect.Effect<void>
}

const TokenResponse = Schema.Struct({
	id_token: Schema.String,
	access_token: Schema.String,
	refresh_token: Schema.optionalKey(Schema.String),
})

const RefreshResponse = Schema.Struct({
	access_token: Schema.String,
	refresh_token: Schema.optionalKey(Schema.String),
})

const IdTokenClaims = Schema.Struct({
	sub: Schema.String,
	email: Schema.optionalKey(Schema.String),
	email_verified: Schema.optionalKey(Schema.Boolean),
	name: Schema.optionalKey(Schema.String),
	iss: Schema.optionalKey(Schema.String),
	aud: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
	azp: Schema.optionalKey(Schema.String),
	exp: Schema.optionalKey(Schema.Number),
	sid: Schema.optionalKey(Schema.String),
})

const AccessTokenClaims = Schema.Struct({
	realm_access: Schema.optionalKey(
		Schema.Struct({ roles: Schema.optionalKey(Schema.Array(Schema.String)) }),
	),
	roles: Schema.optionalKey(Schema.Array(Schema.String)),
})

const EXCHANGE_TIMEOUT = "10 seconds"
// Renewal holds a row lock while it waits, and logout must not stall the sign-out.
const REFRESH_TIMEOUT = "5 seconds"
const LOGOUT_TIMEOUT = "3 seconds"

const unauthorized = (message: string) => new UnauthorizedError({ message })

const withoutTrailingSlash = Str.replace(/\/+$/, "")

/**
 * The JWT payload, undecoded by signature: these tokens come straight from the token endpoint over
 * a connection Maple opened itself, which OIDC Core §3.1.3.7 accepts in place of verification.
 * `iss`, `aud`/`azp` and `exp` are still checked, since that connection may be plain HTTP.
 */
const jwtPayload = <S extends Schema.Top>(schema: S, jwt: string) =>
	Effect.suspend(() => {
		const payload = Str.split(".")(jwt)[1]
		return payload === undefined
			? Effect.fail(unauthorized("Malformed token from the identity provider"))
			: Schema.decodeEffect(Schema.fromJsonString(schema))(
					Buffer.from(payload, "base64url").toString("utf8"),
				).pipe(Effect.mapError(() => unauthorized("Malformed token from the identity provider")))
	})

const rolesOf = (claims: typeof AccessTokenClaims.Type) =>
	Arr.dedupe([...(claims.realm_access?.roles ?? []), ...(claims.roles ?? [])])

/** Trades an authorization code (public client + PKCE) at `MAPLE_OIDC_TOKEN_URL` for the signed-in identity. */
export class OidcClient extends Context.Service<OidcClient, OidcClientApi>()(
	"@maple/backend/services/OidcClient",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const httpClient = yield* HttpClient.HttpClient

			const post = (url: string, params: Record<string, string>, timeout: Duration.Input) =>
				Effect.gen(function* () {
					const response = yield* httpClient.execute(
						HttpClientRequest.post(url, { headers: { accept: "application/json" } }).pipe(
							HttpClientRequest.bodyUrlParams(params),
						),
					)
					return { status: response.status, text: yield* response.text }
				}).pipe(Effect.timeout(timeout))

			const exchange = Effect.fn("OidcClient.exchange")(function* (input: OidcCodeExchange) {
				if (Option.isNone(env.MAPLE_OIDC_TOKEN_URL) || Option.isNone(env.MAPLE_OIDC_CLIENT_ID)) {
					return yield* unauthorized("OIDC sign-in is not configured")
				}
				const clientId = env.MAPLE_OIDC_CLIENT_ID.value
				const { status, text } = yield* post(
					env.MAPLE_OIDC_TOKEN_URL.value,
					{
						grant_type: "authorization_code",
						code: input.code,
						code_verifier: input.codeVerifier,
						redirect_uri: input.redirectUri,
						client_id: clientId,
					},
					EXCHANGE_TIMEOUT,
				).pipe(Effect.mapError(() => unauthorized("The identity provider could not be reached")))
				if (status < 200 || status >= 300) {
					// The body names the reason (expired code, PKCE mismatch); keep it in the logs only.
					yield* Effect.logWarning("OIDC code exchange rejected").pipe(
						Effect.annotateLogs({ status, body: Str.slice(0, 500)(text) }),
					)
					return yield* unauthorized("The identity provider rejected the sign-in")
				}
				const tokens = yield* Schema.decodeEffect(Schema.fromJsonString(TokenResponse))(text).pipe(
					Effect.mapError(() =>
						unauthorized("Malformed token response from the identity provider"),
					),
				)
				const idClaims = yield* jwtPayload(IdTokenClaims, tokens.id_token)
				const accessClaims = yield* jwtPayload(AccessTokenClaims, tokens.access_token)

				// OIDC Core §3.1.3.7: the token is for this client, from the configured issuer, unexpired.
				const issuer = Option.map(env.MAPLE_OIDC_ISSUER, withoutTrailingSlash)
				if (
					Option.isSome(issuer) &&
					withoutTrailingSlash(idClaims.iss ?? "") !== issuer.value
				) {
					return yield* unauthorized("The ID token was issued by an unexpected identity provider")
				}
				const audiences = idClaims.aud === undefined ? [] : Arr.ensure(idClaims.aud)
				if (!audiences.includes(clientId)) {
					return yield* unauthorized("The ID token was not issued for this client")
				}
				const needsAzp = audiences.length > 1
				if ((needsAzp || idClaims.azp !== undefined) && idClaims.azp !== clientId) {
					return yield* unauthorized("The ID token was not issued for this client")
				}
				const nowSeconds = Math.floor((yield* Clock.currentTimeMillis) / 1000)
				if (idClaims.exp === undefined || nowSeconds >= idClaims.exp) {
					return yield* unauthorized("The ID token has expired")
				}

				const base = {
					sub: idClaims.sub,
					email: Str.toLowerCase(Str.trim(idClaims.email ?? "")),
					emailVerified: idClaims.email_verified === true,
					name: idClaims.name ?? null,
					roles: rolesOf(accessClaims),
				} satisfies OidcIdentity
				const withRefresh: OidcIdentity =
					tokens.refresh_token === undefined ? base : { ...base, refreshToken: tokens.refresh_token }
				return idClaims.sid === undefined ? withRefresh : { ...withRefresh, sid: idClaims.sid }
			})

			const refresh = Effect.fn("OidcClient.refresh")(function* (refreshToken: string) {
				if (Option.isNone(env.MAPLE_OIDC_TOKEN_URL) || Option.isNone(env.MAPLE_OIDC_CLIENT_ID)) {
					return yield* new OidcUnavailableError({ message: "OIDC sign-in is not configured" })
				}
				const { status, text } = yield* post(
					env.MAPLE_OIDC_TOKEN_URL.value,
					{
						grant_type: "refresh_token",
						refresh_token: refreshToken,
						client_id: env.MAPLE_OIDC_CLIENT_ID.value,
					},
					REFRESH_TIMEOUT,
				).pipe(
					Effect.mapError(
						() => new OidcUnavailableError({ message: "The identity provider could not be reached" }),
					),
				)
				// 408/429 and 5xx say "ask again later", not "this sign-in is over".
				if (status >= 500 || status === 408 || status === 429) {
					return yield* new OidcUnavailableError({
						message: `The identity provider answered ${status}`,
					})
				}
				if (status < 200 || status >= 300) {
					yield* Effect.logInfo("OIDC refresh rejected").pipe(
						Effect.annotateLogs({ status, body: Str.slice(0, 500)(text) }),
					)
					return yield* new OidcRefreshRejectedError({
						message: "The identity provider ended this sign-in",
					})
				}
				const tokens = yield* Schema.decodeEffect(Schema.fromJsonString(RefreshResponse))(text).pipe(
					Effect.mapError(
						() => new OidcUnavailableError({ message: "Malformed refresh response" }),
					),
				)
				const accessClaims = yield* jwtPayload(AccessTokenClaims, tokens.access_token).pipe(
					Effect.mapError(
						() => new OidcUnavailableError({ message: "Malformed refreshed access token" }),
					),
				)
				return { refreshToken: tokens.refresh_token, roles: rolesOf(accessClaims) } satisfies OidcRefreshed
			})

			const logout = Effect.fn("OidcClient.logout")(function* (refreshToken: string) {
				if (Option.isNone(env.MAPLE_OIDC_LOGOUT_URL) || Option.isNone(env.MAPLE_OIDC_CLIENT_ID)) return
				// A public client ends its IdP session with its own refresh token; no id_token_hint or redirect.
				yield* post(
					env.MAPLE_OIDC_LOGOUT_URL.value,
					{ client_id: env.MAPLE_OIDC_CLIENT_ID.value, refresh_token: refreshToken },
					LOGOUT_TIMEOUT,
				).pipe(
					Effect.flatMap(({ status, text }) =>
						status >= 200 && status < 300
							? Effect.void
							: Effect.logWarning("OIDC logout rejected").pipe(
									Effect.annotateLogs({ status, body: Str.slice(0, 500)(text) }),
								),
					),
					Effect.catch(() => Effect.logWarning("OIDC logout could not reach the identity provider")),
				)
			})

			return { exchange, refresh, logout } satisfies OidcClientApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
