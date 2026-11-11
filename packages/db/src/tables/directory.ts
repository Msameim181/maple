import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgId, UserId } from "@maple/primitives"
import { Schema } from "effect"

/**
 * The self-hosted directory: organizations, OIDC users, memberships and pending invitations.
 * Only read when the deployment configures OIDC (`MAPLE_OIDC_*`); Clerk mode never touches it.
 */
export const DirectoryRoleSchema = Schema.Literals(["org:member", "org:engineer", "org:admin"])
export const DirectoryOrgStatusSchema = Schema.Literals(["active", "deleting"])

export const DirectoryOrgs = PG.table("directory_orgs", {
	columns: {
		// The permanent slug written on every telemetry row; also names the org's ClickHouse database.
		id: PG.brand(PG.text, OrgId),
		name: PG.text,
		status: PG.brand(PG.text, DirectoryOrgStatusSchema),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
		createdBy: PG.column(PG.brand(PG.text, UserId), { name: "created_by" }),
	},
	primaryKey: ["id"],
})

/** One row per OIDC subject, upserted on every sign-in. */
export const DirectoryUsers = PG.table("directory_users", {
	columns: {
		id: PG.brand(PG.text, UserId),
		// Lowercased on write.
		email: PG.text,
		emailVerified: PG.column(PG.bool, { name: "email_verified" }),
		name: PG.nullable(PG.text),
		lastSeenAt: PG.column(PG.nullable(PG.timestamptzMillis), { name: "last_seen_at" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
	},
	primaryKey: ["id"],
	indexes: [PG.index("directory_users_email_idx", ["email"])],
})

export const DirectoryMembers = PG.table("directory_members", {
	columns: {
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		userId: PG.column(PG.brand(PG.text, UserId), { name: "user_id" }),
		role: PG.brand(PG.text, DirectoryRoleSchema),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
	},
	primaryKey: ["orgId", "userId"],
	indexes: [PG.index("directory_members_user_idx", ["userId"])],
})

/** Pending only: an accepted invitation becomes a membership and its row is deleted. */
export const DirectoryInvitations = PG.table("directory_invitations", {
	columns: {
		id: PG.text,
		orgId: PG.column(PG.brand(PG.text, OrgId), { name: "org_id" }),
		// Lowercased on write.
		email: PG.text,
		role: PG.brand(PG.text, DirectoryRoleSchema),
		invitedBy: PG.column(PG.brand(PG.text, UserId), { name: "invited_by" }),
		createdAt: PG.column(PG.timestamptzMillis, { name: "created_at" }),
	},
	primaryKey: ["id"],
	indexes: [
		PG.uniqueIndex("directory_invitations_org_email_idx", ["orgId", "email"]),
		PG.index("directory_invitations_email_idx", ["email"]),
	],
})

export type DirectoryOrgRow = PG.SelectRowOf<typeof DirectoryOrgs>
export type DirectoryUserRow = PG.SelectRowOf<typeof DirectoryUsers>
export type DirectoryMemberRow = PG.SelectRowOf<typeof DirectoryMembers>
export type DirectoryInvitationRow = PG.SelectRowOf<typeof DirectoryInvitations>
