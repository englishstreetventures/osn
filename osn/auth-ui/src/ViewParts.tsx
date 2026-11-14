import { Button } from "@shared/ui/ui/button";
import { DialogFooter } from "@shared/ui/ui/dialog";
import { Show, type JSX } from "solid-js";

/** What a view is mounted in. See `AuthHeader`. */
export type ViewHost = "dialog" | "page";

/**
 * The size a step's own action takes. In a dialog it is half of the footer's
 * pair, `sm` as Cancel is, 40px tall below `md`: at `sm` every pair the
 * package draws fits a 320px sheet on one line. On a page it keeps Button's
 * own size and spans the column.
 */
export function stepAction(host: ViewHost): { size: "sm" | "default"; class?: string } {
  return host === "dialog" ? { size: "sm", class: "max-md:h-10" } : { size: "default" };
}

export interface ViewStepProps {
  host: ViewHost;
  /** The step's fields, lines and other choices. */
  children: JSX.Element;
  /** The step's one action, sized by `stepAction`. None on a wait. */
  action?: JSX.Element;
  /**
   * The ways back inside the view ("Lost your passkey?", "Back"), each a
   * `StepLink`. Never the dialog's Cancel.
   */
  links?: JSX.Element;
  /**
   * The dialog's Cancel, first in the footer. Absent: no Cancel. Not drawn on
   * a page, whose way back is the title row's (`AuthHeader`). Cancel calls it
   * and closes nothing itself; Escape and a press outside are the host's
   * `onOpenChange`, which should run the same handler.
   */
  onCancel?: () => void;
  /** True while a call the view started runs, so nothing leaves the view meanwhile. */
  cancelDisabled?: boolean;
}

/**
 * One step of a view, laid out for its host. It renders siblings, so a step
 * with a `<form>` wraps the whole of it and Enter in a field still submits.
 *
 * - In a dialog: the body, padded 16px, with the links at its foot; then a
 *   `DialogFooter` (a hairline above, 16px in, right-aligned) holding
 *   Cancel, `secondary`, then the action. A step that commits nothing of its
 *   own passes no action, and Cancel stands alone.
 * - On a page: the body 24px under the title row with no side padding, the
 *   action spanning the column under it, then the links centred under the
 *   action.
 */
export function ViewStep(props: ViewStepProps) {
  return (
    <Show
      when={props.host === "dialog"}
      fallback={
        <div class="flex flex-col gap-4 pt-6">
          {props.children}
          {props.action}
          {props.links}
        </div>
      }
    >
      <div class="flex flex-col gap-4 p-4">
        {props.children}
        {props.links}
      </div>
      {/* Wraps rather than scroll sideways, should a font wider than the
          one measured push a pair past a 320px sheet's 288px. */}
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
        {props.action}
      </DialogFooter>
    </Show>
  );
}

/**
 * A way back inside a view: Button's `link` at `sm`, centred, and 40px tall
 * below `md` in a dialog, as every button in a sheet is.
 */
export function StepLink(props: {
  host: ViewHost;
  onClick: () => void;
  disabled?: boolean;
  children: JSX.Element;
}) {
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      class={props.host === "dialog" ? "self-center max-md:h-10" : "self-center"}
      onClick={() => props.onClick()}
      disabled={props.disabled}
    >
      {props.children}
    </Button>
  );
}
