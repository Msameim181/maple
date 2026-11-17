import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "./button"
import type * as Dialog from "./dialog"
import * as DialogView from "./dialog-view"
import { formDialogPanelStyles } from "./form-dialog.styles"

// A read-only dialog over the dialog Submodel: a title, some content and one Close button. The
// parent owns the Model (`Dialog.init(id, "dialog")`) and opens it with `Dialog.open`.

export type InfoDialogOptions<M> = Readonly<{
	slotId: string
	model: Dialog.Model
	toParentMessage: (message: Dialog.Message) => M
	title: string
	description?: string
	closeLabel?: string
	className?: string
	children: ReadonlyArray<Html>
}>

/** A read-only dialog with a Close button, opened from code and placed anywhere in the page. */
export const infoDialog = <M>(h: HtmlBuilder<M>, options: InfoDialogOptions<M>): Html => {
	const id = options.model.id
	return h.submodel({
		slotId: options.slotId,
		model: options.model,
		view: DialogView.view,
		toParentMessage: options.toParentMessage,
		viewInputs: {
			hasTrigger: false,
			className: options.className,
			hasDescription: options.description !== undefined,
			toView: ({ portal }) => portal ?? h.empty,
			toContent: (close) => [
				DialogView.dialogHeader(h, "dialog", [
					DialogView.dialogTitle(h, "dialog", id, options.title),
					...(options.description === undefined
						? []
						: [DialogView.dialogDescription(h, "dialog", id, options.description)]),
				]),
				DialogView.dialogPanel(h, "dialog", id, options.children, cn(formDialogPanelStyles)),
				DialogView.dialogFooter(h, "dialog", [
					button(h, { variant: "outline", attributes: close }, [options.closeLabel ?? "Close"]),
				]),
			],
		},
	})
}
