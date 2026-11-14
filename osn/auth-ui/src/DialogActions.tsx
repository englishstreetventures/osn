import { Button } from "@shared/ui/ui/button";
import { DialogFooter } from "@shared/ui/ui/dialog";
import { Show, type JSX } from "solid-js";

export interface DialogActionsProps {
  /**
   * The dialog's Cancel, first in the footer. Absent: no Cancel. It calls
   * this and closes nothing itself; Escape and a press outside are the host's
   * `onOpenChange`, which should run the same handler.
   */
  onCancel?: () => void;
  /** True while a call the dialog started runs, so nothing leaves it meanwhile. */
  cancelDisabled?: boolean;
  /**
   * The step's one action, after Cancel: Button at `size="sm"` with
   * `class="max-md:h-10"`, as Cancel is. None where the dialog commits
   * nothing of its own, and Cancel stands alone.
   */
  children?: JSX.Element;
}

/**
 * Every dialog's footer, in `@osn/auth-ui` and in its host alike: a
 * `DialogFooter` (a hairline above, 16px in, right-aligned) holding Cancel,
 * `secondary` and `sm`, 40px tall below `md`, then the step's one action.
 * At `sm` every pair the package and Musubi draw fits a 320px sheet's 288px
 * on one line; the footer wraps rather than scroll sideways should a wider
 * font push a pair past it.
 */
export function DialogActions(props: DialogActionsProps) {
  return (
    <DialogFooter class="flex-wrap">
      <Show when={props.onCancel}>
        {(onCancel) => (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            class="max-md:h-10"
            disabled={props.cancelDisabled}
            onClick={() => onCancel()()}
          >
            Cancel
          </Button>
        )}
      </Show>
      {props.children}
    </DialogFooter>
  );
}
