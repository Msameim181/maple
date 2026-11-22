import { afterEach, describe, expect, it } from "@effect/vitest"
import {
	ApiSchemaErrors,
	ApiUnexpectedErrors,
	CurrentTenant,
	OrgClickHouseSettingsApiGroup,
	OrgId,
	RoleName,
	UserId,
} from "@maple/domain/http"
import { ConfigProvider, Context, Effect, Layer, Schema } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApi, HttpApiBuilder } from "effect/http-api"
import { ApiErrorBoundaryLive } from "@maple/backend/http/error-boundary"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { ClickHouseAdmin } from "@maple/backend/services/directory/OrgProvisioner"
import { RetentionService } from "@maple/backend/services/org/RetentionService"
import { OrgClickHouseSettingsService } from "@maple/backend/services/org/OrgClickHouseSettingsService"
import { HttpOrgClickHouseSettingsLive } from "./org-clickhouse-settings.http"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

class SettingsOnlyApi extends HttpApi.make("MapleInternalApi")
	.add(OrgClickHouseSettingsApiGroup)
	.middleware(ApiSchemaErrors)
	.middleware(ApiUnexpectedErrors) {}

const makeHarness = (role: string) => {
	const db = createTestDb(createdDbs)
	const authorization = Layer.succeed(
		CurrentTenant.SessionAuthorization,
		CurrentTenant.SessionAuthorization.of({
			bearer: (httpEffect) =>
				Effect.provideService(
					httpEffect,
					CurrentTenant.Context,
					new CurrentTenant.TenantSchema({
						orgId: Schema.decodeSync(OrgId)("acme"),
						userId: Schema.decodeSync(UserId)("alice"),
						roles: [Schema.decodeSync(RoleName)(role)],
						authMode: "clerk",
					}),
				),
		}),
	)
	const admin = Layer.succeed(ClickHouseAdmin)({ exec: () => Effect.void, query: () => Effect.succeed([]) })
	const env = Env.layer.pipe(
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					PORT: "3472",
					TINYBIRD_HOST: "https://api.tinybird.co",
					TINYBIRD_TOKEN: "test-token",
					MAPLE_AUTH_MODE: "self_hosted",
					MAPLE_ROOT_PASSWORD: "test-root-password",
					MAPLE_DEFAULT_ORG_ID: "default",
					MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
					MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "lookup-key",
				}),
			),
		),
	)
	const services = Layer.mergeAll(
		Layer.effect(RetentionService, RetentionService.make).pipe(Layer.provide(Layer.mergeAll(admin, env, db.layer))),
		Layer.succeed(OrgClickHouseSettingsService, {} as never),
	)
	const routes = HttpApiBuilder.layer(SettingsOnlyApi).pipe(
		Layer.provide(HttpOrgClickHouseSettingsLive),
		Layer.provide(ApiErrorBoundaryLive),
		Layer.provideMerge(authorization),
		Layer.provide(services),
	)
	const { handler, dispose } = HttpRouter.toWebHandler(routes, { disableLogger: true })
	const call = async (method: string, path: string, body?: unknown) => {
		const init: RequestInit = {
			method,
			headers: { authorization: "Bearer test-token", "content-type": "application/json" },
		}
		if (body !== undefined) init.body = JSON.stringify(body)
		const response = await handler(
			new Request(`http://maple.test/internal/org-clickhouse-settings${path}`, init),
			Context.empty() as never,
		)
		return response.status
	}
	return { call, dispose }
}

describe("/internal/org-clickhouse-settings retention", () => {
	it("refuses a member every retention and storage call with 403, and lets an admin through", async () => {
		const member = makeHarness("org:member")
		const admin = makeHarness("org:admin")
		try {
			expect(await member.call("GET", "/retention")).toBe(403)
			expect(await member.call("PUT", "/retention", { maxAgeDays: 7, maxBytes: null })).toBe(403)
			expect(await member.call("GET", "/storage")).toBe(403)
			expect(await admin.call("PUT", "/retention", { maxAgeDays: 7, maxBytes: 5_000_000_000 })).toBe(200)
			expect(await admin.call("GET", "/retention")).toBe(200)
		} finally {
			await member.dispose()
			await admin.dispose()
		}
	})
})
