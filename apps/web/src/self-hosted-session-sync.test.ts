import { OrgId } from "@maple/domain"
import { Effect, Fiber, Option, Schema, Stream, String as Str, Array as Arr } from "effect"
import { describe, expect, test, vi } from "vitest"

// The root's listeners target `window` (an EventTarget is all they need here).
vi.hoisted(() => Object.assign(globalThis, { window: new EventTarget() }))
import { Message } from "./message"
import { ClerkPhase, type Model, Session } from "./model"
import { initCustomer } from "./page/onboarding/plan-gate"
import * as PageHold from "./page/page-hold"
import * as Preload from "./page/preload"
import * as SignIn from "./page/sign-in"
import { SELF_HOSTED_AUTH_EVENT } from "./platform/auth-api"
import { AppRoute } from "./route"
import * as Shell from "./shell"
import { selfHostedSessionChanges } from "./subscription"
import { update } from "./update"
import * as Toast from "@maple/views/ui/toast"
import * as TooltipHost from "@maple/views/ui/tooltip-host"

const TOKEN_KEY = "maple.self_hosted.token"

const base64Url = (value: string): string =>
	Str.replace(/=+$/, "")(Str.replace(/\//g, "_")(Str.replace(/\+/g, "-")(btoa(value))))
const tokenOf = (sub: string, orgId: string, iat: number) =>
	`header.${base64Url(JSON.stringify({ sub, org_id: orgId, iat, exp: iat + 600 }))}.signature`

const storageEvent = (key: string, oldValue: string | null, newValue: string | null) =>
	Object.assign(new Event("storage"), { key, oldValue, newValue })

const alice = tokenOf("user_alice", "org_a", 1_700_000_000)
const aliceRenewed = tokenOf("user_alice", "org_a", 1_700_000_480)
const aliceOtherOrg = tokenOf("user_alice", "org_b", 1_700_000_500)
const bob = tokenOf("user_bob", "org_a", 1_700_000_500)

/** The first `count` session messages while `events` are dispatched (again, until the listeners attach). */
const collect = async (count: number, events: ReadonlyArray<Event>) => {
	const fiber = Effect.runFork(Stream.runCollect(Stream.take(selfHostedSessionChanges, count)))
	const timer = setInterval(() => Arr.forEach(events, (event) => window.dispatchEvent(event)), 10)
	return Effect.runPromise(Fiber.join(fiber)).finally(() => clearInterval(timer))
}

describe("the session token across tabs", () => {
	test("another tab signing in as someone else or switching org reloads; its plain renewal does not", async () => {
		const messages = await collect(2, [
			storageEvent(TOKEN_KEY, alice, aliceRenewed),
			storageEvent("maple.other", alice, bob),
			storageEvent(TOKEN_KEY, alice, bob),
			storageEvent(TOKEN_KEY, alice, aliceOtherOrg),
		])
		expect(messages).toEqual([
			Message.ChangedSessionInOtherTab({ change: "SwitchedIdentity" }),
			Message.ChangedSessionInOtherTab({ change: "SwitchedIdentity" }),
		])
	})

	test("another tab logging out signs this one out; this tab's own rejected renewal re-checks", async () => {
		const messages = await collect(2, [
			storageEvent(TOKEN_KEY, alice, aliceRenewed),
			storageEvent(TOKEN_KEY, alice, null),
			new Event(SELF_HOSTED_AUTH_EVENT),
		])
		expect(messages).toContainEqual(Message.ChangedSessionInOtherTab({ change: "SignedOut" }))
		expect(messages).toContainEqual(Message.ChangedSelfHostedSession())
	})
})

const orgId = Schema.decodeSync(OrgId)("org_a")

const modelAt = (route: AppRoute, session: Session): Model => ({
	route,
	session,
	clerk: ClerkPhase.Unused(),
	signIn: SignIn.init(),
	shell: Shell.init({ isMobile: false, theme: "light", pinnedNamespaces: {}, dashboardFavorites: [] }),
	toasts: Toast.init("toasts"),
	pageHold: PageHold.Model.None(),
	toastActions: {},
	toastRootActions: {},
	tooltip: TooltipHost.init("tooltip"),
	page: null,
	pageInstances: 0,
	parkedPages: [],
	onboarding: null,
	clerkSnapshot: null,
	customer: initCustomer(),
	knownToRenderApp: {},
	preload: Preload.init(),
	sessionTimeRange: null,
	timeZone: "UTC",
})

const loadsOf = (model: Model, change: "SignedOut" | "SwitchedIdentity") =>
	Arr.map(update(model, Message.ChangedSessionInOtherTab({ change })).commands ?? [], ({ name, args }) => ({
		name,
		args,
	}))

describe("a session change in another tab", () => {
	const signedIn = Session.SignedIn({ maybeOrgId: Option.some(orgId) })

	test("a switched user or org reloads the page this tab is on", () => {
		expect(loadsOf(modelAt(AppRoute.Logs({ search: {} }), signedIn), "SwitchedIdentity")).toEqual([
			{ name: "LoadExternal", args: { href: "/logs" } },
		])
	})

	test("a tab waiting on sign-in follows the other tab's sign-in to where it was headed", () => {
		const waiting = modelAt(
			AppRoute.SignIn({ search: { redirect_url: "/services" } }),
			Session.SignedOut(),
		)
		expect(loadsOf(waiting, "SwitchedIdentity")).toEqual([
			{ name: "LoadExternal", args: { href: "/services" } },
		])
	})

	test("a log out sends a signed-in tab to sign-in, and leaves a signed-out one alone", () => {
		expect(loadsOf(modelAt(AppRoute.Logs({ search: {} }), signedIn), "SignedOut")).toEqual([
			{ name: "LoadExternal", args: { href: "/sign-in" } },
		])
		expect(loadsOf(modelAt(AppRoute.SignIn({ search: {} }), Session.SignedOut()), "SignedOut")).toEqual(
			[],
		)
	})
})
