import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http"
import { Effect, Option, Redacted } from "effect"
import { ScraperInternalToken } from "@maple/infra/secrets"
import { isValidInternalBearer } from "@maple/backend/services/auth/internal-auth"
import { RetentionService } from "@maple/backend/services/org/RetentionService"

/**
 * `POST /api/internal/retention/sweep` behind the `SD_INTERNAL_TOKEN` bearer: the scraper calls it
 * on a timer. `?dryRun=1` reports what would be dropped without dropping it.
 */
export const RetentionInternalRouter = HttpRouter.use((router) =>
	Effect.gen(function* () {
		const retention = yield* RetentionService
		const boundToken = yield* ScraperInternalToken
		const internalToken = Option.match(boundToken, { onNone: () => undefined, onSome: Redacted.value })

		const sweep = (req: HttpServerRequest.HttpServerRequest) =>
			Effect.gen(function* () {
				if (!internalToken) return HttpServerResponse.text("Not configured", { status: 401 })
				if (!isValidInternalBearer(req.headers.authorization, internalToken))
					return HttpServerResponse.text("Unauthorized", { status: 401 })
				const dryRun = new URL(req.url, "http://localhost").searchParams.get("dryRun") === "1"
				const orgs = yield* retention.sweep({ dryRun })
				return yield* HttpServerResponse.json({ dryRun, orgs })
			}).pipe(
				Effect.catch((error) =>
					Effect.logError("Retention sweep failed").pipe(
						Effect.annotateLogs({ error: error.message }),
						Effect.as(HttpServerResponse.text("Retention sweep unavailable", { status: 503 })),
					),
				),
			)

		yield* router.add("POST", "/api/internal/retention/sweep", sweep)
	}),
)
