import { readJwtExpMs, renewAheadMsOf } from "./auth-headers"
import { isClerkAuthEnabled } from "./auth-mode"
import { Clock, Context, Effect, Layer, Option, Semaphore } from "effect"
import {
	announceSessionTokenChanged,
	clearSessionToken,
	MapleAuthApi,
	readSessionToken,
	saveSessionToken,
} from "./auth-api"
import { clerkSessionToken, freshClerkSessionToken } from "./clerk"

/** The Web Lock every tab of this origin takes to renew the shared token. */
const RENEW_LOCK = "maple-session-renew"

/**
 * Runs `effect` holding the cross-tab renewal lock, so one tab renews while the others wait and
 * then find its token. Without Web Locks (old browsers, tests) it runs as is.
 */
export const withRenewLock = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, E> =>
	Effect.suspend(() => {
		const locks = typeof navigator === "undefined" ? undefined : navigator.locks
		return locks === undefined
			? effect
			: Effect.flatten(
					Effect.promise((signal) =>
						locks.request(RENEW_LOCK, { signal }, () => Effect.runPromiseExit(effect)),
					),
				)
	})

/** Whether `token` is still good at `now`; a token without `exp` predates expiring sessions. */
const isOutsideRenewWindow = (token: string, now: number): boolean => {
	const expiresAt = readJwtExpMs(token)
	return expiresAt === undefined || expiresAt - now > renewAheadMsOf(token)
}

/** The bearer token API requests carry: the self-hosted session or Clerk's session JWT. */
export class SessionBearer extends Context.Service<
	SessionBearer,
	{
		readonly token: Effect.Effect<Option.Option<string>>
		/** Skips any token cache; for resending a request the API rejected. */
		readonly freshToken: Effect.Effect<Option.Option<string>>
	}
>()("@maple/web/SessionBearer") {
	static readonly layer = Layer.effect(
		this,
		isClerkAuthEnabled
			? Effect.succeed({ token: clerkSessionToken, freshToken: freshClerkSessionToken })
			: makeSelfHosted(),
	).pipe(Layer.provide(MapleAuthApi.layer))
}

function makeSelfHosted() {
	return Effect.gen(function* () {
		const auth = yield* MapleAuthApi
		// One renewal at a time: a burst of requests finding the same near-expiry token renews once.
		const renewal = yield* Semaphore.make(1)

		const renew = (token: string) =>
			auth.refresh(token).pipe(
				Effect.tap((renewed) => saveSessionToken(renewed.token)),
				Effect.map((renewed) => Option.some(renewed.token)),
				Effect.catchTag("@maple/web/SessionCheckError", (error) =>
					error.reason === "Rejected"
						? Effect.as(
								Effect.andThen(clearSessionToken, announceSessionTokenChanged),
								Option.none(),
							)
						: Effect.succeedSome(token),
				),
			)

		/** The stored token, or `whenStale` once it is inside its renew window. */
		const storedThen = (whenStale: (stored: string) => Effect.Effect<Option.Option<string>>) =>
			readSessionToken.pipe(
				Effect.flatMap(
					Option.match({
						onNone: () => Effect.succeedNone,
						onSome: (stored) =>
							Effect.flatMap(Clock.currentTimeMillis, (now) =>
								isOutsideRenewWindow(stored, now)
									? Effect.succeedSome(stored)
									: whenStale(stored),
							),
					}),
				),
			)

		// Under the locks the token is read again: another tab may have renewed or ended it meanwhile.
		const token = storedThen(() => renewal.withPermits(1)(withRenewLock(storedThen(renew))))
		// The stored token is the only one there is; re-reading it picks up a concurrent renewal.
		return { token, freshToken: token }
	})
}
