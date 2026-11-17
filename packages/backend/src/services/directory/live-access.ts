import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb } from "@maple/db/client"
import { DirectoryMembers, DirectoryOrgs, DirectorySessions } from "@maple/db/tables"
import type { DirectoryMemberRow } from "@maple/db/tables"
import type { OrgId, UserId } from "@maple/domain/http"
import { Clock, Effect, Option } from "effect"
import type { EnvConfig } from "@maple/backend/platform/Env"

/** OIDC is on iff the token endpoint and client id are configured. */
export const oidcEnabled = (env: Pick<EnvConfig, "MAPLE_OIDC_TOKEN_URL" | "MAPLE_OIDC_CLIENT_ID">) =>
	Option.isSome(env.MAPLE_OIDC_TOKEN_URL) && Option.isSome(env.MAPLE_OIDC_CLIENT_ID)

export const activeOrg = (db: MapleDb, orgId: OrgId) =>
	db
		.run(
			PG.from(DirectoryOrgs)
				.select()
				.where(($) => [$.id.eq(orgId), $.status.eq("active")])
				.limit(1),
		)
		.pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])))

/** The user's membership of `orgId`, only while that org is active. */
export const activeMembership = (db: MapleDb, orgId: OrgId, userId: UserId) =>
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
 * Whether a self-hosted directory identity still has the access a (possibly older) token claims,
 * read live rather than from the token: anything that mints a long-lived credential from a session
 * (CLI keys, MCP grants) asks this first. Members must still belong to the org; IT (root) must
 * still hold a live sign-in; the root-password operator has no directory row and always passes.
 */
export const directoryAccessIsLive = (
	db: MapleDb,
	access: {
		readonly orgId: OrgId
		readonly userId: UserId
		readonly roles: ReadonlyArray<string>
	},
) =>
	Effect.gen(function* () {
		if (access.userId === "root") return true
		if (access.roles.includes("root")) {
			const nowMs = yield* Clock.currentTimeMillis
			const [session] = yield* db.run(
				PG.from(DirectorySessions)
					.select("id")
					.where(($) => [$.userId.eq(access.userId), $.revokedAt.isNull(), $.expiresAt.gt(nowMs)])
					.limit(1),
			)
			return session !== undefined
		}
		const membership = yield* activeMembership(db, access.orgId, access.userId)
		return Option.isSome(membership)
	})
