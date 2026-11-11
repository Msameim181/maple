/**
 * The self-hosted directory: OIDC sign-in (Keycloak or any OIDC provider), organizations, members
 * and invitations, kept in Maple's own Postgres. Only served when the deployment configures OIDC;
 * see docs/superpowers/specs/2026-11-11-selfhost-multitenant-design.md.
 */
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { OrgId, UserId } from "@maple/primitives"
import { SelfHostedLoginResponse } from "./auth"
import { SessionAuthorization, UnauthorizedError } from "./current-tenant"

/** Org ids are permanent slugs; they also name the org's ClickHouse database. */
export const DIRECTORY_ORG_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/

export const AssignableRoleKey = Schema.Literals(["org:member", "org:engineer", "org:admin"])
export type AssignableRoleKey = typeof AssignableRoleKey.Type

export const DirectoryOrgStatus = Schema.Literals(["active", "deleting"])
export type DirectoryOrgStatus = typeof DirectoryOrgStatus.Type

export class DirectoryUser extends Schema.Class<DirectoryUser>("DirectoryUser")({
	id: UserId,
	email: Schema.String,
	name: Schema.NullOr(Schema.String),
	lastSeenAt: Schema.NullOr(Schema.Number),
}) {}

export class OidcConfigResponse extends Schema.Class<OidcConfigResponse>("OidcConfigResponse")({
	enabled: Schema.Boolean,
	authorizeUrl: Schema.String,
	clientId: Schema.String,
	accountUrl: Schema.String,
}) {}

export class OidcCallbackRequest extends Schema.Class<OidcCallbackRequest>("OidcCallbackRequest")({
	code: Schema.String,
	codeVerifier: Schema.String,
	redirectUri: Schema.String,
	orgId: Schema.optionalKey(OrgId),
}) {}

export class MeOrg extends Schema.Class<MeOrg>("MeOrg")({
	id: OrgId,
	name: Schema.String,
	role: AssignableRoleKey,
}) {}

export class MeResponse extends Schema.Class<MeResponse>("MeResponse")({
	user: DirectoryUser,
	isRoot: Schema.Boolean,
	activeOrgId: OrgId,
	orgs: Schema.Array(MeOrg),
}) {}

export class SwitchOrgRequest extends Schema.Class<SwitchOrgRequest>("SwitchOrgRequest")({
	orgId: OrgId,
}) {}

export class DirectoryMember extends Schema.Class<DirectoryMember>("DirectoryMember")({
	user: DirectoryUser,
	role: AssignableRoleKey,
}) {}

export class DirectoryInvitation extends Schema.Class<DirectoryInvitation>("DirectoryInvitation")({
	id: Schema.String,
	email: Schema.String,
	role: AssignableRoleKey,
	createdAt: Schema.Number,
}) {}

export class MembersResponse extends Schema.Class<MembersResponse>("MembersResponse")({
	members: Schema.Array(DirectoryMember),
	invitations: Schema.Array(DirectoryInvitation),
}) {}

export class UpdateMemberRequest extends Schema.Class<UpdateMemberRequest>("UpdateMemberRequest")({
	role: AssignableRoleKey,
}) {}

export class CreateInvitationRequest extends Schema.Class<CreateInvitationRequest>("CreateInvitationRequest")({
	email: Schema.String,
	role: AssignableRoleKey,
}) {}

export class DirectoryOrg extends Schema.Class<DirectoryOrg>("DirectoryOrg")({
	id: OrgId,
	name: Schema.String,
	status: DirectoryOrgStatus,
	memberCount: Schema.Number,
	createdAt: Schema.Number,
}) {}

export class OrgsResponse extends Schema.Class<OrgsResponse>("OrgsResponse")({
	orgs: Schema.Array(DirectoryOrg),
}) {}

export class CreateOrgRequest extends Schema.Class<CreateOrgRequest>("CreateOrgRequest")({
	id: OrgId,
	name: Schema.String,
	adminEmail: Schema.String,
}) {}

export class RenameOrgRequest extends Schema.Class<RenameOrgRequest>("RenameOrgRequest")({
	name: Schema.String,
}) {}

export class DirectoryUserOrg extends Schema.Class<DirectoryUserOrg>("DirectoryUserOrg")({
	id: OrgId,
	role: AssignableRoleKey,
}) {}

export class DirectoryUserRow extends Schema.Class<DirectoryUserRow>("DirectoryUserRow")({
	user: DirectoryUser,
	orgs: Schema.Array(DirectoryUserOrg),
}) {}

export class UsersResponse extends Schema.Class<UsersResponse>("UsersResponse")({
	users: Schema.Array(DirectoryUserRow),
}) {}

export class DirectoryOkResponse extends Schema.Class<DirectoryOkResponse>("DirectoryOkResponse")({
	ok: Schema.Literal(true),
}) {}

