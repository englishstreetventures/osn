import { clsx } from "clsx";
import {
  createEffect,
  createUniqueId,
  For,
  onCleanup,
  onMount,
  splitProps,
  type Component,
} from "solid-js";

type OtpStatus = "idle" | "error" | "verifying" | "accepted";

interface OtpInputProps {
  /** Current value: up to 6 digits, with no gaps. */
  value: string;
  /** Called on every change with the new digit string. */
  onChange: (value: string) => void;
  /** Visual status of the input group. `verifying` and `accepted` disable the boxes. */
  status?: OtpStatus;
  /** Whether all inputs are disabled. */
  disabled?: boolean;
  /** Focus the first box once it is mounted and enabled. */
  autofocus?: boolean;
  /**
   * `id` of the visible label. The group takes it as its name and box N is
   * named "<label> Digit N". Without it the group is "Verification code" and
   * box N "Digit N".
   */
  "aria-labelledby"?: string;
  /** `id`s of the lines that describe the code (its error, a hint), set on every box. */
  "aria-describedby"?: string;
}

const LENGTH = 6;
const INDICES = Array.from({ length: LENGTH });

const onlyDigits = (text: string) => text.replace(/\D/g, "");

/**
 * Six one-digit boxes for a verification code.
 *
 * - **Width.** The group fills its column; the boxes share it and never pass
 *   48px, with 8px between them, so the row fits a 320px phone and from a
 *   328px column up is six 48px squares from the left edge. Height stays 48px.
 * - **Value.** A digit string with no gaps, shown from box 1. Focus that lands
 *   past the first empty box moves to it, and those boxes are out of the Tab
 *   order. Typing over a digit replaces it. Backspace, Delete or a cut on a
 *   digit removes it and the later digits move one box left; Backspace on the
 *   empty box removes the digit before it. A paste, or any insert of more than
 *   one digit (an autofill, a password manager), becomes the whole value.
 * - **Focus.** `autofocus`, and a `status` that turns to `error`, focus box 1
 *   one task later, and only if it is enabled then: callers disable the boxes
 *   while busy and re-enable them in the same synchronous run, and inside a
 *   Kobalte dialog the dialog's own first-focus runs first.
 * - **Error.** While `status` is `error` every box is `aria-invalid`. The
 *   message is the caller's, wired through `aria-describedby`; it must be a
 *   live region, or it is read only when the refocus lands on box 1.
 */
