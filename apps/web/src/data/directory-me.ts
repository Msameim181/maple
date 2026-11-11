import { Array as Arr, Context, Effect, Layer, Option, Schema, String as Str } from "effect"
import { MapleApiClient } from "../platform/api-clients"
import { isClerkAuthEnabled } from "../platform/auth-mode"
import { SessionBearer } from "../platform/session-bearer"
import { makeSessionTenantCache } from "./session-tenant"

/** An org the viewer may switch to. */
export const DirectoryOrgOption = Schema.Struct({ id: Schema.String, name: Schema.String })
export type DirectoryOrgOption = typeof DirectoryOrgOption.Type

/** `GET /api/directory/me`, as the shell, settings and `/admin` read it. */
export const DirectoryViewer = Schema.Struct({
	userId: Schema.String,
	isRoot: Schema.Boolean,
	activeOrgId: Schema.String,
	orgs: Schema.Array(DirectoryOrgOption),
})
export type DirectoryViewer = typeof DirectoryViewer.Type

/** A typed API error's own message (`@maple/http/errors/*`), else `fallback`. */
export const apiErrorMessage = (error: unknown, fallback: string): string =>
	typeof error === "object" &&
	error !== null &&
	"_tag" in error &&
	typeof error._tag === "string" &&
	Str.startsWith("@maple/http/errors/")(error._tag) &&
	"message" in error &&
	typeof error.message === "string"
		? error.message
		: fallback

/** The active org's name, else its id. */
export const activeOrgName = (viewer: DirectoryViewer): string =>
	Option.getOrElse(
		Option.map(
			Arr.findFirst(viewer.orgs, (org) => org.id === viewer.activeOrgId),
			(org) => org.name,
		),
		() => viewer.activeOrgId,
	)

/** The org switcher shows with more than one org to pick, or for root, who may enter any org. */
export const hasOrgChoice = (viewer: DirectoryViewer): boolean => viewer.isRoot || viewer.orgs.length > 1

/**
 * The self-hosted directory's view of the signed-in user, one read per session token. `None` in
 * Clerk mode, and when the deployment has no directory (the API answers 404) or cannot be reached.
 */
export class DirectoryMe extends Context.Service<
	DirectoryMe,
	{ readonly get: Effect.Effect<Option.Option<DirectoryViewer>> }
>()("@maple/web/DirectoryMe") {
	static readonly layer = Layer.effect(
		this,
		Effect.gen(function* () {
			if (isClerkAuthEnabled) return { get: Effect.succeedNone }
			const client = yield* MapleApiClient
			const bearer = yield* SessionBearer
			const read = Effect.gen(function* () {
				const me = yield* client.directory.me()
				// Root may enter any org; with no memberships of its own, the switcher lists them all.
				const orgs =
					me.isRoot && me.orgs.length === 0
						? Arr.filter(
								(yield* client.directory.listOrgs()).orgs,
								(org) => org.status === "active",
							)
						: me.orgs
				return Option.some<DirectoryViewer>({
					userId: me.user.id,
					isRoot: me.isRoot,
					activeOrgId: me.activeOrgId,
					orgs: Arr.map(orgs, (org) => ({ id: org.id, name: org.name })),
				})
				// shortcut: an unreachable API also reads as "no directory" until the token renews; split on
				// `DirectoryDisabledError` if that ever hides the switcher for too long.
			}).pipe(Effect.orElseSucceed(() => Option.none<DirectoryViewer>()))
			return yield* makeSessionTenantCache(read, bearer.token)
		}),
	).pipe(Layer.provide([MapleApiClient.layer, SessionBearer.layer]))
}
