import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Redacted } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import { ScraperEnv, type ScraperEnvConfig } from "./Env"
import { sweepOnce } from "./RetentionSweeper"

const env: ScraperEnvConfig = {
	MAPLE_API_URL: "http://api.test",
	SD_INTERNAL_TOKEN: Redacted.make("internal-token"),
	MAPLE_INGEST_URL: "http://ingest.test",
	SCRAPER_CONCURRENCY: 10,
	SCRAPER_RECONCILE_INTERVAL_SECONDS: 60,
	SCRAPER_OTLP_MAX_DATA_POINTS: 10_000,
	SCRAPER_OTLP_MAX_BODY_BYTES: 4 * 1024 * 1024,
	UPTIME_CONCURRENCY: 20,
	UPTIME_ORG_CONCURRENCY: 4,
	PORT: 0,
}

describe("sweepOnce", () => {
	it.effect("posts to the sweep endpoint with the internal bearer, and survives a refusal", () => {
		const seen: Array<{ url: string; method: string; auth: string | undefined }> = []
		let status = 200
		const client = HttpClient.make((request) =>
			Effect.sync(() => {
				seen.push({ url: request.url, method: request.method, auth: request.headers.authorization })
				return HttpClientResponse.fromWeb(request, new Response("{}", { status }))
			}),
		)
		return Effect.gen(function* () {
			yield* sweepOnce
			status = 503
			yield* sweepOnce
			assert.deepStrictEqual(seen, [
				{ url: "http://api.test/api/internal/retention/sweep", method: "POST", auth: "Bearer internal-token" },
				{ url: "http://api.test/api/internal/retention/sweep", method: "POST", auth: "Bearer internal-token" },
			])
		}).pipe(
			Effect.provide(Layer.mergeAll(Layer.succeed(ScraperEnv, env), Layer.succeed(HttpClient.HttpClient, client))),
		)
	})
})
