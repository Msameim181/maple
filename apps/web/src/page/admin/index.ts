import { definePage } from "../contract"
import { Message, Model } from "./model"
import { init, update } from "./update"
import { breadcrumbs, view } from "./view"

/** `/admin`: the self-hosted directory's organizations and users, for root. */
export const page = definePage(
	"Admin",
	{ Model, Message },
	{ routes: ["Admin"], init, update, view, breadcrumbs },
)
