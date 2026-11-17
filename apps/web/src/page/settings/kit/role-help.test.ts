import * as Policy from "@maple/domain/policy"
import { Array as Arr, Option } from "effect"
import { describe, expect, it } from "vitest"
import { roleScopes, summaryOfRoleKey } from "./role-help"

const addsOf = (role: Policy.Role) =>
	Option.match(
		Arr.findFirst(roleScopes, (scope) => scope.role === role),
		{ onNone: () => [], onSome: (scope) => scope.adds },
	)

describe("roleScopes", () => {
	it("lists every permission under exactly one role", () => {
		expect(Arr.flatMap(roleScopes, (scope) => scope.adds)).toHaveLength(Policy.allPermissions.length)
	})
	it("puts managing members under Admin only", () => {
		expect(addsOf("admin")).toContain("Manage members")
		expect(addsOf("engineer")).not.toContain("Manage members")
	})
	it("reads a summary by Clerk key", () => {
		expect(summaryOfRoleKey("org:admin")).toContain("billing")
		expect(summaryOfRoleKey("nope")).toBe("")
	})
})
