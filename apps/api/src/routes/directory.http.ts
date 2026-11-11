import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant, MapleApi, type TenantContext } from "@maple/domain/http"
import { Effect, String as Str } from "effect"
import { HttpServerRequest } from "effect/http"
import { DirectoryService } from "@maple/backend/services/directory/DirectoryService"

const bearerToken = (header: string | undefined) => {
	if (!header) return undefined
	const [scheme, token] = Str.split(" ")(header)
	return Str.toLowerCase(scheme) === "bearer" ? token : undefined
}

export const HttpDirectoryPublicLive = HttpApiBuilder.group(MapleApi, "directoryPublic", (handlers) =>
	Effect.gen(function* () {
		const directory = yield* DirectoryService
		return handlers
			.handle("oidcConfig", () => directory.oidcConfig)
			.handle("oidcCallback", ({ payload }) => directory.callback(payload))
	}),
)

export const HttpDirectoryLive = HttpApiBuilder.group(MapleApi, "directory", (handlers) =>
	Effect.gen(function* () {
		const directory = yield* DirectoryService
		const withTenant = <A, E, R>(f: (tenant: TenantContext) => Effect.Effect<A, E, R>) =>
			Effect.flatMap(CurrentTenant.Context, f)
		return handlers
			.handle("me", () => withTenant(directory.me))
			.handle("switchOrg", ({ payload }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const request = yield* HttpServerRequest.HttpServerRequest
					return yield* directory.switchOrg(
						tenant,
						bearerToken(request.headers.authorization),
						payload.orgId,
					)
				}),
			)
			.handle("listMembers", () => withTenant(directory.listMembers))
			.handle("updateMember", ({ params, payload }) =>
				withTenant((tenant) => directory.updateMember(tenant, params.userId, payload.role)),
			)
			.handle("removeMember", ({ params }) =>
				withTenant((tenant) => directory.removeMember(tenant, params.userId)),
			)
			.handle("createInvitation", ({ payload }) =>
				withTenant((tenant) => directory.createInvitation(tenant, payload.email, payload.role)),
			)
			.handle("revokeInvitation", ({ params }) =>
				withTenant((tenant) => directory.revokeInvitation(tenant, params.invitationId)),
			)
			.handle("listOrgs", () => withTenant(directory.listOrgs))
			.handle("createOrg", ({ payload }) =>
				withTenant((tenant) => directory.createOrg(tenant, payload)),
			)
			.handle("renameOrg", ({ params, payload }) =>
				withTenant((tenant) => directory.renameOrg(tenant, params.orgId, payload.name)),
			)
			.handle("deleteOrg", ({ params }) =>
				withTenant((tenant) => directory.deleteOrg(tenant, params.orgId)),
			)
			.handle("listUsers", () => withTenant(directory.listUsers))
	}),
)
