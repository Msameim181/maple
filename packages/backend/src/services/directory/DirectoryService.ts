import { randomUUID } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb } from "@maple/db/client"
import { DirectoryInvitations, DirectoryMembers, DirectoryOrgs, DirectoryUsers } from "@maple/db/tables"
import type { DirectoryMemberRow, DirectoryUserRow } from "@maple/db/tables"
import {
	type AssignableRoleKey,
	DIRECTORY_ORG_ID_PATTERN,
	CreateOrgRequest,
	DirectoryConflictError,
	DirectoryDisabledError,
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
	verifySelfHostedSessionToken,
} from "@maple/auth"
import {
	Clock,
	Context,
	Effect,
	Layer,
	Option,
	pipe,
	Redacted,
	Schema,
	Array as Arr,
	String as Str,
} from "effect"
import { Database, type DatabaseApi } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { EmailService } from "@maple/backend/platform/EmailService"
import { Env, type EnvConfig } from "@maple/backend/platform/Env"
import { OidcClient } from "./OidcClient"
import { OrgProvisioner } from "./OrgProvisioner"

/** An OIDC session token lives 15 minutes, so a removed member loses access at the next renewal. */
export const OIDC_SESSION_TTL_SECONDS = 15 * 60
/** One OIDC sign-in lasts at most 12 hours; after that the IdP is asked again. */
export const OIDC_SESSION_MAX_LIFETIME_SECONDS = 12 * 60 * 60

/** The root-password operator's subject. It has no directory row and keeps upstream renewal. */
const ROOT_PASSWORD_USER = "root"

const asRole = Schema.decodeUnknownSync(RoleName)
const ROOT_ROLE = asRole("root")
const isRoot = (roles: ReadonlyArray<string>) => roles.includes("root")

/** OIDC is on iff the token endpoint and client id are configured. */
export const oidcEnabled = (env: Pick<EnvConfig, "MAPLE_OIDC_TOKEN_URL" | "MAPLE_OIDC_CLIENT_ID">) =>
	Option.isSome(env.MAPLE_OIDC_TOKEN_URL) && Option.isSome(env.MAPLE_OIDC_CLIENT_ID)

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+$/
const normalizeEmail = (email: string) => Str.toLowerCase(Str.trim(email))

const escapeHtml = (value: string) =>
	pipe(
		value,
		Str.replaceAll("&", "&amp;"),
		Str.replaceAll("<", "&lt;"),
		Str.replaceAll(">", "&gt;"),
		Str.replaceAll('"', "&quot;"),
		Str.replaceAll("'", "&#39;"),
	)

const activeOrg = (db: MapleDb, orgId: OrgId) =>
	db
		.run(
			PG.from(DirectoryOrgs)
				.select()
				.where(($) => [$.id.eq(orgId), $.status.eq("active")])
				.limit(1),
		)
		.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])))

/** The user's membership of `orgId`, only while that org is active. */
const activeMembership = (db: MapleDb, orgId: OrgId, userId: UserId) =>
	Effect.gen(function* () {
		const [member] = yield* db.run(
			PG.from(DirectoryMembers)
				.select()
				.where(($) => [$.orgId.eq(orgId), $.userId.eq(userId)])
				.limit(1),
		)
		if (member === undefined) return Option.none<DirectoryMemberRow>()
		const org = yield* activeOrg(db, orgId)
		return Option.map(org, () => member)
	})

/**
 * The renewal check `AuthService` runs when OIDC is on: an OIDC session renews only while its
 * subject is still a member of an active org, with the current role and the short lifetime.
 * Fails closed when there is no database to ask.
 */
