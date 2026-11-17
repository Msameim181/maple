import { describe, expect, it } from "vitest"
import { renderInvitation } from "./invitation"

const props = { orgName: "Acme", recipient: "ada@acme.test", signInUrl: "https://maple.acme.test/sign-in" }

describe("renderInvitation", () => {
	it("fills every token and links to sign-in", () => {
		const html = renderInvitation({ ...props, invitedBy: "Grace" })
		expect(html).not.toMatch(/\[\[#?[A-Za-z0-9_]+\]\]/)
		expect(html).toContain("Acme")
		expect(html).toContain("Grace invited you to join")
		expect(html).toContain('href="https://maple.acme.test/sign-in"')
	})

	it("escapes an organization name with markup", () => {
		const html = renderInvitation({ ...props, orgName: "<script>alert(1)</script>" })
		expect(html).not.toContain("<script>")
		expect(html).toContain("&lt;script&gt;")
	})
})
