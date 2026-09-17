import { Input, type InputProps } from "@shared/ui/ui/input";
import { splitProps } from "solid-js";

/**
 * A text input for an OSN handle, with a fixed "@" shown ahead of the box —
 * the same affordance `@shared/ui`'s own `UsernameInput` gives the identity app,
 * so a handle looks the same wherever someone types one across the platform.
 *
 * ## Why this is not that component
 *
 * Not the token vocabulary — both read the contract. The API. `@shared/ui`'s is
 * controlled — `value: string` plus `onInput: (value: string) => void`, with a
 * debounced availability `status` it renders itself. This one takes raw input
 * props, because its one call site is a combobox: it spreads `role`,
 * `aria-expanded`, `aria-controls`, `aria-autocomplete` and a live
 * `aria-activedescendant` onto the box, and drives its own suggestion list.
 *
 * Two shapes for one idea is worth one of them being thirteen lines. Collapsing
 * them means giving the shared component a combobox mode, which is a larger
 * change than the duplication costs.
 *
 * The typed value never carries the "@" itself — callers get back the bare
 * handle, and the "@" is decoration that can't be deleted or pasted over.
 */
export type UsernameInputProps = InputProps;

export function UsernameInput(props: UsernameInputProps) {
  const [own, rest] = splitProps(props, ["class"]);
  return (
    <div class={`base:flex base:items-center base:gap-2${own.class ? ` ${own.class}` : ""}`}>
      <span
        class="base:font-ui-body base:text-ui-ink-secondary base:text-ui-base"
        aria-hidden="true"
      >
        @
      </span>
      <Input {...rest} class="base:flex-1" />
    </div>
  );
}
