import { clsx } from "clsx";
import { createEffect, createSignal, For, onMount, splitProps, type Component } from "solid-js";

type OtpStatus = "idle" | "error" | "verifying" | "accepted";

interface OtpInputProps {
  /** Current value (up to 6 digits). */
  value: string;
  /** Called on every change with the new digit string. */
  onChange: (value: string) => void;
  /** Visual status of the input group. */
  status?: OtpStatus;
  /** Whether all inputs are disabled. */
  disabled?: boolean;
  /** Auto-focus the first input on mount. */
  autofocus?: boolean;
}

const LENGTH = 6;
const INDICES = Array.from({ length: LENGTH });

const OtpInput: Component<OtpInputProps> = (props) => {
  const [local] = splitProps(props, ["value", "onChange", "status", "disabled", "autofocus"]);
  let inputs: HTMLInputElement[] = [];
  const [focusedIndex, setFocusedIndex] = createSignal(-1);

  const digits = () => local.value.split("");
  const status = () => local.status ?? "idle";

  onMount(() => {
    if (local.autofocus) inputs[0]?.focus();
  });

  // When status changes to error, focus the first input so user can retry
  createEffect(() => {
    if (status() === "error") inputs[0]?.focus();
  });

  function focusIndex(i: number) {
    if (i >= 0 && i < LENGTH) inputs[i]?.focus();
  }

  function handleInput(index: number, e: InputEvent) {
    const target = e.target as HTMLInputElement;
    const char = target.value.replace(/\D/g, "").slice(-1);
    if (!char) return;

    const current = digits();
    current[index] = char;
    const next = current.join("").slice(0, LENGTH);
    local.onChange(next);

    if (index < LENGTH - 1) {
      focusIndex(index + 1);
    }
  }

  function handleKeyDown(index: number, e: KeyboardEvent) {
    if (e.key === "Backspace") {
      e.preventDefault();
      const current = digits();
      if (current[index]) {
        current[index] = "";
        local.onChange(current.join(""));
      } else if (index > 0) {
        current[index - 1] = "";
        local.onChange(current.join(""));
        focusIndex(index - 1);
      }
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      focusIndex(index - 1);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      focusIndex(index + 1);
    }
  }

  function handlePaste(e: ClipboardEvent) {
    e.preventDefault();
    const pasted = (e.clipboardData?.getData("text") ?? "").replace(/\D/g, "").slice(0, LENGTH);
    if (!pasted) return;
    local.onChange(pasted);
    focusIndex(Math.min(pasted.length, LENGTH - 1));
  }

  function borderClass(index: number) {
    const s = status();
    if (s === "error") return "base:border-red-500";
    if (s === "accepted") return "base:border-green-600";
    if (s === "verifying" && focusedIndex() === index)
      return "base:border-blue-500 base:ring-1 base:ring-blue-500";
    if (s === "verifying") return "base:border-border";
    // idle
    if (focusedIndex() === index) return "base:border-foreground base:ring-1 base:ring-foreground";
    return "base:border-border";
  }

  return (
    <div class="base:flex base:gap-2" role="group" aria-label="Verification code">
      <For each={INDICES}>
        {(_, i) => (
          <input
            ref={(el) => (inputs[i()] = el)}
            type="text"
            inputmode="numeric"
            autocomplete={i() === 0 ? "one-time-code" : "off"}
            maxLength={1}
            disabled={local.disabled || status() === "verifying" || status() === "accepted"}
            value={digits()[i()] ?? ""}
            onInput={(e) => handleInput(i(), e)}
            onKeyDown={(e) => handleKeyDown(i(), e)}
            onPaste={handlePaste}
            onFocus={() => setFocusedIndex(i())}
            onBlur={() => setFocusedIndex(-1)}
            aria-label={`Digit ${i() + 1}`}
            class={clsx(
              "base:h-12 base:w-12 base:rounded-md base:border-2 base:bg-background base:text-center base:text-lg base:font-medium base:text-foreground base:outline-none base:transition-colors base:disabled:cursor-not-allowed base:disabled:opacity-70",
              borderClass(i()),
            )}
          />
        )}
      </For>
    </div>
  );
};

export { OtpInput };
export type { OtpInputProps, OtpStatus };
