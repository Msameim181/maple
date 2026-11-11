import { Effect } from "effect"
import { describe, expect, test } from "vitest"
import { authorizeUrlOf, codeChallengeOf, randomToken } from "./oidc"

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
	})
})
