import { Duration, Option, Schema, String as Str } from "effect"
import * as Predicate from "effect/Predicate"

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

const decodeBase64Url = (segment: string): string => {
	const padded = Str.replace(/_/g, "/")(Str.replace(/-/g, "+")(segment))
	return atob(Str.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "=")(padded))
}

/** A JWT's payload claims, unverified; undefined if the token isn't one we can read. */
const readJwtClaims = (token: string): Readonly<Record<string, unknown>> | undefined => {
	const segments = Str.split(".")(token)
	if (segments.length !== 3 || segments[1] === undefined) return undefined
	try {
		const claims = Option.getOrUndefined(decodeJson(decodeBase64Url(segments[1])))
		return Predicate.isObject(claims) ? claims : undefined
	} catch {
		// Not a JWT we can read: the caller treats the token as having no claims.
		return undefined
	}
}

/** A numeric-seconds claim (`exp`, `iat`) in epoch ms. */
const readSecondsClaimMs = (token: string, claim: string): number | undefined => {
	const value = readJwtClaims(token)?.[claim]
	return Predicate.isNumber(value) && Number.isFinite(value) ? value * 1000 : undefined
}

/** Expiry of a JWT in epoch ms, or undefined if the token isn't one we can read. */
export const readJwtExpMs = (token: string): number | undefined => readSecondsClaimMs(token, "exp")

/** Issue time of a JWT in epoch ms, or undefined when it has no numeric `iat`. */
export const readJwtIatMs = (token: string): number | undefined => readSecondsClaimMs(token, "iat")

/** Who and which org a Maple session token speaks for; undefined when it names neither. */
export const readJwtIdentity = (
	token: string,
): { readonly sub: string; readonly orgId: string } | undefined => {
	const claims = readJwtClaims(token)
	return claims !== undefined && Predicate.isString(claims.sub) && Predicate.isString(claims.org_id)
		? { sub: claims.sub, orgId: claims.org_id }
		: undefined
}

const MAX_RENEW_AHEAD_MS = Duration.toMillis(Duration.minutes(2))

/**
 * How long before `exp` to renew: a quarter of the token's own lifetime, at most 2 minutes. The
 * server sets the lifetime, so it is read from `iat`/`exp`; without `iat`, 2 minutes.
 */
export const renewAheadMsOf = (token: string): number => {
	const expiresAt = readJwtExpMs(token)
	const issuedAt = readJwtIatMs(token)
	return expiresAt === undefined || issuedAt === undefined || expiresAt <= issuedAt
		? MAX_RENEW_AHEAD_MS
		: Math.min(MAX_RENEW_AHEAD_MS, (expiresAt - issuedAt) / 4)
}
