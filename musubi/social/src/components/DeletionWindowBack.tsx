import { describeAuthError } from "@osn/client";
import { Notice } from "@shared/ui/ui/notice";
import { Show } from "solid-js";

// Back to the app, as the deletion screen on `/authorize` draws it: in the
// screen itself (`DeletionWindow`), and on the card the consent page draws
// when the screen's code fails to load (`AuthorizePage`). Its own module, so
// both lazy chunks share it and the entry chunk carries none of it.

/**
 * Back to the app's label: "Taking you back…" while it leaves, the words the
 * page shows once it has; else the app's name, cut short with an ellipsis
 * rather than wrap or spill out of the card, since the full name heads the
 * page above it. The words stay whole for a screen reader.
 */
export function BackLabel(props: { name: string; leaving: boolean }) {
  return (
    <Show when={!props.leaving} fallback="Taking you back…">
      <span class="truncate">
        Back to <span translate="no">{props.name}</span>
      </span>
    </Show>
  );
}

/**
 * Why Back did not leave: the app's name, which is its own words, so it
 * breaks anywhere and a page translator leaves it; then the copy map's
 * sentence for the failure, never the error's own text.
 */
export function BackError(props: { name: string; error: unknown }) {
  return (
    <Show when={props.error}>
      {(error) => (
        <Notice tone="danger" size="inline" alert>
          Couldn't go back to{" "}
          <span class="wrap-anywhere" translate="no">
            {props.name}
          </span>
          . {describeAuthError(error())}
        </Notice>
      )}
    </Show>
  );
}
