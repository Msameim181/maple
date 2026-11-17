import { randomUUID } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb } from "@maple/db/client"
import {
	DirectoryInvitations,
	DirectoryMembers,
	DirectoryOrgs,
	DirectorySessions,
	DirectoryUsers,
} from "@maple/db/tables"
import type { DirectorySessionRow, DirectoryUserRow } from "@maple/db/tables"
import {
	type AssignableRoleKey,
	DIRECTORY_ORG_ID_PATTERN,
	CreateOrgRequest,
	DirectoryConflictError,
	DirectoryDisabledError,
	DirectoryEmailNotVerifiedError,
	DirectoryForbiddenError,
	DirectoryInvitation,
	DirectoryMember,
	DirectoryNotFoundError,
	DirectoryOkResponse,
	DirectoryOrg,
	DirectoryPersistenceError,
	DirectoryUser,
	DirectoryUserOrg,
	DirectoryUserRow as DirectoryUserListRow,
	DirectoryValidationError,
	MeOrg,
	MeResponse,
	MembersResponse,
	NoOrganizationError,
	OidcCallbackRequest,
	OidcConfigResponse,
	OrgId,
	OrgsResponse,
	RoleName,
	SelfHostedLoginResponse,
	SelfHostedSession,
	SelfHostedSessionOkResponse,
	SelfHostedSessionPersistenceError,
	SelfHostedSessionsResponse,
	type TenantContext,
	UnauthorizedError,
	UserId,
	UsersResponse,
} from "@maple/domain/http"
import {
	mintSessionToken,
	type RenewSelfHostedSession,
	SELF_HOSTED_SESSION_MAX_LIFETIME_SECONDS,
	SELF_HOSTED_SESSION_TTL_SECONDS,
	sessionSigningSecret,
	verifySelfHostedSessionToken,
} from "@maple/auth"
import {
	Clock,
	Context,
	Effect,
	Layer,
	Option,
	Redacted,
	Result,
	Schema,
	Array as Arr,
	String as Str,
} from "effect"
import { Database, type DatabaseApi } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import {
	openSecret,
	sealSecret,
	type SecretKeyring,
	secretKeyringFromEnv,
} from "@maple/backend/platform/SecretBox"
import { directorySessionRefreshTokenSlot } from "@maple/backend/platform/secret-slots"
import { MembershipRevocationService } from "@maple/backend/services/auth/MembershipRevocationService"
import { renderInvitation } from "@maple/email/invitation"
import { EmailService } from "@maple/backend/platform/EmailService"
import { Env, type EnvConfig } from "@maple/backend/platform/Env"
import { OidcClient, type OidcClientApi } from "./OidcClient"
import { OrgProvisioner } from "./OrgProvisioner"
import { activeMembership, activeOrg, oidcEnabled } from "./live-access"

/*
 * OIDC session lifetimes come from the env: `MAPLE_OIDC_SESSION_TTL_SECONDS` (one token) and
 * `MAPLE_OIDC_SESSION_MAX_LIFETIME_SECONDS` (one sign-in). Logout and an IdP-side sign-out stop
 * renewal at once, but Workers verify tokens statelessly, so an unexpired token keeps working
 * there until its `exp`: the TTL is the longest a logged-out token survives.
 */

/** Renewal within this many seconds of the last IdP refresh trusts it instead of asking again. */
const IDP_REFRESH_INTERVAL_MS = 30_000
/** Revoked session rows are kept this long (the sessions list ignores them), then deleted. */
const REVOKED_SESSION_RETENTION_MS = 24 * 60 * 60 * 1000

/** The root-password operator's subject. It has no directory row and keeps upstream renewal. */
const ROOT_PASSWORD_USER = "root"

const asRole = Schema.decodeUnknownSync(RoleName)
const ROOT_ROLE = asRole("root")
const isRoot = (roles: ReadonlyArray<string>) => roles.includes("root")

export { oidcEnabled }

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/
const normalizeEmail = (email: string) => Str.toLowerCase(Str.trim(email))

/** The refresh token a session row holds, when the IdP issued one. */
const storedRefreshToken = (row: DirectorySessionRow) =>
	row.refreshTokenCiphertext === null || row.refreshTokenIv === null || row.refreshTokenTag === null
		? undefined
		: { ciphertext: row.refreshTokenCiphertext, iv: row.refreshTokenIv, tag: row.refreshTokenTag }

/** The session row behind a token: present, the token's own, not revoked and not past its end. */
const liveSession = (db: MapleDb, sid: string, userId: UserId, nowMs: number, lock: boolean) =>
	Effect.gen(function* () {
		const query = PG.from(DirectorySessions)
			.select()
			.where(($) => [$.id.eq(sid), $.userId.eq(userId)])
			.limit(1)
		const [row] = yield* db.run(lock ? query.forUpdate() : query)
		if (row === undefined) return Result.fail("No such session")
		if (row.revokedAt !== null) return Result.fail("This session was signed out")
		if (row.expiresAt <= nowMs) return Result.fail("This session has expired")
		return Result.succeed(row)
	})

export interface DirectoryRenewalDeps {
	readonly env: Pick<EnvConfig, "MAPLE_OIDC_ROOT_ROLE" | "MAPLE_OIDC_SESSION_TTL_SECONDS">
	readonly database: Option.Option<DatabaseApi>
	readonly oidc: OidcClientApi
	readonly keyring: Result.Result<SecretKeyring, string>
}

/** The roles a renewal grants, or why it is refused. */
type RenewalOutcome = Result.Result<ReadonlyArray<RoleName>, string>
const renewedAs = (roles: ReadonlyArray<RoleName>): RenewalOutcome => Result.succeed(roles)
const refused = (message: string): RenewalOutcome => Result.fail(message)

