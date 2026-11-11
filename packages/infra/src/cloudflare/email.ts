/**
 * The `send_email` binding for api and alerting, on prd only: other stages run the same crons
 * against live data and would email real users twice.
 */
import * as Cloudflare from "@alchemy.run/cloudflare"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { NOTIFICATIONS_SENDER_ADDRESS } from "../env.ts"
import { prdOnlyBinding } from "./stack.ts"
import { dischargeRuntimeContext } from "./worker-runtime.ts"

/**
 * Self-hosted (deploy/docker) sends mail too: alchemy's local runtime writes each message to disk
 * and the container's relay hands it to SMTP. Read at plan time; the bundle never sees the env.
 */
// @effect-diagnostics-next-line processEnv:off -- sync config read at alchemy plan time
const isSelfhost = process.env.MAPLE_SELFHOST === "1"
// @effect-diagnostics-next-line processEnv:off -- sync config read at alchemy plan time
const emailFrom = process.env.EMAIL_FROM ?? ""
const selfhostSender = /<([^>]+)>/.exec(emailFrom)?.[1] ?? emailFrom

export const NotificationsEmail = Cloudflare.Email.SendEmail("email", {
	allowedSenderAddresses: [isSelfhost && selfhostSender ? selfhostSender : NOTIFICATIONS_SENDER_ADDRESS],
})

const bindEmail = Effect.flatMap(NotificationsEmail, (email) => Cloudflare.Email.Send(email))
const readEmail = (client: Effect.Success<typeof bindEmail>) =>
	Effect.map(dischargeRuntimeContext(client.raw), (raw: unknown) =>
		raw === undefined || raw === null ? Option.none() : Option.some(client),
	)

/** Yield from a Worker init with `Cloudflare.Email.SendBinding` provided; `None` off prd or unbound. */
export const bindNotificationsEmail = isSelfhost
	? Effect.gen(function* () {
			const client = yield* bindEmail
			if (!globalThis.__ALCHEMY_RUNTIME__) return Option.none<typeof client>()
			return yield* readEmail(client)
		})
	: prdOnlyBinding(bindEmail, readEmail)
