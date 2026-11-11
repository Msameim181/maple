// deploy/docker: the Workers have no SMTP, so EmailService POSTs each message here
// (MAPLE_SMTP_BRIDGE_URL) and this hands it to SMTP_URL with curl. Listens on loopback only.
import { unlink } from "node:fs/promises"

interface Message {
	readonly from: string
	readonly to: string
	readonly subject: string
	readonly html: string
	readonly replyTo?: string
	readonly headers?: Record<string, string>
}

const smtpUrl = process.env.SMTP_URL ?? ""
const insecure = process.env.SMTP_INSECURE === "1"
const envelopeFrom = process.env.SMTP_FROM ?? ""

/** Header values never carry a line break: a newline in a subject must not start a new header. */
export const headerValue = (value: string) => value.replace(/[\r\n]+/g, " ")
export const address = (value: string) => /<([^>]+)>/.exec(value)?.[1] ?? value.trim()

export const renderMessage = (m: Message, messageId: string, date: Date) =>
	[
		`From: ${headerValue(m.from)}`,
		`To: ${headerValue(m.to)}`,
		`Subject: ${headerValue(m.subject)}`,
		`Message-ID: ${messageId}`,
		`Date: ${date.toUTCString()}`,
		"MIME-Version: 1.0",
		"Content-Type: text/html; charset=utf-8",
		...(m.replyTo ? [`Reply-To: ${headerValue(m.replyTo)}`] : []),
		...Object.entries(m.headers ?? {}).map(([k, v]) => `${headerValue(k)}: ${headerValue(v)}`),
		"",
		m.html,
	].join("\r\n")

if (import.meta.main) {
	Bun.serve({
		hostname: "127.0.0.1",
		port: Number(process.env.MAIL_BRIDGE_PORT ?? 8725),
		async fetch(request) {
			if (request.method !== "POST") return new Response("POST only", { status: 405 })
			if (!smtpUrl) return new Response("SMTP_URL is not set", { status: 503 })
			const message = (await request.json()) as Message
			const messageId = `<${crypto.randomUUID()}@maple>`
			const file = `/tmp/maple-mail-${crypto.randomUUID()}.eml`
			await Bun.write(file, renderMessage(message, messageId, new Date()))
			const proc = Bun.spawn(
				[
					"curl", "-sS", ...(insecure ? [] : ["--ssl-reqd"]),
					"--url", smtpUrl,
					"--mail-from", address(envelopeFrom || message.from),
					"--mail-rcpt", address(message.to),
					"--upload-file", file,
				],
				{ stdout: "ignore", stderr: "pipe" },
			)
			const exitCode = await proc.exited
			const stderr = await new Response(proc.stderr).text()
			await unlink(file).catch(() => undefined)
			if (exitCode !== 0) {
				console.error(`[mail-bridge] send to ${address(message.to)} failed: ${stderr.trim()}`)
				return new Response(stderr || `curl exited ${exitCode}`, { status: 502 })
			}
			return new Response("sent", { headers: { "x-message-id": messageId } })
		},
	})
	console.log(smtpUrl ? "[mail-bridge] relaying to SMTP" : "[mail-bridge] SMTP_URL unset; email will fail")
}
