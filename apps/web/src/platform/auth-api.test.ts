import { SelfHostedSessionOkResponse, UnauthorizedError } from "@maple/domain/http"
import { Effect, Fiber, Layer, Option, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { endSelfHostedSession, MapleAuthApi, readSessionToken, storedSessionChangeOf } from "./auth-api"

const TOKEN_KEY = "maple.self_hosted.token"

/** One origin's localStorage or one tab's sessionStorage. */
const memoryStorage = (): Storage => {
	const items = new Map<string, string>()
	return {
		get length() {
			return items.size
		},
		key: (index) => [...items.keys()][index] ?? null,
		getItem: (key) => items.get(key) ?? null,
		setItem: (key, value) => {
			items.set(key, value)
		},
		removeItem: (key) => {
			items.delete(key)
		},
		clear: () => items.clear(),
	}
}

const base64Url = (value: string): string =>
	Str.replace(/=+$/, "")(Str.replace(/\//g, "_")(Str.replace(/\+/g, "-")(btoa(value))))
const sessionToken = (claims: { sub: string; org_id: string; iat: number }) =>
	`header.${base64Url(JSON.stringify({ ...claims, exp: claims.iat + 600 }))}.signature`

beforeEach(() => {
	vi.stubGlobal("localStorage", memoryStorage())
	vi.stubGlobal("sessionStorage", memoryStorage())
})
afterEach(() => {
	vi.unstubAllGlobals()
})

describe("the stored session token", () => {
	test("a token an earlier build kept per tab moves to localStorage on first read", () => {
		sessionStorage.setItem(TOKEN_KEY, "legacy-token")
		expect(Effect.runSync(readSessionToken)).toEqual(Option.some("legacy-token"))
		expect(localStorage.getItem(TOKEN_KEY)).toBe("legacy-token")
		expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull()
	})

	test("the shared token wins over a per-tab leftover", () => {
		localStorage.setItem(TOKEN_KEY, "shared-token")
		sessionStorage.setItem(TOKEN_KEY, "legacy-token")
		expect(Effect.runSync(readSessionToken)).toEqual(Option.some("shared-token"))
	})
})

/** The auth API with only `logout`, the one call a log out makes. */
const authApiWith = (logout: MapleAuthApi["Service"]["logout"]) => Layer.mock(MapleAuthApi)({ logout })

describe("log out", () => {
	test("tells the server which session ends, then clears the token", async () => {
		localStorage.setItem(TOKEN_KEY, "session-token")
		const loggedOut: Array<string> = []
		await Effect.runPromise(
			endSelfHostedSession.pipe(
				Effect.provide(
					authApiWith((token) =>
						Effect.sync(() => {
							loggedOut.push(token)
							return new SelfHostedSessionOkResponse({ ok: true })
						}),
					),
				),
			),
		)
		expect(loggedOut).toEqual(["session-token"])
		expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
	})

	test("a failed logout call still ends the session locally", async () => {
		localStorage.setItem(TOKEN_KEY, "session-token")
		await Effect.runPromise(
			endSelfHostedSession.pipe(
				Effect.provide(
					authApiWith(() => Effect.fail(new UnauthorizedError({ message: "Session expired" }))),
				),
			),
		)
		expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
	})
})

describe("log out against an API that never answers", () => {
	test("waits about 4 seconds, then ends the session locally", async () => {
		localStorage.setItem(TOKEN_KEY, "session-token")
		await Effect.gen(function* () {
			const fiber = yield* Effect.forkChild(endSelfHostedSession)
			yield* TestClock.adjust("3 seconds")
			expect(localStorage.getItem(TOKEN_KEY)).toBe("session-token")
			yield* TestClock.adjust("1 second")
			yield* Fiber.join(fiber)
		}).pipe(Effect.provide([TestClock.layer(), authApiWith(() => Effect.never)]), Effect.runPromise)
		expect(localStorage.getItem(TOKEN_KEY)).toBeNull()
	})
})

describe("another tab's write of the token", () => {
	const alice = sessionToken({ sub: "user_alice", org_id: "org_a", iat: 1_700_000_000 })

	test("removed: this tab signs out too", () => {
		expect(storedSessionChangeOf(alice, null)).toEqual(Option.some("SignedOut"))
	})

	test("another user or another org: this tab starts over", () => {
		const bob = sessionToken({ sub: "user_bob", org_id: "org_a", iat: 1_700_000_100 })
		const aliceElsewhere = sessionToken({ sub: "user_alice", org_id: "org_b", iat: 1_700_000_100 })
		expect(storedSessionChangeOf(alice, bob)).toEqual(Option.some("SwitchedIdentity"))
		expect(storedSessionChangeOf(alice, aliceElsewhere)).toEqual(Option.some("SwitchedIdentity"))
		expect(storedSessionChangeOf(null, alice)).toEqual(Option.some("SwitchedIdentity"))
	})

	test("the same user and org renewed: nothing to do", () => {
		const renewed = sessionToken({ sub: "user_alice", org_id: "org_a", iat: 1_700_000_480 })
		expect(storedSessionChangeOf(alice, renewed)).toEqual(Option.none())
	})
})
