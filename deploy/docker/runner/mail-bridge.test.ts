import { expect, test } from "bun:test"
import { address, renderMessage } from "./mail-bridge"

test("a line break in a header value cannot inject another header", () => {
	const text = renderMessage(
		{ from: "Maple <maple@example.com>", to: "a@b.test", subject: "Hi\r\nBcc: evil@x.test", html: "<p>x</p>" },
		"<id@maple>",
		new Date(0),
	)
	const headers = text.split("\r\n\r\n")[0] ?? ""
	expect(headers).toContain("Subject: Hi Bcc: evil@x.test")
	expect(headers.split("\r\n").some((line) => line.startsWith("Bcc:"))).toBe(false)
})

test("envelope addresses come from angle brackets when present", () => {
	expect(address("Maple <maple@example.com>")).toBe("maple@example.com")
	expect(address(" ops@example.com ")).toBe("ops@example.com")
})
