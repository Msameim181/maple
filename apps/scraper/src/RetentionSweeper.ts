import { Config, Duration, Effect, Redacted, Schedule, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { ScraperEnv } from "./Env"

/** Minutes between sweeps (`MAPLE_RETENTION_SWEEP_MINUTES`, default 60). */
const sweepMinutes = Config.schema(
	Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 24 * 60 })),
	"MAPLE_RETENTION_SWEEP_MINUTES",
).pipe(Config.withDefault(60))

/** One `POST /api/internal/retention/sweep`. Failures are logged, never thrown: the next tick retries. */
export const sweepOnce = Effect.gen(function* () {
	const env = yield* ScraperEnv
	const client = yield* HttpClient.HttpClient
	const request = HttpClientRequest.post(`${env.MAPLE_API_URL}/api/internal/retention/sweep`, {
		headers: { authorization: `Bearer ${Redacted.value(env.SD_INTERNAL_TOKEN)}` },
	})
	const response = yield* client.execute(request).pipe(Effect.timeout("10 minutes"))
	if (response.status !== 200) {
		return yield* Effect.logWarning("Retention sweep refused").pipe(
			Effect.annotateLogs({ status: response.status }),
		)
	}
	yield* Effect.logInfo("Retention sweep done")
}).pipe(
	Effect.catch((error) =>
		Effect.logWarning("Retention sweep failed").pipe(Effect.annotateLogs({ error: String(error) })),
	),
)

/** Sweeps forever on an interval; a minute's grace first so the API is up. */
export const runRetentionSweeper = Effect.gen(function* () {
	const minutes = yield* sweepMinutes
	yield* Effect.sleep("1 minute")
	return yield* sweepOnce.pipe(Effect.repeat(Schedule.spaced(Duration.minutes(minutes))))
}).pipe(
	Effect.catch((error) =>
		Effect.logError("Retention sweeper disabled: bad MAPLE_RETENTION_SWEEP_MINUTES").pipe(
			Effect.annotateLogs({ error: String(error) }),
			Effect.andThen(Effect.never),
		),
	),
)
