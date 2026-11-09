import type { JSX } from "solid-js";

/**
 * A button that reads as part of the sentence it ends — "Lost your passkey?"
 * in a sign-in error, "Try again" in a failed load. It keeps the line's ink
 * and is told apart by its underline, so the line stays one tone and the
 * action never relies on colour alone. Internal to this package.
 */
export function InlineAction(props: { onClick: () => void; children: JSX.Element }) {
  return (
    <button
      type="button"
      class="focus-visible:ring-ui-focus cursor-pointer font-medium underline underline-offset-4 focus-visible:ring-2 focus-visible:outline-hidden"
      onClick={() => props.onClick()}
    >
      {props.children}
    </button>
  );
}