export class NoOrganizationError extends Schema.TaggedError<NoOrganizationError>()(
	"@maple/http/errors/NoOrganizationError",
	{ message: Schema.String },
	{ httpApiStatus: 409 },
) {}

export class DirectoryDisabledError extends Schema.TaggedError<DirectoryDisabledError>()(
	"@maple/http/errors/DirectoryDisabledError",
	{ message: Schema.String },
	{ httpApiStatus: 404 },
) {}

export class DirectoryForbiddenError extends Schema.TaggedError<DirectoryForbiddenError>()(
	"@maple/http/errors/DirectoryForbiddenError",
	{ message: Schema.String },
	{ httpApiStatus: 403 },
) {}

export class DirectoryNotFoundError extends Schema.TaggedError<DirectoryNotFoundError>()(
	"@maple/http/errors/DirectoryNotFoundError",
	{ message: Schema.String },
	{ httpApiStatus: 404 },
) {}

export class DirectoryConflictError extends Schema.TaggedError<DirectoryConflictError>()(
	"@maple/http/errors/DirectoryConflictError",
	{ message: Schema.String },
	{ httpApiStatus: 409 },
) {}

export class DirectoryValidationError extends Schema.TaggedError<DirectoryValidationError>()(
	"@maple/http/errors/DirectoryValidationError",
	{ message: Schema.String },
	{ httpApiStatus: 400 },
) {}

export class DirectoryPersistenceError extends Schema.TaggedError<DirectoryPersistenceError>()(
	"@maple/http/errors/DirectoryPersistenceError",
	{ message: Schema.String },
	{ httpApiStatus: 503 },
) {}

export const DirectoryErrors = [
	DirectoryDisabledError,
	DirectoryForbiddenError,
	DirectoryNotFoundError,
	DirectoryConflictError,
	DirectoryValidationError,
	DirectoryPersistenceError,
] as const

/** Unauthenticated: the sign-in page reads the config, then trades the provider's code for a session. */
export class DirectoryPublicApiGroup extends HttpApiGroup.make("directoryPublic")
	.add(HttpApiEndpoint.get("oidcConfig", "/oidc/config", { success: OidcConfigResponse }))
	.add(
		HttpApiEndpoint.post("oidcCallback", "/oidc/callback", {
			payload: OidcCallbackRequest,
			success: SelfHostedLoginResponse,
			error: [UnauthorizedError, NoOrganizationError, ...DirectoryErrors],
		}),
	)
	.prefix("/api/auth") {}

export class DirectoryApiGroup extends HttpApiGroup.make("directory")
	.add(HttpApiEndpoint.get("me", "/me", { success: MeResponse, error: DirectoryErrors }))
	.add(
		HttpApiEndpoint.post("switchOrg", "/switch-org", {
			payload: SwitchOrgRequest,
			success: SelfHostedLoginResponse,
			error: DirectoryErrors,
		}),
	)
	.add(HttpApiEndpoint.get("listMembers", "/members", { success: MembersResponse, error: DirectoryErrors }))
	.add(
		HttpApiEndpoint.patch("updateMember", "/members/:userId", {
			params: { userId: UserId },
			payload: UpdateMemberRequest,
			success: DirectoryOkResponse,
			error: DirectoryErrors,
		}),
	)
	.add(
		HttpApiEndpoint.delete("removeMember", "/members/:userId", {
			params: { userId: UserId },
			success: DirectoryOkResponse,
			error: DirectoryErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("createInvitation", "/invitations", {
			payload: CreateInvitationRequest,
			success: DirectoryInvitation,
			error: DirectoryErrors,
		}),
	)
	.add(
		HttpApiEndpoint.delete("revokeInvitation", "/invitations/:invitationId", {
			params: { invitationId: Schema.String },
			success: DirectoryOkResponse,
			error: DirectoryErrors,
		}),
	)
	.add(HttpApiEndpoint.get("listOrgs", "/orgs", { success: OrgsResponse, error: DirectoryErrors }))
	.add(
		HttpApiEndpoint.post("createOrg", "/orgs", {
			payload: CreateOrgRequest,
			success: DirectoryOrg,
			error: DirectoryErrors,
		}),
	)
	.add(
		HttpApiEndpoint.patch("renameOrg", "/orgs/:orgId", {
			params: { orgId: OrgId },
			payload: RenameOrgRequest,
			success: DirectoryOkResponse,
			error: DirectoryErrors,
		}),
	)
	.add(
		HttpApiEndpoint.delete("deleteOrg", "/orgs/:orgId", {
			params: { orgId: OrgId },
			success: DirectoryOkResponse,
			error: DirectoryErrors,
		}),
	)
	.add(HttpApiEndpoint.get("listUsers", "/users", { success: UsersResponse, error: DirectoryErrors }))
	.prefix("/api/directory")
	.middleware(SessionAuthorization) {}