export const makeDirectoryRenewal =
	(database: Option.Option<DatabaseApi>): RenewSelfHostedSession =>
	(claims) => {
		if (claims.sub === ROOT_PASSWORD_USER) {
			return Effect.succeed({ roles: claims.roles, ttlSeconds: SELF_HOSTED_SESSION_TTL_SECONDS })
		}
		if (isRoot(claims.roles)) {
			return Effect.succeed({ roles: claims.roles, ttlSeconds: OIDC_SESSION_TTL_SECONDS })
		}
		if (Option.isNone(database)) {
			return Effect.fail(new UnauthorizedError({ message: "Membership could not be checked" }))
		}
		return database.value
			.execute((db) => activeMembership(db, claims.orgId, claims.sub))
			.pipe(
				Effect.mapError(() => new UnauthorizedError({ message: "Membership could not be checked" })),
				Effect.flatMap(
					Option.match({
						onNone: () =>
							Effect.fail(
								new UnauthorizedError({ message: "No longer a member of this organization" }),
							),
						onSome: (member) =>
							Effect.succeed({
								roles: [asRole(member.role)],
								ttlSeconds: OIDC_SESSION_TTL_SECONDS,
							}),
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
			})
		: new DirectoryUser({ id: row.id, email: row.email, name: row.name, lastSeenAt: row.lastSeenAt })

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
			const enabled = oidcEnabled(env)

			// Best effort: the invitation stands without it; the person can still sign up at the link.
			const sendInvitationEmail = (orgName: string, to: string) =>
				email.isConfigured
					? email
							.send(
								to,
								`You're invited to ${orgName} on Maple`,
								`<p>You've been invited to <b>${escapeHtml(orgName)}</b> on Maple.</p>` +
									`<p><a href="${escapeHtml(env.MAPLE_APP_BASE_URL)}/sign-in">Sign in or create your account</a> ` +
									`with this email address (${escapeHtml(to)}) to join.</p>`,
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
			// Every Worker already verifies tokens signed with the root password; OIDC sessions reuse that key.
			const signingSecret = requireEnabled.pipe(
				Effect.flatMap(() =>
					Option.match(env.MAPLE_ROOT_PASSWORD, {
						onNone: () =>
							Effect.fail(
								new DirectoryDisabledError({
									message: "MAPLE_ROOT_PASSWORD is required for OIDC sessions",
								}),
							),
						onSome: (secret) => Effect.succeed(Redacted.value(secret)),
					}),
				),
			)
			const nowSeconds = Effect.map(Clock.currentTimeMillis, (ms) => Math.floor(ms / 1000))

			const mint = (
				secret: string,
				sub: UserId,
				orgId: OrgId,
				roles: ReadonlyArray<RoleName>,
				now: number,
				sessionExpiresAt: number,
			) => {
				const { token, expiresAt } = mintSessionToken(
					{
						sub,
						orgId,
						roles,
						nowSeconds: now,
						ttlSeconds:
							sub === ROOT_PASSWORD_USER
								? SELF_HOSTED_SESSION_TTL_SECONDS
								: OIDC_SESSION_TTL_SECONDS,
						sessionExpiresAt,
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

			const callback = Effect.fn("DirectoryService.callback")(function* (input: OidcCallbackRequest) {
				const secret = yield* signingSecret
				const identity = yield* oidc.exchange(input)
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

				const memberships = yield* activeMembershipsOf(sub)
				const now = Math.floor(nowMs / 1000)
				const sessionExpiresAt = now + OIDC_SESSION_MAX_LIFETIME_SECONDS

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
					return mint(secret, sub, orgId, [ROOT_ROLE], now, sessionExpiresAt)
				}

				const chosen = Arr.findFirst(memberships, (member) => member.orgId === input.orgId).pipe(
					Option.orElse(() => Arr.head(memberships)),
				)
				if (Option.isNone(chosen)) {
					return yield* new NoOrganizationError({
						message: "You are not a member of any organization yet",
					})
				}
				return mint(
					secret,
					sub,
					chosen.value.orgId,
					[asRole(chosen.value.role)],
					now,
					sessionExpiresAt,
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
				return mint(secret, claims.sub, orgId, roles, now, sessionExpiresAt)
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
					yield* dbExecute((db) =>
						db.transaction(
							Effect.gen(function* () {
								const members = yield* db.run(
									PG.from(DirectoryMembers)
										.select()
										.where(($) => [$.orgId.eq(tenant.orgId)])
										.forUpdate(),
								)
								const target = Arr.findFirst(members, (member) => member.userId === userId)
								if (Option.isNone(target)) {
									return yield* new DirectoryNotFoundError({ message: "No such member" })
								}
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
							}),
						),
					)
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
			}
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(OidcClient.layer, OrgProvisioner.layer, EmailService.layer)),
	)
}
