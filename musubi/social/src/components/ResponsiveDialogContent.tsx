import { DialogContent } from "@shared/ui/ui/dialog";
import { type ComponentProps, type ParentComponent } from "solid-js";

/**
 * The app's dialog, in its mobile face.
 *
 * Every dialog in `@musubi/social` is a bottom sheet below `md` and a centred
 * card at `md` and up, so the choice is made here once rather than at each of
 * the six call sites. `DialogContent`'s `presentation` variant is what draws it:
 * the anchor, the squared bottom corners, the `--ui-radius-sheet` grip and the
 * safe-area inset only mean anything together, which is why they are one name
 * rather than a class string a call site can get two-thirds right.
 */
export const ResponsiveDialogContent: ParentComponent<ComponentProps<"div">> = (props) => {
  return <DialogContent presentation="sheet" {...props} />;
};
