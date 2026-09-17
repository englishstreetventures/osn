/**
 * Mobile presentation of the composed preview. The builder's wide layout keeps
 * `PreviewPane` sticky beside the form; below that breakpoint there's no room
 * for a side-by-side column, so the "Preview" button next to the section tabs
 * opens the SAME `PreviewPane` here instead — one preview, two presentations,
 * never two markup sources to drift apart.
 *
 * ## It used to portal, and that is the point of the change
 *
 * This was a `fixed inset-0 z-50` scrim inside a `<Portal>`, and its own
 * comment explained why: the dashboard shell sets `container-type` on its
 * layout boxes, which brings `contain: layout` with it and makes them the
 * containing block for `position: fixed` descendants. That is the trap — a
 * fixed overlay that is only fixed relative to a panel somewhere up the tree.
 *
 * `Modal` renders in the top layer, which is outside the document's stacking
 * contexts entirely, so there is nothing to escape from: no portal, no
 * `z-index`, no scrim element. The focus trap, Escape and the backdrop arrive
 * with it, and this dialog had none of the three.
 */

import Button from "@cire/ui/button";
import { Modal } from "@shared/ui/ui/modal";

import PreviewPane, { type PreviewPaneProps } from "./PreviewPane";

export default function PreviewModal(
  props: PreviewPaneProps & { open: boolean; onClose: () => void },
) {
  return (
    // `aria-label` and not `labelledBy`: the heading below is an eyebrow ("Live
    // preview"), and `PreviewPane`'s own figure already carries an "Invite
    // preview" name. Two elements sharing one accessible name would make
    // `getByLabelText("Invite preview")` ambiguous whenever this modal and the
    // sticky side pane are mounted together.
    <Modal
      open={props.open}
      onClose={props.onClose}
      label="Invite preview modal"
      class="flex max-w-sm flex-col gap-4"
    >
      <div class="flex items-center justify-between gap-2">
        <p class="font-body text-gold text-ui-xs tracking-ui-widest uppercase">Live preview</p>
        <Button variant="bare" type="button" onClick={props.onClose}>
          Close
        </Button>
      </div>
      <PreviewPane {...props} />
    </Modal>
  );
}
