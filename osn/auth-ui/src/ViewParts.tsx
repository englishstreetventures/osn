import { Button } from "@shared/ui/ui/button";
import { children as resolveChildren, Show, type JSX } from "solid-js";

import { DialogActions } from "./DialogActions";

/** What a view is mounted in. See `AuthHeader`. */
export type ViewHost = "dialog" | "page";

type StepActionSize = Readonly<{ size: "sm" | "default"; class?: string }>;
const DIALOG_ACTION: StepActionSize = { size: "sm", class: "max-md:h-10" };
const PAGE_ACTION: StepActionSize = { size: "default" };

/**
 * The size a step's own action takes. In a dialog it is half of the footer's
 * pair, `sm` as Cancel is, 40px tall below `md`: at `sm` every pair the
 * package draws fits a 320px sheet on one line. On a page it keeps Button's
 * own size and spans the column. One object per host, never a new one: a
 * spread call in JSX runs again on every read of the props it supplies.
 */
export function stepAction(host: ViewHost): StepActionSize {
  return host === "dialog" ? DIALOG_ACTION : PAGE_ACTION;
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
 * - In a dialog: the body, padded 16px, with the links at its foot; then
 *   `DialogActions`, Cancel first and the action after it. A step that
 *   commits nothing of its own passes no action, and Cancel stands alone; a
 *   step with neither (a done line, which the host closes) draws no footer,
 *   and a body in which nothing shows draws no padded band.
 * - On a page: the body 24px under the title row with no side padding, the
 *   action spanning the column under it, then the links centred under the
 *   action.
 */
export function ViewStep(props: ViewStepProps) {
  // Resolved once each, so the dialog can tell an empty body from a full one
  // and nothing in it is built twice.
  const body = resolveChildren(() => props.children);
  const links = resolveChildren(() => props.links);
  const shown = () => body.toArray().length > 0 || links.toArray().length > 0;
  return (
    <Show
      when={props.host === "dialog"}
      fallback={
        <div class="flex flex-col gap-4 pt-6">
          {body()}
          {props.action}
          {links()}
        </div>
      }
    >
      <Show when={shown()}>
        <div class="flex flex-col gap-4 p-4">
          {body()}
          {links()}
        </div>
      </Show>
      <Show when={props.onCancel || props.action}>
        <DialogActions onCancel={props.onCancel} cancelDisabled={props.cancelDisabled}>
          {props.action}
        </DialogActions>
      </Show>
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
