/**
 * IT-only verification actions against the IdP: resend Keycloak's verify-email mail, mark an address
 * verified, and list the users still unverified.
 *
 * The list comes from Keycloak, not Maple's DB: an unverified user cannot finish the Keycloak login,
 * so Maple's callback never creates their `directory_users` row. Unverified Maple rows Keycloak did
 * not return (e.g. federated IdPs) are merged in.
 *
 * Calls the Keycloak Admin REST API (`MAPLE_OIDC_ADMIN_URL`) as the confidential service-account
 * client `maple-admin` (client-credentials at `MAPLE_OIDC_TOKEN_URL`). `deploy/docker/scripts/bootstrap.sh`
 * grants it only `realm-management` `view-users` + `manage-users`. Risk: `manage-users` can also
 * assign realm roles, so a compromised API can grant `maple-root` and escalate to IT. Keep the
 * secret out of logs and keep these endpoints root-only.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import { DirectoryUsers } from "@maple/db/tables"
import {
	DirectoryDisabledError,
	DirectoryForbiddenError,
	DirectoryNotFoundError,
	DirectoryOkResponse,
	DirectoryPersistenceError,
	DirectoryUpstreamError,
	type TenantContext,
	UnverifiedUser,
	UnverifiedUsersResponse,
	UserId,
} from "@maple/domain/http"
import {
	Clock,
	Context,
	Effect,
	Layer,
	Option,
	Order,
	Redacted,
	Ref,
	Schema,
	Array as Arr,
	String as Str,
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"

const ADMIN_TIMEOUT = "10 seconds"
/** A cached service-account token is replaced this long before it expires. */
const TOKEN_EXPIRY_MARGIN_MS = 30_000
const VERIFY_EMAIL = "VERIFY_EMAIL"

const TokenResponse = Schema.Struct({ access_token: Schema.String, expires_in: Schema.Number })
// A Record, not a Struct: the PUT sends the whole representation back, so no field may be dropped.
const UserRepresentation = Schema.Record(Schema.String, Schema.Unknown)
const UserSummaries = Schema.Array(
	Schema.Struct({
		id: UserId,
		username: Schema.optionalKey(Schema.String),
		email: Schema.optionalKey(Schema.String),
		firstName: Schema.optionalKey(Schema.String),
		lastName: Schema.optionalKey(Schema.String),
		createdTimestamp: Schema.optionalKey(Schema.Number),
	}),
)
/** Keycloak's own service-account users (e.g. `maple-admin`'s); never people to verify. */
const SERVICE_ACCOUNT_PREFIX = "service-account-"
// shortcut: one page of 200 unverified users; page with `first` if a realm ever has more pending.
const UNVERIFIED_PAGE_SIZE = "200"

const upstream = (message: string) => new DirectoryUpstreamError({ message })

interface CachedToken {
	readonly token: Redacted.Redacted
	readonly expiresAtMs: number
}

