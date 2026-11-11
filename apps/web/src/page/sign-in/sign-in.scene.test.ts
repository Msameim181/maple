import {
	click,
	Command,
	expect,
	expectNoOutMessage,
	expectOutMessage,
	given,
	label,
	role,
	scene,
	submit,
	text,
	type SceneSimulation,
	type,
	within,
} from "foldkit/scene"
import { describe, test } from "vitest"
import {
	BeginOidcSignIn,
	CompleteOidcSignIn,
	enter,
	init,
	LoadOidcConfig,
	Message,
	OutMessage,
	SignInFailure,
	SignInWithRootPassword,
	update,
	view,
} from "./index"

const passwordField = label("Root password")
const signInButton = role("button", { name: "Sign in" })
const form = role("form")

describe("self-hosted sign-in", () => {
	test("typing the password fills the field and marks it dirty", () => {
		scene(
			{ update, view },
			given(init()),
			expect(passwordField).toHaveValue(""),
			type(passwordField, "hunter2"),
			expect(passwordField).toHaveValue("hunter2"),
			expect(passwordField).toHaveAttr("data-filled", ""),
			expect(passwordField).toHaveAttr("data-dirty", ""),
			expect(passwordField).not.toHaveAttr("aria-invalid"),
		)
	})

	test("a successful sign-in shows the loading button, then hands the token to the root", () => {
		scene(
			{ update, view },
			given(init()),
			type(passwordField, "correct-horse"),
			submit(form),
			Command.expectExact(SignInWithRootPassword({ password: "correct-horse" })),
			expect(signInButton).toBeDisabled(),
			expect(signInButton).toHaveAttr("data-loading", ""),
			expect(passwordField).toBeDisabled(),
			Command.resolve(
				SignInWithRootPassword,
				Message.SucceededSignInWithRootPassword({ token: "session-token" }),
			),
			expectOutMessage(OutMessage.SucceededSignIn({ token: "session-token" })),
		)
	})

	test("a rejected password shows the API's message and keeps the form usable", () => {
		scene(
			{ update, view },
			given(init()),
			type(passwordField, "wrong"),
			submit(form),
			Command.resolve(
				SignInWithRootPassword,
				Message.FailedSignInWithRootPassword({
					failure: SignInFailure.Rejected({ message: "Invalid root password" }),
				}),
			),
			expectNoOutMessage(),
			expect(within(form, role("alert"))).toHaveText("Invalid root password"),
			expect(passwordField).toHaveAttr("aria-invalid", "true"),
			expect(signInButton).toBeEnabled(),
			expect(passwordField).toBeEnabled(),
		)
	})

	test("an unreachable API shows the browser's fetch failure, like apps/web", () => {
		scene(
			{ update, view },
			given(init()),
			type(passwordField, "anything"),
			submit(form),
			Command.resolve(
				SignInWithRootPassword,
				Message.FailedSignInWithRootPassword({ failure: SignInFailure.Unreachable() }),
			),
			expect(text("Couldn't reach the server")).toExist(),
		)
	})
})

/** Entering `/sign-in`: the page's model with the Commands `enter` sends, as the root runs them. */
const entered = (search: Parameters<typeof enter>[1]) => {
	const step = enter(init(), search)
	return [
		given(step.model),
		<M, Msg, Out>(simulation: SceneSimulation<M, Msg, Out>) => ({
			...simulation,
			commands: [...simulation.commands, ...(step.commands ?? [])],
		}),
	] as const
}

const ssoButton = role("button", { name: "Sign in with SSO" })
const oidc = { authorizeUrl: "https://id.example.com/auth", clientId: "maple" }

describe("OIDC sign-in", () => {
	test("with a provider configured, SSO leads and the root password sits behind a toggle", () => {
		scene(
			{ update, view },
			...entered({}),
			Command.resolve(LoadOidcConfig, Message.LoadedOidcConfig({ oidc })),
			expect(ssoButton).toExist(),
			expect(passwordField).not.toExist(),
			click(role("button", { name: "Use root password" })),
			expect(passwordField).toExist(),
			expect(ssoButton).not.toExist(),
		)
	})

	test("without a provider, only the root-password form shows", () => {
		scene(
			{ update, view },
			...entered({}),
			Command.resolve(LoadOidcConfig, Message.LoadedOidcConfig({ oidc: null })),
			expect(ssoButton).not.toExist(),
			expect(passwordField).toExist(),
		)
	})

	test("clicking SSO starts the PKCE redirect to the configured provider", () => {
		scene(
			{ update, view },
			given({ ...init(), oidc }),
			click(ssoButton),
			Command.expectExact(BeginOidcSignIn(oidc)),
			expect(ssoButton).toHaveAttr("data-loading", ""),
			Command.resolve(BeginOidcSignIn, Message.RedirectedToSso()),
		)
	})

	test("the provider's callback redeems the code and hands the token and return path to the root", () => {
		scene(
			{ update, view },
			...entered({ code: "abc", state: "s1" }),
			Command.resolve(LoadOidcConfig, Message.LoadedOidcConfig({ oidc })),
			Command.resolve(
				CompleteOidcSignIn({ code: "abc", state: "s1" }),
				Message.SucceededSignInWithSso({ token: "oidc-token", returnTo: "/services" }),
			),
			expectOutMessage(OutMessage.SucceededSignIn({ token: "oidc-token", returnTo: "/services" })),
		)
	})

	test("an account with no organization is told to ask for an invitation", () => {
		scene(
			{ update, view },
			...entered({ code: "abc", state: "s1" }),
			Command.resolve(LoadOidcConfig, Message.LoadedOidcConfig({ oidc })),
			Command.resolve(
				CompleteOidcSignIn({ code: "abc", state: "s1" }),
				Message.FailedSignInWithSso({ failure: SignInFailure.NoOrganization() }),
			),
			expectNoOutMessage(),
			expect(role("alert")).toHaveText(
				"Your account is not a member of any organization yet. Ask your administrator for an invitation.",
			),
			expect(ssoButton).toBeEnabled(),
		)
	})
})
