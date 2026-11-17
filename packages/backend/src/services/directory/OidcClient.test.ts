import { assert, describe, it } from "@effect/vitest"
import { UnauthorizedError } from "@maple/domain/http"
import { ConfigProvider, Effect, Exit, Layer, Option } from "effect"
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http"
import { TestClock } from "effect/testing"
import { Env } from "@maple/backend/platform/Env"
import { OidcClient, OidcRefreshRejectedError, OidcUnavailableError } from "./OidcClient"

const NOW_SECONDS = 1_800_000_000
const ISSUER = "https://auth.example.test/realms/maple"
const CLIENT_ID = "maple-web"

const jwt = (claims: Record<string, unknown>) =>
	`e30.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`

const goodIdClaims = {
	sub: "alice-sub",
	email: "Alice@Example.test",
	email_verified: true,
	iss: ISSUER,
	aud: CLIENT_ID,
	azp: CLIENT_ID,
	exp: NOW_SECONDS + 300,
	sid: "kc-session-1",
}

/** A token endpoint that answers every request with one canned response, and records the form bodies. */
const tokenEndpoint = (respond: () => Response, bodies: Array<string>) =>
	Layer.succeed(
		HttpClient.HttpClient,
		HttpClient.make((request: HttpClientRequest.HttpClientRequest) =>
			Effect.sync(() => {
				bodies.push(request.body._tag === "Uint8Array" ? Buffer.from(request.body.body).toString() : "")
				return HttpClientResponse.fromWeb(request, respond())
			}),
		),
	)

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

const clientWith = (respond: () => Response, bodies: Array<string> = []) =>
	Layer.effect(OidcClient, OidcClient.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				tokenEndpoint(respond, bodies),
				Env.layer.pipe(
					Layer.provide(
						ConfigProvider.layer(
							ConfigProvider.fromUnknown({
								TINYBIRD_HOST: "https://api.tinybird.co",
								TINYBIRD_TOKEN: "test-token",
								MAPLE_ROOT_PASSWORD: "test-root-password",
								MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
								MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "lookup-key",
								MAPLE_OIDC_TOKEN_URL: "http://keycloak:8080/realms/maple/protocol/openid-connect/token",
								MAPLE_OIDC_CLIENT_ID: CLIENT_ID,
								MAPLE_OIDC_ISSUER: `${ISSUER}/`,
								MAPLE_OIDC_LOGOUT_URL: "http://keycloak:8080/realms/maple/protocol/openid-connect/logout",
							}),
						),
					),
				),
			),
		),
	)

const exchangeWith = (idClaims: Record<string, unknown>) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW_SECONDS * 1000)
		const oidc = yield* OidcClient
		return yield* Effect.exit(
			oidc.exchange({ code: "code", codeVerifier: "verifier", redirectUri: "https://app.test/sign-in" }),
		)
	}).pipe(
		Effect.provide(
			clientWith(() =>
				json({
					id_token: jwt(idClaims),
					access_token: jwt({ realm_access: { roles: ["maple-root"] } }),
					refresh_token: "rt-1",
				}),
			),
		),
	)

const failureOf = <A, E>(exit: Exit.Exit<A, E>) => Option.getOrUndefined(Exit.findErrorOption(exit))

describe("OidcClient.exchange", () => {
	it.effect("returns the identity, its refresh token and the IdP session id", () =>
		Effect.gen(function* () {
			const exit = yield* exchangeWith(goodIdClaims)
			assert.isTrue(Exit.isSuccess(exit))
			if (Exit.isSuccess(exit)) {
				assert.deepStrictEqual(exit.value, {
					sub: "alice-sub",
					email: "alice@example.test",
					emailVerified: true,
					name: null,
					roles: ["maple-root"],
					refreshToken: "rt-1",
					sid: "kc-session-1",
				})
			}
		}),
	)

	it.effect.each([
		["another issuer", { iss: "https://evil.test/realms/maple" }],
		["no issuer", { iss: undefined }],
		["another audience", { aud: "other-client", azp: undefined }],
		["another authorized party", { azp: "other-client" }],
		["several audiences without azp", { aud: [CLIENT_ID, "other"], azp: undefined }],
		["an expired token", { exp: NOW_SECONDS }],
		["no expiry", { exp: undefined }],
	] as const)("refuses an ID token with %s", ([, overrides]) =>
		Effect.gen(function* () {
			const exit = yield* exchangeWith({ ...goodIdClaims, ...overrides })
			assert.instanceOf(failureOf(exit), UnauthorizedError)
		}),
	)
})

describe("OidcClient.refresh", () => {
	const refreshWith = (respond: () => Response, bodies: Array<string> = []) =>
		Effect.flatMap(OidcClient, (oidc) => Effect.exit(oidc.refresh("rt-1"))).pipe(
			Effect.provide(clientWith(respond, bodies)),
		)

	it.effect("returns the rotated token and the roles the IdP grants now", () =>
		Effect.gen(function* () {
			const bodies: Array<string> = []
			const exit = yield* refreshWith(
				() => json({ access_token: jwt({ realm_access: { roles: ["user"] } }), refresh_token: "rt-2" }),
				bodies,
			)
			assert.isTrue(Exit.isSuccess(exit))
			if (Exit.isSuccess(exit)) assert.deepStrictEqual(exit.value, { refreshToken: "rt-2", roles: ["user"] })
			assert.deepStrictEqual(bodies, ["grant_type=refresh_token&refresh_token=rt-1&client_id=maple-web"])
		}),
	)

	it.effect("reads invalid_grant as the end of the sign-in", () =>
		Effect.gen(function* () {
			const exit = yield* refreshWith(() => json({ error: "invalid_grant" }, 400))
			assert.instanceOf(failureOf(exit), OidcRefreshRejectedError)
		}),
	)

	it.effect.each([502, 503, 429])("reads %s as the IdP being unavailable", (status) =>
		Effect.gen(function* () {
			const exit = yield* refreshWith(() => json({ error: "temporarily_unavailable" }, status))
			assert.instanceOf(failureOf(exit), OidcUnavailableError)
		}),
	)
})

describe("OidcClient.logout", () => {
	it.effect("posts the client id and refresh token, and swallows an IdP failure", () =>
		Effect.gen(function* () {
			const bodies: Array<string> = []
			yield* Effect.flatMap(OidcClient, (oidc) => oidc.logout("rt-1")).pipe(
				Effect.provide(clientWith(() => new Response("down", { status: 503 }), bodies)),
			)
			assert.deepStrictEqual(bodies, ["client_id=maple-web&refresh_token=rt-1"])
		}),
	)
})