const OtpInput: Component<OtpInputProps> = (props) => {
  const [local] = splitProps(props, [
    "value",
    "onChange",
    "status",
    "disabled",
    "autofocus",
    "aria-labelledby",
    "aria-describedby",
  ]);
  const inputs: HTMLInputElement[] = [];
  const boxId = createUniqueId();

  const status = () => local.status ?? "idle";
  /** The box focus may rest on last: the first empty one, or box 6 when all hold a digit. */
  const lastReachable = () => Math.min(local.value.length, LENGTH - 1);

  let pending: ReturnType<typeof setTimeout> | undefined;
  function focusFirstSoon() {
    clearTimeout(pending);
    pending = setTimeout(() => {
      pending = undefined;
      const first = inputs[0];
      if (first?.isConnected && !first.disabled) first.focus();
    }, 0);
  }
  onCleanup(() => clearTimeout(pending));

  onMount(() => {
    if (local.autofocus) focusFirstSoon();
  });

  createEffect(() => {
    if (status() === "error") focusFirstSoon();
  });

  function focusIndex(i: number) {
    if (i >= 0 && i < LENGTH) inputs[i]?.focus();
  }

  /**
   * Hand `next` to the caller, then set the edited box's own text from it: the
   * caller's update rewrites only the boxes whose digit changed, and the edited
   * box may hold text the value never had ("33", "a").
   */
  function commit(next: string, edited: number, focusAt: number) {
    local.onChange(next);
    const box = inputs[edited];
    if (box) box.value = next[edited] ?? "";
    focusIndex(focusAt);
  }

  function fill(edited: number, digits: string) {
    const next = digits.slice(0, LENGTH);
    commit(next, edited, Math.min(next.length, LENGTH - 1));
  }

  function removeAt(index: number) {
    const current = local.value;
    if (index >= current.length) return;
    commit(current.slice(0, index) + current.slice(index + 1), index, index);
  }

  function handleInput(index: number, e: InputEvent) {
    const box = e.currentTarget as HTMLInputElement;
    const removing = e.inputType?.startsWith("delete") ?? false;
    // Typing and a keyboard's suggestion carry the inserted text in `data`; an
    // autofill or a script that sets the value carries none (null, or "" from
    // some engines), so read the box.
    const incoming = removing ? "" : onlyDigits(e.data || box.value);
    if (incoming.length > 1) return fill(index, incoming);
    if (incoming.length === 1) {
      const current = local.value;
      const at = Math.min(index, current.length);
      const next = current.slice(0, at) + incoming + current.slice(at + 1);
      return commit(next, index, Math.min(at + 1, LENGTH - 1));
    }
    if ((removing || box.value === "") && index < local.value.length) return removeAt(index);
    box.value = local.value[index] ?? "";
  }

  function handleKeyDown(index: number, e: KeyboardEvent) {
    if (e.key === "Backspace") {
      e.preventDefault();
      const current = local.value;
      if (index < current.length) return removeAt(index);
      const previous = Math.min(index, current.length) - 1;
      if (previous >= 0) commit(current.slice(0, previous), index, previous);
    } else if (e.key === "Delete") {
      e.preventDefault();
      removeAt(index);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusIndex(index - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      focusIndex(index + 1);
    }
  }

  function handlePaste(index: number, e: ClipboardEvent) {
    e.preventDefault();
    const pasted = onlyDigits(e.clipboardData?.getData("text") ?? "");
    if (pasted) fill(index, pasted);
  }

  function handleFocus(index: number) {
    const reachable = lastReachable();
    if (index > reachable) focusIndex(reachable);
  }

  function borderClass() {
    const s = status();
    // Contract tokens, not palette. A `border-red-500` is fixed sRGB: it does
    // not move when the theme flips, and it is the one colour on this control
    // that has to read as an error on whatever ground the host paints.
    if (s === "error") return "base:border-ui-danger";
    if (s === "accepted") return "base:border-ui-success";
    return "base:border-ui-hairline";
  }

  const label = () => local["aria-labelledby"];

  return (
    // A fieldset is a group without a role attribute. Its browser box (margin,
    // border, padding, `min-inline-size: min-content`) is cleared, so it lays
    // out as a plain block.
    <fieldset
      class="base:m-0 base:flex base:w-full base:min-w-0 base:gap-2 base:border-0 base:p-0"
      aria-label={label() ? undefined : "Verification code"}
      aria-labelledby={label()}
    >
      <For each={INDICES}>
        {(_, i) => (
          <input
            ref={(el) => (inputs[i()] = el)}
            id={label() ? `${boxId}-${i() + 1}` : undefined}
            type="text"
            inputmode="numeric"
            autocomplete={i() === 0 ? "one-time-code" : "off"}
            disabled={local.disabled || status() === "verifying" || status() === "accepted"}
            value={local.value[i()] ?? ""}
            tabIndex={i() > lastReachable() ? -1 : undefined}
            onInput={(e) => handleInput(i(), e)}
            onKeyDown={(e) => handleKeyDown(i(), e)}
            onPaste={(e) => handlePaste(i(), e)}
            onFocus={() => handleFocus(i())}
            // Labelled, a box names itself after the label: "<label> Digit N".
            // Its own id in the list stands for its `aria-label`, not its value.
            aria-label={`Digit ${i() + 1}`}
            aria-labelledby={label() ? `${label()} ${boxId}-${i() + 1}` : undefined}
            aria-describedby={local["aria-describedby"]}
            aria-invalid={status() === "error" ? "true" : undefined}
            class={clsx(
              // Focus is the text field's ring, plus an outline that only a
              // contrast theme paints, since the theme drops the ring's box
              // shadow. Only colours fade, so both land at once.
              "base:h-12 base:max-w-12 base:min-w-0 base:flex-1 base:rounded-ui-md base:border-2 base:bg-ui-ground base:text-center base:text-ui-md base:font-medium base:text-ui-ink base:ring-offset-ui-ground base:transition-[color,background-color,border-color] base:focus-visible:outline-hidden base:focus-visible:ring-2 base:focus-visible:ring-ui-focus base:focus-visible:ring-offset-2 base:disabled:cursor-not-allowed base:disabled:opacity-70",
              borderClass(),
            )}
          />
        )}
      </For>
    </fieldset>
  );
};

export { OtpInput };
export type { OtpInputProps, OtpStatus };
