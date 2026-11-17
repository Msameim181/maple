import { Effect, Option } from "effect"
import { TestClock } from "effect/testing"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import {
	authorizeUrlOf,
	claimSignInRestart,
	codeChallengeOf,
	randomToken,
	savePendingSignIn,
	takePendingSignIn,
} from "./oidc"

describe("oidc PKCE", () => {
	test("the S256 challenge matches RFC 7636 appendix B", async () => {
		const challenge = await Effect.runPromise(
			codeChallengeOf("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
		)
		expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
	})

	test("a verifier is 43 url-safe characters and differs each time", () => {
		const first = randomToken()
		expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/)
		expect(randomToken()).not.toBe(first)
	})

	test("the authorize URL keeps the provider's own query and carries every PKCE parameter", () => {
		const url = new URL(
			authorizeUrlOf({
				authorizeUrl: "https://id.example.com/auth?kc_idp_hint=x",
				clientId: "maple",
				redirectUri: "https://maple.example.com/sign-in",
				challenge: "abc",
				state: "s1",
			}),
		)
		expect(url.searchParams.get("kc_idp_hint")).toBe("x")
		expect(url.searchParams.get("redirect_uri")).toBe("https://maple.example.com/sign-in")
		expect(url.searchParams.get("scope")).toBe("openid email profile")
		expect(url.searchParams.get("code_challenge_method")).toBe("S256")
		expect(url.searchParams.get("state")).toBe("s1")
		expect(url.searchParams.has("kc_action")).toBe(false)
	})

	test("an account action rides along as Keycloak's kc_action", () => {
		const url = new URL(
			authorizeUrlOf({
				authorizeUrl: "https://id.example.com/auth",
				clientId: "maple",
				redirectUri: "https://maple.example.com/sign-in",
				challenge: "abc",
				state: "s1",
				action: "UPDATE_PASSWORD",
			}),
		)
		expect(url.searchParams.get("kc_action")).toBe("UPDATE_PASSWORD")
	})
})

/** One origin's localStorage (shared by its tabs) or one tab's sessionStorage. */
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

const pending = (state: string) => ({ verifier: `verifier-${state}`, state, returnTo: "/services" })
const run = <A>(effect: Effect.Effect<A>) => Effect.runSync(effect)

describe("pending OIDC sign-ins", () => {
	beforeEach(() => {
		vi.stubGlobal("localStorage", memoryStorage())
		vi.stubGlobal("sessionStorage", memoryStorage())
	})
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	test("a callback in another tab (an email verification link) finds the sign-in by its state, once", () => {
		run(savePendingSignIn(pending("s-tab-a")))
		run(savePendingSignIn(pending("s-other")))
		// A new tab has an empty sessionStorage; the pending sign-in lives in the shared localStorage.
		vi.stubGlobal("sessionStorage", memoryStorage())
		expect(run(takePendingSignIn("s-tab-a"))).toEqual(Option.some(pending("s-tab-a")))
		expect(run(takePendingSignIn("s-tab-a"))).toEqual(Option.none())
		expect(run(takePendingSignIn("s-other"))).toEqual(Option.some(pending("s-other")))
	})

	test("an unknown state finds nothing", () => {
		run(savePendingSignIn(pending("s1")))
		expect(run(takePendingSignIn("forged"))).toEqual(Option.none())
	})

	test("a sign-in older than 10 minutes has expired, and the next save sweeps it", async () => {
		await Effect.gen(function* () {
			yield* TestClock.setTime(Date.parse("2026-11-17T10:00:00Z"))
			yield* savePendingSignIn(pending("old"))
			yield* savePendingSignIn(pending("kept"))
			yield* TestClock.adjust("11 minutes")
			expect(yield* takePendingSignIn("kept")).toEqual(Option.none())
			yield* savePendingSignIn(pending("new"))
		}).pipe(Effect.provide(TestClock.layer()), Effect.runPromise)
		expect(localStorage.getItem("maple.oidc.pending.old")).toBeNull()
		expect(localStorage.getItem("maple.oidc.pending.new")).not.toBeNull()
	})

	test("a tab restarts an unknown sign-in once; the next miss is an error, and resets the guard", () => {
		expect(run(claimSignInRestart)).toBe(true)
		expect(run(claimSignInRestart)).toBe(false)
		expect(run(claimSignInRestart)).toBe(true)
	})

	test("storage that throws never allows a restart", () => {
		vi.stubGlobal("sessionStorage", {
			getItem: () => {
				throw new DOMException("blocked", "SecurityError")
			},
		})
		expect(run(claimSignInRestart)).toBe(false)
	})
})
