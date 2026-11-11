import { UnauthorizedError } from "@maple/domain/http"
import { Context, Effect, Layer, Option, Schema, Array as Arr, String as Str } from "effect"
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
}

export interface OidcCodeExchange {
	readonly code: string
	readonly codeVerifier: string
	readonly redirectUri: string
}

export interface OidcClientApi {
	readonly exchange: (input: OidcCodeExchange) => Effect.Effect<OidcIdentity, UnauthorizedError>
}

const TokenResponse = Schema.Struct({ id_token: Schema.String, access_token: Schema.String })

const IdTokenClaims = Schema.Struct({
	sub: Schema.String,
	email: Schema.optionalKey(Schema.String),
	email_verified: Schema.optionalKey(Schema.Boolean),
	name: Schema.optionalKey(Schema.String),
})

const AccessTokenClaims = Schema.Struct({
	realm_access: Schema.optionalKey(
		Schema.Struct({ roles: Schema.optionalKey(Schema.Array(Schema.String)) }),
	),
	roles: Schema.optionalKey(Schema.Array(Schema.String)),
})

const EXCHANGE_TIMEOUT = "10 seconds"

const unauthorized = (message: string) => new UnauthorizedError({ message })

/**
 * The JWT payload, undecoded by signature: these tokens come straight from the token endpoint over
 * a connection Maple opened itself, which OIDC Core §3.1.3.7 accepts in place of verification.
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

/** Trades an authorization code (public client + PKCE) at `MAPLE_OIDC_TOKEN_URL` for the signed-in identity. */
export class OidcClient extends Context.Service<OidcClient, OidcClientApi>()(
	"@maple/backend/services/OidcClient",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const httpClient = yield* HttpClient.HttpClient

			const exchange = Effect.fn("OidcClient.exchange")(function* (input: OidcCodeExchange) {
				if (Option.isNone(env.MAPLE_OIDC_TOKEN_URL) || Option.isNone(env.MAPLE_OIDC_CLIENT_ID)) {
					return yield* unauthorized("OIDC sign-in is not configured")
				}
				const request = HttpClientRequest.post(env.MAPLE_OIDC_TOKEN_URL.value, {
					headers: { accept: "application/json" },
				}).pipe(
					HttpClientRequest.bodyUrlParams({
						grant_type: "authorization_code",
						code: input.code,
						code_verifier: input.codeVerifier,
						redirect_uri: input.redirectUri,
						client_id: env.MAPLE_OIDC_CLIENT_ID.value,
					}),
				)
				const { status, text } = yield* Effect.gen(function* () {
					const response = yield* httpClient.execute(request)
					return { status: response.status, text: yield* response.text }
				}).pipe(
					Effect.timeout(EXCHANGE_TIMEOUT),
					Effect.mapError(() => unauthorized("The identity provider could not be reached")),
				)
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
				return {
					sub: idClaims.sub,
					email: Str.toLowerCase(Str.trim(idClaims.email ?? "")),
					emailVerified: idClaims.email_verified === true,
					name: idClaims.name ?? null,
					roles: Arr.dedupe([
						...(accessClaims.realm_access?.roles ?? []),
						...(accessClaims.roles ?? []),
					]),
				} satisfies OidcIdentity
			})

			return { exchange } satisfies OidcClientApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
