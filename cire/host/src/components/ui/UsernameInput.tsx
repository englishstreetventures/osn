import { splitProps } from "solid-js";

import { Input, type InputProps } from "./Field";

/**
 * A text input for an OSN handle, with a fixed "@" shown ahead of the box —
 * the same affordance `@osn/ui`'s `UsernameInput` gives the identity app, so
 * a handle looks the same wherever someone types one across the platform.
 * The portal doesn't share that component directly (it has its own token
 * classes, not Zaidan's), so this is a local port of the same idea onto
 * `Field`'s `Input`.
 *
 * The typed value never carries the "@" itself — callers get back the bare
 * handle, and the "@" is decoration that can't be deleted or pasted over.
 */
export type UsernameInputProps = InputProps;

export function UsernameInput(props: UsernameInputProps) {
  const [own, rest] = splitProps(props, ["class"]);
  return (
    <div class={`flex items-center gap-2${own.class ? ` ${own.class}` : ""}`}>
      <span class="font-body text-text-muted text-[0.95rem]" aria-hidden="true">
        @
      </span>
      <Input {...rest} class="flex-1" />
    </div>
  );
}
