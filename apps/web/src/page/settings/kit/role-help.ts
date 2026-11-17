import * as Policy from "@maple/domain/policy"
import { Array as Arr, Option, Record as Rec, String as Str } from "effect"

/** One role's row in the "What can each role do?" dialog. */
export type RoleScope = Readonly<{
	role: Policy.Role
	label: string
	/** One sentence, hand-written in the policy. */
	summary: string
	/** What this role adds over the one below, generated from `Policy.permissions`. */
	adds: ReadonlyArray<string>
}>

/** "manage integrations" as "Manage integrations". */
const sentence = (action: string): string => Str.capitalize(action)

/** Each assignable role with the permissions whose lowest role it is, so the text follows the policy. */
export const roleScopes: ReadonlyArray<RoleScope> = Arr.map(Policy.assignableRoles, (entry) => ({
	role: entry.role,
	label: entry.label,
	summary: entry.summary,
	adds: Arr.map(
		Arr.filter(Rec.values(Policy.permissions), (permission) => permission.min === entry.role),
		(permission) => sentence(permission.action),
	),
}))

/** The summary shown under a role in a select, by its Clerk key. */
export const summaryOfRoleKey = (key: string): string =>
	Option.match(
		Arr.findFirst(Policy.assignableRoles, (entry) => entry.clerkKey === key),
		{ onNone: () => "", onSome: (entry) => entry.summary },
	)
