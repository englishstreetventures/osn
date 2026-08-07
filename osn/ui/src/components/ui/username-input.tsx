import { clsx } from "clsx";
import { Show, splitProps, type Component, type ComponentProps } from "solid-js";

import { Input } from "./input";

/** Availability/validation state of a typed username — mirrors the
 *  register/create-profile handle-check flow this component replaces. */
type UsernameInputStatus = "idle" | "checking" | "available" | "taken" | "invalid" | "error";

interface UsernameInputProps extends Omit<ComponentProps<"input">, "value" | "onInput" | "class"> {
  value: string;
  onInput: (value: string) => void;
  status?: UsernameInputStatus;
  /** Shown when `status` is "invalid" — the format rule is the caller's
   *  (handles vs. some other username-shaped field), so there's no default. */
  invalidMessage?: string;
  /** Class for the outer "@" + input row, not the input itself. */
  class?: string;
}

/**
 * A username/handle field: a fixed "@" ahead of the box, wired to an optional
 * debounced-availability `status`. Used wherever OSN asks someone to type or
 * confirm a handle, so the leading "@" and the checking/available/taken/
 * invalid states look and behave the same on every form that asks for one.
 */
const UsernameInput: Component<UsernameInputProps> = (props) => {
  const [local, others] = splitProps(props, [
    "value",
    "onInput",
    "status",
    "invalidMessage",
    "class",
  ]);
  const status = () => local.status ?? "idle";

  return (
    <div class="base:flex base:flex-col base:gap-1">
      <div class={clsx("base:flex base:items-center base:gap-2", local.class)}>
        <span class="base:text-muted-foreground" aria-hidden="true">
          @
        </span>
        <Input
          type="text"
          autocomplete="username"
          value={local.value}
          onInput={(e) => local.onInput(e.currentTarget.value)}
          class="base:flex-1"
          {...others}
        />
      </div>
      <Show when={status() === "checking"}>
        <span class="base:text-muted-foreground base:text-xs">Checking…</span>
      </Show>
      <Show when={status() === "available"}>
        <span class="base:text-xs base:text-green-600">@{local.value} is available</span>
      </Show>
      <Show when={status() === "taken"}>
        <span class="base:text-destructive base:text-xs">@{local.value} is taken</span>
      </Show>
      <Show when={status() === "invalid" && local.invalidMessage}>
        <span class="base:text-destructive base:text-xs">{local.invalidMessage}</span>
      </Show>
      <Show when={status() === "error"}>
        <span class="base:text-destructive base:text-xs">
          Couldn&apos;t check availability — try again
        </span>
      </Show>
    </div>
  );
};

export { UsernameInput };
export type { UsernameInputProps, UsernameInputStatus };