export class KeycloakAdmin extends Context.Service<KeycloakAdmin>()("@maple/backend/services/KeycloakAdmin", {
	make: Effect.gen(function* () {
		const env = yield* Env
		const database = yield* Database
		const httpClient = yield* HttpClient.HttpClient
		const dbExecute = makeDbExecute(
			database,
			"KeycloakAdmin",
			(error) => new DirectoryPersistenceError({ message: error.message }),
		)
		const cache = yield* Ref.make(Option.none<CachedToken>())

		const isRoot = (roles: ReadonlyArray<string>) => roles.includes("root")
		const requireRoot = (tenant: TenantContext) =>
			isRoot(tenant.roles)
				? Effect.void
				: Effect.fail(new DirectoryForbiddenError({ message: "Only IT administrators can do this" }))

		const config = Effect.suspend(() => {
			const {
				MAPLE_OIDC_ADMIN_URL,
				MAPLE_OIDC_ADMIN_CLIENT_SECRET,
				MAPLE_OIDC_TOKEN_URL,
				MAPLE_OIDC_CLIENT_ID,
			} = env
			return Option.isSome(MAPLE_OIDC_ADMIN_URL) &&
				Option.isSome(MAPLE_OIDC_ADMIN_CLIENT_SECRET) &&
				Option.isSome(MAPLE_OIDC_TOKEN_URL) &&
				Option.isSome(MAPLE_OIDC_CLIENT_ID)
				? Effect.succeed({
						adminUrl: Str.replace(/\/+$/, "")(MAPLE_OIDC_ADMIN_URL.value),
						secret: MAPLE_OIDC_ADMIN_CLIENT_SECRET.value,
						tokenUrl: MAPLE_OIDC_TOKEN_URL.value,
						webClientId: MAPLE_OIDC_CLIENT_ID.value,
					})
				: Effect.fail(
						new DirectoryDisabledError({
							message: "The identity provider's admin API is not configured on this deployment",
						}),
					)
		})
		type Config = Effect.Success<typeof config>

		/** Status and body of one call; transport failures and timeouts become an upstream error. */
		const send = (request: HttpClientRequest.HttpClientRequest, what: string) =>
			Effect.gen(function* () {
				const response = yield* httpClient.execute(request)
				return { status: response.status, text: yield* response.text }
			}).pipe(
				Effect.timeout(ADMIN_TIMEOUT),
				Effect.mapError(() => upstream(`The identity provider could not be reached (${what})`)),
			)

		const fetchToken = (cfg: Config) =>
			Effect.gen(function* () {
				const { status, text } = yield* send(
					HttpClientRequest.post(cfg.tokenUrl, { headers: { accept: "application/json" } }).pipe(
						HttpClientRequest.bodyUrlParams({
							grant_type: "client_credentials",
							client_id: env.MAPLE_OIDC_ADMIN_CLIENT_ID,
							client_secret: cfg.secret,
						}),
					),
					"token",
				)
				if (status < 200 || status >= 300) {
					// Status only: the body of a failed client-credentials grant is not worth the risk of logging.
					yield* Effect.logWarning("IdP admin token request rejected").pipe(
						Effect.annotateLogs({ status }),
					)
					return yield* upstream("The identity provider rejected Maple's admin credentials")
				}
				const tokens = yield* Schema.decodeEffect(Schema.fromJsonString(TokenResponse))(text).pipe(
					Effect.mapError(() => upstream("Malformed token response from the identity provider")),
				)
				const now = yield* Clock.currentTimeMillis
				const fresh = {
					token: Redacted.make(tokens.access_token),
					expiresAtMs: now + tokens.expires_in * 1000 - TOKEN_EXPIRY_MARGIN_MS,
				}
				yield* Ref.set(cache, Option.some(fresh))
				return fresh.token
			})

		// shortcut: a token revoked before its expiry fails calls until it ages out; add a 401 retry if that bites.
		const accessToken = (cfg: Config) =>
			Effect.gen(function* () {
				const cached = yield* Ref.get(cache)
				const now = yield* Clock.currentTimeMillis
				return Option.isSome(cached) && now < cached.value.expiresAtMs
					? cached.value.token
					: yield* fetchToken(cfg)
			})

		/** One authenticated admin call; 404 → not found, any other non-2xx → upstream. */
		const admin = (cfg: Config, request: HttpClientRequest.HttpClientRequest, what: string) =>
			Effect.gen(function* () {
				const token = yield* accessToken(cfg)
				const { status, text } = yield* send(HttpClientRequest.bearerToken(request, token), what)
				if (status === 404) return yield* new DirectoryNotFoundError({ message: "No such user" })
				if (status < 200 || status >= 300) {
					yield* Effect.logWarning("IdP admin call failed").pipe(
						Effect.annotateLogs({ what, status }),
					)
					return yield* upstream(`The identity provider refused the request (${what}, ${status})`)
				}
				return text
			})

		const userUrl = (cfg: Config, userId: UserId) => `${cfg.adminUrl}/users/${encodeURIComponent(userId)}`

		const listUnverified = Effect.fn("KeycloakAdmin.listUnverified")(function* (tenant: TenantContext) {
			yield* requireRoot(tenant)
			const cfg = yield* config
			const text = yield* admin(
				cfg,
				HttpClientRequest.get(`${cfg.adminUrl}/users`).pipe(
					HttpClientRequest.setUrlParams({ emailVerified: "false", max: UNVERIFIED_PAGE_SIZE }),
				),
				"list-users",
			)
			const summaries = yield* Schema.decodeEffect(Schema.fromJsonString(UserSummaries))(text).pipe(
				Effect.mapError(() => upstream("Malformed user list from the identity provider")),
			)
			const people = Arr.filter(
				summaries,
				(user) =>
					user.email !== undefined &&
					!Str.isEmpty(Str.trim(user.email)) &&
					!Str.startsWith(SERVICE_ACCOUNT_PREFIX)(user.username ?? ""),
			)
			const fromIdp = Arr.map(
				people,
				(user) =>
					new UnverifiedUser({
						id: user.id,
						email: user.email ?? "",
						name: Str.trim(`${user.firstName ?? ""} ${user.lastName ?? ""}`) || null,
						createdAt: user.createdTimestamp ?? 0,
					}),
			)
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(DirectoryUsers)
						.select()
						.where(($) => [$.emailVerified.eq(false)]),
				),
			)
			const fromMaple = Arr.map(
				Arr.filter(rows, (row) => !Arr.some(fromIdp, (user) => user.id === row.id)),
				(row) =>
					new UnverifiedUser({
						id: row.id,
						email: row.email,
						name: row.name,
						createdAt: row.createdAt,
					}),
			)
			return new UnverifiedUsersResponse({
				users: Arr.sort(
					[...fromIdp, ...fromMaple],
					Order.mapInput(Order.Number, (user: UnverifiedUser) => user.createdAt),
				),
			})
		})

		const resendVerification = Effect.fn("KeycloakAdmin.resendVerification")(function* (
			tenant: TenantContext,
			userId: UserId,
		) {
			yield* requireRoot(tenant)
			const cfg = yield* config
			yield* admin(
				cfg,
				HttpClientRequest.put(`${userUrl(cfg, userId)}/send-verify-email`).pipe(
					HttpClientRequest.setUrlParams({
						client_id: cfg.webClientId,
						redirect_uri: `${env.MAPLE_APP_BASE_URL}/sign-in`,
					}),
				),
				"send-verify-email",
			)
			return new DirectoryOkResponse({ ok: true })
		})

		/** Verified in the IdP first, then in Maple, so the next sign-in accepts the user's invitations. */
		const markVerified = Effect.fn("KeycloakAdmin.markVerified")(function* (
			tenant: TenantContext,
			userId: UserId,
		) {
			yield* requireRoot(tenant)
			const cfg = yield* config
			const text = yield* admin(cfg, HttpClientRequest.get(userUrl(cfg, userId)), "get-user")
			const user = yield* Schema.decodeEffect(Schema.fromJsonString(UserRepresentation))(text).pipe(
				Effect.mapError(() => upstream("Malformed user from the identity provider")),
			)
			const requiredActions = Arr.isArray(user.requiredActions)
				? Arr.filter(user.requiredActions, (action) => action !== VERIFY_EMAIL)
				: []
			yield* admin(
				cfg,
				HttpClientRequest.put(userUrl(cfg, userId)).pipe(
					HttpClientRequest.bodyJsonUnsafe({ ...user, emailVerified: true, requiredActions }),
				),
				"update-user",
			)
			// Updates zero rows for a user who never finished a sign-in; that is fine.
			yield* dbExecute((db) =>
				db.run(
					PG.update(DirectoryUsers)
						.set({ emailVerified: true })
						.where(($) => [$.id.eq(userId)]),
				),
			)
			return new DirectoryOkResponse({ ok: true })
		})

		return { listUnverified, resendVerification, markVerified }
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