/** What renewal learned from the IdP. `Fresh` carries the roles the IdP grants right now. */
type IdpVerdict =
	| { readonly _tag: "Fresh"; readonly roles: ReadonlyArray<string> }
	| { readonly _tag: "Unknown" }
	| { readonly _tag: "Ended" }

/**
 * The renewal check `AuthService` runs when OIDC is on.
 *
 * - The root-password operator (`sub` "root") renews as before: the break-glass path.
 * - An OIDC token must name its session (`sid`); one minted before sessions existed is refused once.
 * - The session row is locked for the whole check, so two tabs renewing at once cannot both spend
 *   the IdP's single-use refresh token. Revoked or past its end: refused.
 * - At most every 30 s the IdP is asked to refresh. `invalid_grant` (the IdP session ended) revokes
 *   the row and refuses. An unreachable IdP is not a logout: renewal goes on with what is known.
 * - Root comes from the refreshed token's roles; without a fresh answer the token's own roles stand.
 *   Everyone else must still be a member of the token's org.
 */
export const makeDirectoryRenewal =
	(deps: DirectoryRenewalDeps): RenewSelfHostedSession =>
	(claims) => {
		if (claims.sub === ROOT_PASSWORD_USER) {
			return Effect.succeed({ roles: claims.roles, ttlSeconds: SELF_HOSTED_SESSION_TTL_SECONDS })
		}
		const refuse = (message: string) => new UnauthorizedError({ message })
		const sid = claims.sid
		if (sid === undefined) {
			return Effect.fail(refuse("This sign-in has no server-side session; sign in again"))
		}
		if (Option.isNone(deps.database) || Result.isFailure(deps.keyring)) {
			return Effect.fail(refuse("Session could not be checked"))
		}
		const database = deps.database.value
		const keyring = deps.keyring.success

		const askIdp = (db: MapleDb, row: DirectorySessionRow, nowMs: number) =>
			Effect.gen(function* () {
				const stored = storedRefreshToken(row)
				if (stored === undefined || nowMs - row.refreshedAt < IDP_REFRESH_INTERVAL_MS) {
					return { _tag: "Unknown" } satisfies IdpVerdict
				}
				const ref = { userId: row.userId, id: row.id }
				const refreshToken = yield* openSecret(keyring, directorySessionRefreshTokenSlot, ref, stored, (m) => m)
					.pipe(Effect.option)
				if (Option.isNone(refreshToken)) {
					yield* Effect.logError("Stored IdP refresh token could not be opened").pipe(
						Effect.annotateLogs({ sessionId: row.id }),
					)
					return { _tag: "Unknown" } satisfies IdpVerdict
				}
				const refreshed = yield* Effect.result(deps.oidc.refresh(refreshToken.value))
				if (Result.isFailure(refreshed)) {
					if (refreshed.failure._tag === "@maple/backend/errors/OidcRefreshRejectedError") {
						yield* db.run(
							PG.update(DirectorySessions)
								.set({ revokedAt: nowMs })
								.where(($) => [$.id.eq(row.id)]),
						)
						return { _tag: "Ended" } satisfies IdpVerdict
					}
					// An IdP outage must not sign everyone out; the next renewal asks again.
					yield* Effect.logWarning("IdP unavailable; renewing on directory membership only").pipe(
						Effect.annotateLogs({ sessionId: row.id, reason: refreshed.failure.message }),
					)
					return { _tag: "Unknown" } satisfies IdpVerdict
				}
				const rotated = refreshed.success.refreshToken
				const sealed =
					rotated === undefined
						? undefined
						: yield* sealSecret(keyring, directorySessionRefreshTokenSlot, ref, rotated, (m) =>
								refuse(m),
							)
				yield* db.run(
					PG.update(DirectorySessions)
						.set(
							sealed === undefined
								? { refreshedAt: nowMs }
								: {
										refreshedAt: nowMs,
										refreshTokenCiphertext: sealed.ciphertext,
										refreshTokenIv: sealed.iv,
										refreshTokenTag: sealed.tag,
									},
						)
						.where(($) => [$.id.eq(row.id)]),
				)
				return { _tag: "Fresh", roles: refreshed.success.roles } satisfies IdpVerdict
			})

		return database
			.execute((db) =>
				db.transaction(
					Effect.gen(function* () {
						const nowMs = yield* Clock.currentTimeMillis
						const session = yield* liveSession(db, sid, claims.sub, nowMs, true)
						if (Result.isFailure(session)) return refused(session.failure)
						const verdict: IdpVerdict = yield* askIdp(db, session.success, nowMs)
						// Committed, not rolled back: the revocation must stick.
						if (verdict._tag === "Ended") return refused("The identity provider ended this sign-in")
						const rootNow =
							verdict._tag === "Fresh"
								? verdict.roles.includes(deps.env.MAPLE_OIDC_ROOT_ROLE)
								: isRoot(claims.roles)
						if (rootNow) return renewedAs([ROOT_ROLE])
						const member = yield* activeMembership(db, claims.orgId, claims.sub)
						return Option.match(member, {
							onNone: () => refused("No longer a member of this organization"),
							onSome: (row) => renewedAs([asRole(row.role)]),
						})
					}),
				),
			)
			.pipe(
				Effect.mapError(() => refuse("Session could not be checked")),
				Effect.flatMap(
					Result.match({
						onFailure: (message) => Effect.fail(refuse(message)),
						onSuccess: (roles) =>
							Effect.succeed({ roles, ttlSeconds: deps.env.MAPLE_OIDC_SESSION_TTL_SECONDS }),
					}),
				),
			)
	}

