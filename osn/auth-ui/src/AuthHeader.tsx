import { Button } from "@shared/ui/ui/button";
import { DialogHeader, DialogTitle } from "@shared/ui/ui/dialog";
import { Match, Show, Switch } from "solid-js";

export interface AuthHeaderProps {
  /**
   * The view's title, such as "Sign in to Musubi". A view whose title changes
   * (`SignIn`'s "Recover your account") passes the new one here; it never
   * mounts a second header.
   */
  title: string;
  /**
   * What the view is mounted in. Required: neither can stand in for the other.
   *
   * - `"dialog"`: inside `@shared/ui`'s `Dialog`. The title is the dialog's
   *   `DialogTitle` in a `DialogHeader`, so the dialog takes its name from it.
   *   Throws outside a `Dialog`. A dialog holds one of these at a time: every
   *   `DialogTitle` in one dialog gets the same id, so two at once share it,
   *   and when either goes the dialog is left with no name.
   * - `"page"`: on a page, such as `/authorize`. The title is a plain `h2` in
   *   the dialog title's type, and the row draws no padding or rule, so the
   *   page's own heading above it leads.
   */
  host: "dialog" | "page";
  /** Called by Cancel. Absent: no Cancel. */
  onCancel?: () => void;
  /** Cancel's words, for a host where going back means something else ("Sign in instead"). Default "Cancel". */
  cancelLabel?: string;
  /** True while a call the view started runs, so nothing leaves the view meanwhile. */
  cancelDisabled?: boolean;
}

/**
 * The title row of a sign-in or create-account view: its title, and Cancel at
 * the row's end when the host gives one. Cancel calls `onCancel` and closes
 * nothing itself; in a dialog, Escape and a press outside are the host's
 * `onOpenChange`, which should run the same handler.
 */
export function AuthHeader(props: AuthHeaderProps) {
  const cancel = () => (
    <Show when={props.onCancel}>
      {(onCancel) => (
        <Button
          type="button"
          // A dialog's dismiss button is `secondary`. On a page it switches
          // views rather than dismissing anything, so it is `ghost`.
          variant={props.host === "dialog" ? "secondary" : "ghost"}
          size="sm"
          class="shrink-0 max-md:h-10"
          disabled={props.cancelDisabled}
          onClick={() => onCancel()()}
        >
          {props.cancelLabel ?? "Cancel"}
        </Button>
      )}
    </Show>
  );

  return (
    <Switch>
      <Match when={props.host === "dialog"}>
        <DialogHeader class="gap-3">
          {/* The host's product name sits in the title, so it breaks anywhere
              rather than widen the sheet. */}
          <DialogTitle>
            <span class="wrap-anywhere">{props.title}</span>
          </DialogTitle>
          {cancel()}
        </DialogHeader>
      </Match>
      <Match when={props.host === "page"}>
        <div class="flex items-center justify-between gap-3">
          {/* DialogTitle's own type (`shared/ui/src/ui/dialog.tsx`), so the
              title reads the same in both hosts. Change the two together. */}
          <h2 class="text-ui-ink text-ui-md font-ui-title wrap-anywhere">{props.title}</h2>
          {cancel()}
        </div>
      </Match>
    </Switch>
  );
}
