/**
 * Runtime renderer for the organization invitation email.
 *
 * The markup lives in `templates/` and is compiled to `src/generated/invitation.ts`
 * (`bun run --cwd packages/email build`). Every value is HTML-escaped by `fill`.
 */
import { PAGE } from "./generated/invitation"
import { escapeHtml } from "@maple/strings"
import { fill, preheaderPadding, truncate } from "./template"

export interface InvitationProps {
	orgName: string
	/** The invited address, shown so the person signs in with the right one. */
	recipient: string
	/** Where the button goes: the sign-in page. */
	signInUrl: string
	/** Who sent the invitation, when known. */
	invitedBy?: string
	/** The deployment's or company's name for the header and footer. Defaults to "Maple". */
	brandName?: string
}

export function renderInvitation(props: InvitationProps): string {
	const orgName = truncate(props.orgName, 80)
	const previewText = `You're invited to ${orgName} on Maple`
	const lead =
		props.invitedBy === undefined || props.invitedBy === ""
			? "You've been invited to join"
			: `${truncate(props.invitedBy, 60)} invited you to join`
	return fill(
		PAGE,
		{
			previewText,
			brandName: props.brandName ?? "Maple",
			lead,
			orgName,
			recipient: props.recipient,
			signInUrl: props.signInUrl,
		},
		{ preheaderPad: escapeHtml(preheaderPadding(previewText)) },
	)
}