const toDirectoryUser = (row: DirectoryUserRow | undefined, id: UserId) =>
	row === undefined
		? new DirectoryUser({
				id,
				email: "",
				name: id === ROOT_PASSWORD_USER ? "Root" : null,
				lastSeenAt: null,
				emailVerified: false,
			})
		: new DirectoryUser({
				id: row.id,
				email: row.email,
				name: row.name,
				lastSeenAt: row.lastSeenAt,
				emailVerified: row.emailVerified,
			})

const persistence = (error: { readonly message: string }) =>
	new DirectoryPersistenceError({ message: error.message })

export class DirectoryService extends Context.Service<DirectoryService>()(
	"@maple/backend/services/DirectoryService",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "DirectoryService", persistence)
			const oidc = yield* OidcClient
			const provisioner = yield* OrgProvisioner
			const email = yield* EmailService
			const revocation = yield* MembershipRevocationService
			const enabled = oidcEnabled(env)
			if (enabled && Option.isNone(env.MAPLE_SESSION_SECRET)) {
				// Once per service build (worker start). The fallback works, but the root password then
				// doubles as the key that signs every user's session.
				yield* Effect.logWarning(
					"MAPLE_SESSION_SECRET is not set: OIDC session tokens are signed with MAPLE_ROOT_PASSWORD. Set MAPLE_SESSION_SECRET (same value on every service) to separate them.",
				)
			}

			// Best effort: the invitation stands without it; the person can still sign up at the link.
			const sendInvitationEmail = (orgName: string, to: string) =>
				email.isConfigured
					? email
							.send(
								to,
								`You're invited to ${orgName} on Maple`,
								renderInvitation({
									orgName,
									recipient: to,
									signInUrl: `${env.MAPLE_APP_BASE_URL}/sign-in`,
								}),
							)
							.pipe(
								Effect.catch((error) =>
									Effect.logWarning("Invitation email not sent").pipe(
										Effect.annotateLogs({ error: error.message }),
									),
								),
							)
					: Effect.void

			const requireEnabled = Effect.suspend(() =>
				enabled
					? Effect.void
					: Effect.fail(
							new DirectoryDisabledError({
								message: "OIDC sign-in is not configured on this deployment",
							}),
						),
			)
			// Every Worker verifies with the same key (MAPLE_SESSION_SECRET, else the root password).
			const signingSecret = requireEnabled.pipe(
				Effect.flatMap(() =>
					Option.match(sessionSigningSecret(env), {
						onNone: () =>
							Effect.fail(
								new DirectoryDisabledError({
									message: "MAPLE_SESSION_SECRET or MAPLE_ROOT_PASSWORD is required for OIDC sessions",
								}),
							),
						onSome: (secret) => Effect.succeed(Redacted.value(secret)),
					}),
				),
			)
			const keyring = yield* secretKeyringFromEnv(env, (message) => new DirectoryPersistenceError({ message }))
			const nowSeconds = Effect.map(Clock.currentTimeMillis, (ms) => Math.floor(ms / 1000))

			const mint = (
				secret: string,
				sub: UserId,
				orgId: OrgId,
				roles: ReadonlyArray<RoleName>,
				now: number,
				sessionExpiresAt: number,
				sid: string | undefined,
				/** The new token never outlives this (epoch seconds); unset means the full TTL. */
				notAfter?: number,
			) => {
				const ttlSeconds =
					sub === ROOT_PASSWORD_USER ? SELF_HOSTED_SESSION_TTL_SECONDS : env.MAPLE_OIDC_SESSION_TTL_SECONDS
				const { token, expiresAt } = mintSessionToken(
					{
						sub,
						orgId,
						roles,
						nowSeconds: now,
						ttlSeconds: notAfter === undefined ? ttlSeconds : Math.min(ttlSeconds, notAfter - now),
						sessionExpiresAt,
						sid,
					},
					secret,
				)
				return new SelfHostedLoginResponse({
					token,
					orgId,
					userId: sub,
					expiresAt: expiresAt * 1000,
					sessionExpiresAt: sessionExpiresAt * 1000,
				})
			}

			const forbidden = (message: string) => new DirectoryForbiddenError({ message })

			const requireRoot = (tenant: TenantContext) =>
				isRoot(tenant.roles)
					? Effect.void
					: Effect.fail(forbidden("Only IT administrators can do this"))

			// Read from the directory, not the token: a demotion takes effect before the token expires.
			const requireOrgAdmin = (tenant: TenantContext) =>
				isRoot(tenant.roles)
					? Effect.void
					: dbExecute((db) => activeMembership(db, tenant.orgId, tenant.userId)).pipe(
							Effect.flatMap((member) =>
								Option.exists(member, (row) => row.role === "org:admin")
									? Effect.void
									: Effect.fail(forbidden("Only organization admins can manage members")),
							),
						)

			/** The user's memberships of active orgs, oldest first. */
			const activeMembershipsOf = (userId: UserId) =>
				dbExecute((db) =>
					Effect.gen(function* () {
						const members = yield* db.run(
							PG.from(DirectoryMembers)
								.select()
								.where(($) => [$.userId.eq(userId)])
								.orderBy(["createdAt", "asc"]),
						)
						const [first, ...rest] = Arr.map(members, (member) => member.orgId)
						if (first === undefined) return []
						const orgs = yield* db.run(
							PG.from(DirectoryOrgs)
								.select()
								.where(($) => [$.id.in_(first, ...rest), $.status.eq("active")]),
						)
						return Arr.flatMap(members, (member) =>
							Option.match(
								Arr.findFirst(orgs, (org) => org.id === member.orgId),
								{
									onNone: () => [],
									onSome: (org) => [
										{ orgId: member.orgId, name: org.name, role: member.role },
									],
								},
							),
						)
					}),
				)

			const oidcConfig = Effect.sync(
				() =>
					new OidcConfigResponse({
						enabled,
						authorizeUrl: Option.getOrElse(env.MAPLE_OIDC_AUTHORIZE_URL, () => ""),
						clientId: Option.getOrElse(env.MAPLE_OIDC_CLIENT_ID, () => ""),
						accountUrl: Option.getOrElse(env.MAPLE_OIDC_ACCOUNT_URL, () => ""),
					}),
			)

			// The only redirect URI Maple ever sends (`apps/web/src/platform/oidc.ts`, `redirectUriOf`).
			const signInRedirectUri = `${Str.replace(/\/+$/, "")(env.MAPLE_APP_BASE_URL)}/sign-in`

			/** Stores the sign-in behind a new session token; its id becomes the token's `sid`. */
			const createSession = (
				sub: UserId,
				identity: { readonly refreshToken?: string; readonly sid?: string },
				nowMs: number,
				sessionExpiresAt: number,
			) =>
				Effect.gen(function* () {
					const id = randomUUID()
					const sealed =
						identity.refreshToken === undefined
							? undefined
							: yield* sealSecret(
									keyring,
									directorySessionRefreshTokenSlot,
									{ userId: sub, id },
									identity.refreshToken,
									(message) => new DirectoryPersistenceError({ message }),
								)
					yield* dbExecute((db) =>
						db.transaction(
							Effect.all([
								// Opportunistic cleanup of this user's dead sessions; nothing reads them.
								db.run(
									PG.deleteFrom(DirectorySessions).where(($) => [
										$.userId.eq(sub),
										PG.or(
											$.expiresAt.lte(nowMs),
											$.revokedAt.lte(nowMs - REVOKED_SESSION_RETENTION_MS),
										),
									]),
								),
								db.run(
									PG.insertInto(DirectorySessions).values({
										id,
										userId: sub,
										idpSid: identity.sid ?? null,
										refreshTokenCiphertext: sealed?.ciphertext ?? null,
										refreshTokenIv: sealed?.iv ?? null,
										refreshTokenTag: sealed?.tag ?? null,
										createdAt: nowMs,
										expiresAt: sessionExpiresAt * 1000,
										refreshedAt: nowMs,
										revokedAt: null,
									}),
								),
							]),
						),
					)
					return id
				})

			const callback = Effect.fn("DirectoryService.callback")(function* (input: OidcCallbackRequest) {
				const secret = yield* signingSecret
				// Pinned server-side: a code is only redeemed for Maple's own sign-in page.
				if (input.redirectUri !== signInRedirectUri) {
					return yield* new UnauthorizedError({ message: "Unexpected redirect URI" })
				}
				const identity = yield* oidc.exchange({ ...input, redirectUri: signInRedirectUri })
				const sub = yield* Schema.decodeEffect(UserId)(identity.sub).pipe(
					Effect.mapError(
						() =>
							new UnauthorizedError({ message: "Invalid subject from the identity provider" }),
					),
				)
				// "root" is the root-password operator, whom renewal exempts from membership checks.
				if (sub === ROOT_PASSWORD_USER) {
					return yield* new UnauthorizedError({
						message: "Invalid subject from the identity provider",
					})
				}
				const asRootUser = identity.roles.includes(env.MAPLE_OIDC_ROOT_ROLE)
				const nowMs = yield* Clock.currentTimeMillis

				yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* db.run(
								PG.insertInto(DirectoryUsers)
									.values({
										id: sub,
										email: identity.email,
										emailVerified: identity.emailVerified,
										name: identity.name,
										lastSeenAt: nowMs,
										createdAt: nowMs,
									})
									.onConflictDoUpdate({
										target: ["id"],
										set: {
											email: identity.email,
											emailVerified: identity.emailVerified,
											name: identity.name,
											lastSeenAt: nowMs,
										},
									}),
							)
							// An invitation is addressed to an email; only a verified one proves the user owns it.
							if (!identity.emailVerified || identity.email.length === 0) return
							const invitations = yield* db.run(
								PG.from(DirectoryInvitations)
									.select()
									.where(($) => [$.email.eq(identity.email)]),
							)
							for (const invitation of invitations) {
								yield* db.run(
									PG.insertInto(DirectoryMembers)
										.values({
											orgId: invitation.orgId,
											userId: sub,
											role: invitation.role,
											createdAt: nowMs,
										})
										.onConflictDoNothing(),
								)
								yield* db.run(
									PG.deleteFrom(DirectoryInvitations).where(($) => [
										$.id.eq(invitation.id),
									]),
								)
							}
						}),
					),
				)
				// After the upsert commits, so the user is known (unverified) to IT; no exemption for root.
				if (!identity.emailVerified) {
					return yield* new DirectoryEmailNotVerifiedError({
						message: "Confirm your email address with the link we sent you, then sign in again",
					})
				}

				const memberships = yield* activeMembershipsOf(sub)
				const now = Math.floor(nowMs / 1000)
				const sessionExpiresAt = now + env.MAPLE_OIDC_SESSION_MAX_LIFETIME_SECONDS

				if (asRootUser) {
					const requestedId = input.orgId
					const requested =
						requestedId === undefined
							? Option.none()
							: yield* dbExecute((db) => activeOrg(db, requestedId))
					const [oldestOrg] = yield* dbExecute((db) =>
						db.run(
							PG.from(DirectoryOrgs)
								.select()
								.where(($) => [$.status.eq("active")])
								.orderBy(["createdAt", "asc"])
								.limit(1),
						),
					)
					const orgId = Option.match(requested, {
						onSome: (org) => org.id,
						// With no org at all, IT still signs in (to create the first one) in the default org.
						onNone: () =>
							memberships[0]?.orgId ??
							oldestOrg?.id ??
							Schema.decodeSync(OrgId)(env.MAPLE_DEFAULT_ORG_ID),
					})
					const sid = yield* createSession(sub, identity, nowMs, sessionExpiresAt)
					return mint(secret, sub, orgId, [ROOT_ROLE], now, sessionExpiresAt, sid)
				}

				const chosen = Arr.findFirst(memberships, (member) => member.orgId === input.orgId).pipe(
					Option.orElse(() => Arr.head(memberships)),
				)
				if (Option.isNone(chosen)) {
					return yield* new NoOrganizationError({
						message: "You are not a member of any organization yet",
					})
				}
				const sid = yield* createSession(sub, identity, nowMs, sessionExpiresAt)
				return mint(
					secret,
					sub,
					chosen.value.orgId,
					[asRole(chosen.value.role)],
					now,
					sessionExpiresAt,
					sid,
				)
			})

			const me = Effect.fn("DirectoryService.me")(function* (tenant: TenantContext) {
				yield* requireEnabled
				const [user] = yield* dbExecute((db) =>
					db.run(
						PG.from(DirectoryUsers)
							.select()
							.where(($) => [$.id.eq(tenant.userId)])
							.limit(1),
					),
				)
				const memberships = yield* activeMembershipsOf(tenant.userId)
				const activeOrgs = isRoot(tenant.roles)
					? yield* dbExecute((db) =>
							db.run(
								PG.from(DirectoryOrgs)
									.select()
									.where(($) => [$.status.eq("active")])
									.orderBy(["name", "asc"]),
							),
						)
					: []
				const orgs = isRoot(tenant.roles)
					? Arr.map(activeOrgs, (org) => ({
							orgId: org.id,
							name: org.name,
							role: Option.match(
								Arr.findFirst(memberships, (member) => member.orgId === org.id),
								{
									onNone: (): AssignableRoleKey => "org:admin",
									onSome: (member) => member.role,
								},
							),
						}))
					: memberships
				return new MeResponse({
					user: toDirectoryUser(user, tenant.userId),
					isRoot: isRoot(tenant.roles),
					activeOrgId: tenant.orgId,
					orgs: Arr.map(
						orgs,
						(org) => new MeOrg({ id: org.orgId, name: org.name, role: org.role }),
					),
				})
			})

			/** `token` is the caller's bearer: the new token keeps its session deadline. */
			const switchOrg = Effect.fn("DirectoryService.switchOrg")(function* (
				tenant: TenantContext,
				token: string | undefined,
				orgId: OrgId,
			) {
				const secret = yield* signingSecret
				const claims = yield* verifySelfHostedSessionToken(token ?? "", secret).pipe(
					Effect.mapError(() => forbidden("Switching organization needs a self-hosted session")),
				)
				// A switch mints a fresh `exp`, so it must not outlive a logout: the session has to be live.
				if (claims.sub !== ROOT_PASSWORD_USER) {
					const sid = claims.sid
					if (sid === undefined) return yield* forbidden("Sign in again to switch organization")
					const nowMs = yield* Clock.currentTimeMillis
					const live = yield* dbExecute((db) => liveSession(db, sid, claims.sub, nowMs, false))
					if (Result.isFailure(live)) return yield* forbidden(live.failure)
				}
				let roles: ReadonlyArray<RoleName>
				if (isRoot(tenant.roles)) {
					const org = yield* dbExecute((db) => activeOrg(db, orgId))
					if (Option.isNone(org)) {
						return yield* forbidden("No such active organization")
					}
					roles = [ROOT_ROLE]
				} else {
					const member = yield* dbExecute((db) => activeMembership(db, orgId, tenant.userId))
					if (Option.isNone(member))
						return yield* forbidden("You are not a member of that organization")
					roles = [asRole(member.value.role)]
				}
				const sessionExpiresAt =
					claims.session_exp ?? claims.iat + SELF_HOSTED_SESSION_MAX_LIFETIME_SECONDS
				const now = yield* nowSeconds
				// Only renewal (which asks the IdP) extends a token; a switch keeps the caller's own `exp`.
				return mint(secret, claims.sub, orgId, roles, now, sessionExpiresAt, claims.sid, claims.exp)
			})

			/** The caller's own session token, verified; who it belongs to and which session it names. */
			const sessionOf = (token: string | undefined, allowExpiredForLogout = false) =>
				Option.match(sessionSigningSecret(env), {
					onNone: () =>
						Effect.fail(new UnauthorizedError({ message: "Self-hosted sessions are not configured" })),
					onSome: (secret) =>
						verifySelfHostedSessionToken(token ?? "", Redacted.value(secret), {
							allowExpiredForLogout,
						}).pipe(
							Effect.mapError(
								() => new UnauthorizedError({ message: "This needs a self-hosted session token" }),
							),
						),
				})

			const sessionPersistence = (error: { readonly message: string }) =>
				new SelfHostedSessionPersistenceError({ message: error.message })

			/** Revokes the matching live rows, then ends each one's IdP session (best effort). */
			const revokeSessions = (userId: UserId, sid: string | undefined) =>
				Effect.gen(function* () {
					const nowMs = yield* Clock.currentTimeMillis
					const revoked = yield* dbExecute((db) =>
						db.run(
							PG.update(DirectorySessions)
								.set({ revokedAt: nowMs })
								.where(($) => [
									$.userId.eq(userId),
									sid === undefined ? undefined : $.id.eq(sid),
									$.revokedAt.isNull(),
								])
								.returning(),
						),
					).pipe(Effect.mapError(sessionPersistence))
					yield* Effect.forEach(
						revoked,
						(row) => {
							const stored = storedRefreshToken(row)
							return stored === undefined
								? Effect.void
								: openSecret(
										keyring,
										directorySessionRefreshTokenSlot,
										{ userId: row.userId, id: row.id },
										stored,
										(message) => message,
									).pipe(
										Effect.flatMap(oidc.logout),
										Effect.catch(() =>
											Effect.logWarning("Stored IdP refresh token could not be opened"),
										),
									)
						},
						{ concurrency: 4, discard: true },
					)
					return new SelfHostedSessionOkResponse({ ok: true })
				})

			/**
			 * Signs out the session the bearer names, here and at the IdP. Unauthenticated route: an idle
			 * tab's token may be past `exp`, and it must still end the IdP session. Such a token is
			 * accepted only when correctly signed, names a session (`sid`) of its own `sub` that has not
			 * reached its absolute end. A token with no session (root password, or minted before
			 * sessions) has nothing server-side to end, so it is accepted only while unexpired.
			 */
			const logout = Effect.fn("DirectoryService.logout")(function* (token: string | undefined) {
				const claims = yield* sessionOf(token, true)
				const sid = claims.sid
				if (sid === undefined) {
					yield* sessionOf(token)
					return new SelfHostedSessionOkResponse({ ok: true })
				}
				const nowMs = yield* Clock.currentTimeMillis
				const [row] = yield* dbExecute((db) =>
					db.run(
						PG.from(DirectorySessions)
							.select()
							.where(($) => [$.id.eq(sid), $.userId.eq(claims.sub)])
							.limit(1),
					),
				).pipe(Effect.mapError(sessionPersistence))
				if (row === undefined || row.expiresAt <= nowMs) {
					return yield* new UnauthorizedError({ message: "No such session" })
				}
				return yield* revokeSessions(claims.sub, sid)
			})

			/** Signs out every session of the bearer's user ("sign out everywhere"). */
			const logoutAll = Effect.fn("DirectoryService.logoutAll")(function* (token: string | undefined) {
				const claims = yield* sessionOf(token)
				return yield* revokeSessions(claims.sub, undefined)
			})

			/** The bearer's user's live sessions, newest first. */
			const listSessions = Effect.fn("DirectoryService.listSessions")(function* (token: string | undefined) {
				const claims = yield* sessionOf(token)
				const nowMs = yield* Clock.currentTimeMillis
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(DirectorySessions)
							.select()
							.where(($) => [
								$.userId.eq(claims.sub),
								$.revokedAt.isNull(),
								$.expiresAt.gt(nowMs),
							])
							.orderBy(["createdAt", "desc"]),
					),
				).pipe(Effect.mapError(sessionPersistence))
				return new SelfHostedSessionsResponse({
					sessions: Arr.map(
						rows,
						(row) =>
							new SelfHostedSession({
								id: row.id,
								createdAt: row.createdAt,
								refreshedAt: row.refreshedAt,
								current: row.id === claims.sid,
							}),
					),
				})
			})

			const listMembers = Effect.fn("DirectoryService.listMembers")(function* (tenant: TenantContext) {
				yield* requireEnabled
				yield* requireOrgAdmin(tenant)
				return yield* dbExecute((db) =>
					Effect.gen(function* () {
						const members = yield* db.run(
							PG.from(DirectoryMembers)
								.select()
								.where(($) => [$.orgId.eq(tenant.orgId)])
								.orderBy(["createdAt", "asc"]),
						)
						const [first, ...rest] = Arr.map(members, (member) => member.userId)
						const users =
							first === undefined
								? []
								: yield* db.run(
										PG.from(DirectoryUsers)
											.select()
											.where(($) => [$.id.in_(first, ...rest)]),
									)
						const invitations = yield* db.run(
							PG.from(DirectoryInvitations)
								.select()
								.where(($) => [$.orgId.eq(tenant.orgId)])
								.orderBy(["createdAt", "asc"]),
						)
						return new MembersResponse({
							members: Arr.map(
								members,
								(member) =>
									new DirectoryMember({
										user: toDirectoryUser(
											Arr.findFirst(users, (user) => user.id === member.userId).pipe(
												Option.getOrUndefined,
											),
											member.userId,
										),
										role: member.role,
									}),
							),
							invitations: Arr.map(
								invitations,
								(invitation) =>
									new DirectoryInvitation({
										id: invitation.id,
										email: invitation.email,
										role: invitation.role,
										createdAt: invitation.createdAt,
									}),
							),
						})
					}),
				)
			})

			/**
			 * Changes or removes one membership of the caller's org. The org's member rows are locked so two
			 * concurrent demotions cannot both see "another admin remains".
			 */
			const changeMember = (tenant: TenantContext, userId: UserId, next: AssignableRoleKey | null) =>
				Effect.gen(function* () {
					yield* requireEnabled
					yield* requireOrgAdmin(tenant)
					const found = yield* dbExecute((db) =>
						db.transaction(
							Effect.gen(function* () {
								const members = yield* db.run(
									PG.from(DirectoryMembers)
										.select()
										.where(($) => [$.orgId.eq(tenant.orgId)])
										.forUpdate(),
								)
								const target = Arr.findFirst(members, (member) => member.userId === userId)
								if (Option.isNone(target)) return false
								const admins = Arr.filter(
									members,
									(member) => member.role === "org:admin",
								).length
								if (
									target.value.role === "org:admin" &&
									next !== "org:admin" &&
									admins <= 1
								) {
									return yield* new DirectoryConflictError({
										message: "An organization must keep at least one admin",
									})
								}
								yield* next === null
									? db.run(
											PG.deleteFrom(DirectoryMembers).where(($) => [
												$.orgId.eq(tenant.orgId),
												$.userId.eq(userId),
											]),
										)
									: db.run(
											PG.update(DirectoryMembers)
												.set({ role: next })
												.where(($) => [
													$.orgId.eq(tenant.orgId),
													$.userId.eq(userId),
												]),
										)
								return true
							}),
						),
					)
					if (!found) {
						// A removal whose sweep failed after the delete committed: re-running it is the retry.
						if (next === null) {
							yield* revocation.revokeMembership(tenant.orgId, userId).pipe(Effect.mapError(persistence))
						}
						return yield* new DirectoryNotFoundError({ message: "No such member" })
					}
					// After the commit, as the Clerk webhook does: keys, CLI/MCP grants and devices the
					// member minted carry their old role (or any access at all) until retired here.
					yield* (
						next === null
							? revocation.revokeMembership(tenant.orgId, userId)
							: revocation.demoteMembership(tenant.orgId, userId, [asRole(next)])
					).pipe(Effect.mapError(persistence))
					return new DirectoryOkResponse({ ok: true })
				})

			const updateMember = Effect.fn("DirectoryService.updateMember")(function* (
				tenant: TenantContext,
				userId: UserId,
				role: AssignableRoleKey,
			) {
				return yield* changeMember(tenant, userId, role)
			})

			const removeMember = Effect.fn("DirectoryService.removeMember")(function* (
				tenant: TenantContext,
				userId: UserId,
			) {
				return yield* changeMember(tenant, userId, null)
			})

			const createInvitation = Effect.fn("DirectoryService.createInvitation")(function* (
				tenant: TenantContext,
				rawEmail: string,
				role: AssignableRoleKey,
			) {
				yield* requireEnabled
				yield* requireOrgAdmin(tenant)
				const email = normalizeEmail(rawEmail)
				if (!EMAIL_PATTERN.test(email)) {
					return yield* new DirectoryValidationError({
						message: "A valid email address is required",
					})
				}
				const id = randomUUID()
				const createdAt = yield* Clock.currentTimeMillis
				const inserted = yield* dbExecute((db) =>
					db.run(
						PG.insertInto(DirectoryInvitations)
							.values({
								id,
								orgId: tenant.orgId,
								email,
								role,
								invitedBy: tenant.userId,
								createdAt,
							})
							.onConflictDoNothing()
							.returning("id"),
					),
				)
				if (inserted.length === 0) {
					return yield* new DirectoryConflictError({
						message: `${email} already has a pending invitation`,
					})
				}
				const org = yield* dbExecute((db) =>
					db.run(
						PG.from(DirectoryOrgs)
							.select()
							.where(($) => [$.id.eq(tenant.orgId)])
							.limit(1),
					),
				)
				yield* sendInvitationEmail(org[0]?.name ?? tenant.orgId, email)
				return new DirectoryInvitation({ id, email, role, createdAt })
			})

			const revokeInvitation = Effect.fn("DirectoryService.revokeInvitation")(function* (
				tenant: TenantContext,
				invitationId: string,
			) {
				yield* requireEnabled
				yield* requireOrgAdmin(tenant)
				const deleted = yield* dbExecute((db) =>
					db.run(
						PG.deleteFrom(DirectoryInvitations)
							.where(($) => [$.id.eq(invitationId), $.orgId.eq(tenant.orgId)])
							.returning("id"),
					),
				)
				if (deleted.length === 0)
					return yield* new DirectoryNotFoundError({ message: "No such invitation" })
				return new DirectoryOkResponse({ ok: true })
			})

			const listOrgs = Effect.fn("DirectoryService.listOrgs")(function* (tenant: TenantContext) {
				yield* requireEnabled
				yield* requireRoot(tenant)
				const [orgs, members] = yield* dbExecute((db) =>
					Effect.all([
						db.run(PG.from(DirectoryOrgs).select().orderBy(["createdAt", "asc"])),
						db.run(PG.from(DirectoryMembers).select(($) => ({ orgId: $.orgId }))),
					]),
				)
				return new OrgsResponse({
					orgs: Arr.map(
						orgs,
						(org) =>
							new DirectoryOrg({
								id: org.id,
								name: org.name,
								status: org.status,
								memberCount: Arr.filter(members, (member) => member.orgId === org.id).length,
								createdAt: org.createdAt,
							}),
					),
				})
			})

			/** The directory rows of an org whose provisioning failed, so the slug can be retried. */
			const forgetOrg = (orgId: OrgId) =>
				dbExecute((db) =>
					db.transaction(
						Effect.all([
							db.run(PG.deleteFrom(DirectoryMembers).where(($) => [$.orgId.eq(orgId)])),
							db.run(PG.deleteFrom(DirectoryInvitations).where(($) => [$.orgId.eq(orgId)])),
							db.run(PG.deleteFrom(DirectoryOrgs).where(($) => [$.id.eq(orgId)])),
						]),
					),
				).pipe(Effect.ignore)

			const createOrg = Effect.fn("DirectoryService.createOrg")(function* (
				tenant: TenantContext,
				request: CreateOrgRequest,
			) {
				yield* requireEnabled
				yield* requireRoot(tenant)
				// The id names a ClickHouse database and user, so it is held to the slug shape before anything else.
				if (!DIRECTORY_ORG_ID_PATTERN.test(request.id)) {
					return yield* new DirectoryValidationError({
						message: "Organization ids are 3-40 lowercase letters, digits and dashes",
					})
				}
				const name = Str.trim(request.name)
				const adminEmail = normalizeEmail(request.adminEmail)
				if (name.length === 0)
					return yield* new DirectoryValidationError({ message: "A name is required" })
				if (!EMAIL_PATTERN.test(adminEmail)) {
					return yield* new DirectoryValidationError({
						message: "A valid admin email address is required",
					})
				}
				const createdAt = yield* Clock.currentTimeMillis
				const conflict = new DirectoryConflictError({
					message: `An organization with id ${request.id} already exists or is still being deleted`,
				})

				const memberCount = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							const inserted = yield* db.run(
								PG.insertInto(DirectoryOrgs)
									.values({
										id: request.id,
										name,
										status: "active",
										createdAt,
										createdBy: tenant.userId,
									})
									.onConflictDoNothing()
									.returning("id"),
							)
							if (inserted.length === 0) return yield* conflict
							// Only a verified address may be made admin directly; anyone else gets an invitation.
							const [user] = yield* db.run(
								PG.from(DirectoryUsers)
									.select()
									.where(($) => [$.email.eq(adminEmail), $.emailVerified.eq(true)])
									.limit(1),
							)
							if (user !== undefined) {
								yield* db.run(
									PG.insertInto(DirectoryMembers).values({
										orgId: request.id,
										userId: user.id,
										role: "org:admin",
										createdAt,
									}),
								)
								return 1
							}
							yield* db.run(
								PG.insertInto(DirectoryInvitations).values({
									id: randomUUID(),
									orgId: request.id,
									email: adminEmail,
									role: "org:admin",
									invitedBy: tenant.userId,
									createdAt,
								}),
							)
							return 0
						}),
					),
				)

				yield* provisioner
					.provision(request.id, tenant.userId)
					.pipe(Effect.tapError(() => forgetOrg(request.id)))
				if (memberCount === 0) yield* sendInvitationEmail(name, adminEmail)
				return new DirectoryOrg({ id: request.id, name, status: "active", memberCount, createdAt })
			})

			const renameOrg = Effect.fn("DirectoryService.renameOrg")(function* (
				tenant: TenantContext,
				orgId: OrgId,
				rawName: string,
			) {
				yield* requireEnabled
				yield* requireRoot(tenant)
				const name = Str.trim(rawName)
				if (name.length === 0)
					return yield* new DirectoryValidationError({ message: "A name is required" })
				const updated = yield* dbExecute((db) =>
					db.run(
						PG.update(DirectoryOrgs)
							.set({ name })
							.where(($) => [$.id.eq(orgId)])
							.returning("id"),
					),
				)
				if (updated.length === 0)
					return yield* new DirectoryNotFoundError({ message: "No such organization" })
				return new DirectoryOkResponse({ ok: true })
			})

			const deleteOrg = Effect.fn("DirectoryService.deleteOrg")(function* (
				tenant: TenantContext,
				orgId: OrgId,
			) {
				yield* requireEnabled
				yield* requireRoot(tenant)
				// A "deleting" org is accepted too: re-running a failed delete is how it is finished.
				const marked = yield* dbExecute((db) =>
					db.run(
						PG.update(DirectoryOrgs)
							.set({ status: "deleting" })
							.where(($) => [$.id.eq(orgId)])
							.returning("id"),
					),
				)
				if (marked.length === 0)
					return yield* new DirectoryNotFoundError({ message: "No such organization" })
				// Swept before the purge, which deletes the membership rows (and the org's credential rows,
				// and finally the org itself): a failed sweep leaves the members in place, so a re-run of
				// this delete sweeps them again. The sweep is idempotent.
				const members = yield* dbExecute((db) =>
					db.run(
						PG.from(DirectoryMembers)
							.select(($) => ({ userId: $.userId }))
							.where(($) => [$.orgId.eq(orgId)]),
					),
				)
				yield* Effect.forEach(
					members,
					(member) => revocation.revokeMembership(orgId, member.userId),
					{ concurrency: 4, discard: true },
				).pipe(Effect.mapError(persistence))
				yield* provisioner.purge(orgId)
				return new DirectoryOkResponse({ ok: true })
			})

			const listUsers = Effect.fn("DirectoryService.listUsers")(function* (tenant: TenantContext) {
				yield* requireEnabled
				yield* requireRoot(tenant)
				const [users, members] = yield* dbExecute((db) =>
					Effect.all([
						db.run(PG.from(DirectoryUsers).select().orderBy(["email", "asc"])),
						db.run(PG.from(DirectoryMembers).select()),
					]),
				)
				return new UsersResponse({
					users: Arr.map(
						users,
						(user) =>
							new DirectoryUserListRow({
								user: toDirectoryUser(user, user.id),
								orgs: Arr.map(
									Arr.filter(members, (member) => member.userId === user.id),
									(member) => new DirectoryUserOrg({ id: member.orgId, role: member.role }),
								),
							}),
					),
				})
			})

			return {
				oidcConfig,
				callback,
				me,
				switchOrg,
				listMembers,
				updateMember,
				removeMember,
				createInvitation,
				revokeInvitation,
				listOrgs,
				createOrg,
				renameOrg,
				deleteOrg,
				listUsers,
				logout,
				logoutAll,
				listSessions,
			}
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				OidcClient.layer,
				OrgProvisioner.layer,
				EmailService.layer,
				MembershipRevocationService.layer,
			),
		),
	)
}
