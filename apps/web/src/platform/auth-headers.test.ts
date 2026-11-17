import { describe, expect, it } from "vitest"
import { readJwtExpMs, readJwtIdentity, renewAheadMsOf } from "./auth-headers"
import { String as Str } from "effect"

const base64Url = (value: string): string =>
	Str.replace(/=+$/, "")(Str.replace(/\//g, "_")(Str.replace(/\+/g, "-")(btoa(value))))

const jwtWithClaims = (claims: unknown): string => `header.${base64Url(JSON.stringify(claims))}.signature`

describe("readJwtExpMs", () => {
	it("reads `exp` seconds as epoch ms", () => {
		expect(readJwtExpMs(jwtWithClaims({ exp: 1_700_000_000, sub: "user_1" }))).toBe(1_700_000_000_000)
	})

	it("has no deadline for a token without a numeric `exp`", () => {
		expect(readJwtExpMs(jwtWithClaims({ sub: "user_1" }))).toBeUndefined()
		expect(readJwtExpMs(jwtWithClaims({ exp: "soon" }))).toBeUndefined()
	})

	it("has no deadline for an opaque or malformed token", () => {
		expect(readJwtExpMs("opaque-session-token")).toBeUndefined()
		expect(readJwtExpMs("header.!!not-base64!!.signature")).toBeUndefined()
		expect(readJwtExpMs(`header.${base64Url("[1, 2]")}.signature`)).toBeUndefined()
	})
})

describe("renewAheadMsOf", () => {
	const issuedAt = 1_700_000_000

	it("renews 2 minutes ahead of a 10-minute token", () => {
		expect(renewAheadMsOf(jwtWithClaims({ iat: issuedAt, exp: issuedAt + 600 }))).toBe(120_000)
	})

	it("renews a quarter of the lifetime ahead of a short token, not on every request", () => {
		expect(renewAheadMsOf(jwtWithClaims({ iat: issuedAt, exp: issuedAt + 120 }))).toBe(30_000)
	})

	it("falls back to 2 minutes for a token without `iat`", () => {
		expect(renewAheadMsOf(jwtWithClaims({ exp: issuedAt + 120 }))).toBe(120_000)
	})
})

describe("readJwtIdentity", () => {
	it("reads the user and org a session token speaks for", () => {
		expect(readJwtIdentity(jwtWithClaims({ sub: "user_1", org_id: "org_1", exp: 1 }))).toEqual({
			sub: "user_1",
			orgId: "org_1",
		})
	})

	it("names no identity for a token missing either claim", () => {
		expect(readJwtIdentity(jwtWithClaims({ sub: "user_1" }))).toBeUndefined()
		expect(readJwtIdentity("opaque-session-token")).toBeUndefined()
	})
})
