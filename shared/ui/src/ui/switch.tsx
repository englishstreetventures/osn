import { clsx } from "clsx";
import { splitProps, type Component } from "solid-js";

import type { SafeProps } from "./props";

type SwitchProps = Omit<SafeProps<"label">, "onChange"> & {
  /** On or off. Controlled: the switch shows this value and nothing else, so a
   *  change the caller refuses, or has not saved yet, never shows as made. */
  checked: boolean;
  /** Asked for the new value. The switch moves only when `checked` does. */
  onChange?: (checked: boolean) => void;
  /** The accessible name. Required: a switch with no name is announced as just
   *  "switch", which says nothing about what it turns on. */
  label: string;
  /** Keep the label for assistive technology only, for a switch whose column
   *  heading or row already names it on screen. */
  labelHidden?: boolean;
  /**
   * Shows its state and cannot be changed, and stays in the tab order.
   *
   * The choice for someone who may read a setting but not change it. A
   * `disabled` control leaves the tab order, so a keyboard or screen-reader
   * user could not reach the state they are allowed to read; read-only keeps it
   * reachable and announced as read-only. It keeps full contrast for the same
   * reason: the state is the content.
   */
  readOnly?: boolean;
  /** A change is being saved. Read-only until it lands, and announced as busy,
   *  so the control keeps focus rather than dropping it to the page. */
  busy?: boolean;
  /** Unavailable altogether: out of the tab order and dimmed. Prefer
   *  `readOnly` whenever the state itself is worth reading. */
  disabled?: boolean;
  /** `id` of an element that describes the switch further. */
  describedBy?: string;
  name?: string;
};

/**
 * An on/off control whose change takes effect at once.
 *
 * Use it where flipping it IS the action; a choice collected into a form and
 * saved later is a `Checkbox`. It is a native `<input type="checkbox"
 * role="switch">`, visually hidden inside its label, so Space toggles it, a
 * click anywhere on the label does, and a screen reader announces a switch; the
 * track and thumb beside it are what paints.
 *
 * Native rather than Kobalte's switch: the element already carries every
 * behaviour a switch needs, and this renders on cire's organiser portal, whose
 * bundle budget has no room for a form-control layer it would not use.
 */
const Switch: Component<SwitchProps> = (props) => {
  const [local, others] = splitProps(props, [
    "class",
    "checked",
    "onChange",
    "label",
    "labelHidden",
    "readOnly",
    "busy",
    "disabled",
    "describedBy",
    "name",
  ]);
  const inert = () => local.readOnly === true || local.busy === true;
  const flag = (on: boolean | undefined) => (on ? "" : undefined);
  return (
    <label class={clsx("base:inline-flex base:items-center base:gap-2", local.class)} {...others}>
      {/* `peer` is a marker for the track's focus ring, not a utility. */}
      <input
        type="checkbox"
        role="switch"
        class="peer base:sr-only"
        name={local.name}
        checked={local.checked}
        // Always equal to `checked`: the element is put back to the given value
        // on every change, so the two cannot disagree.
        aria-checked={local.checked}
        disabled={local.disabled}
        aria-readonly={inert() ? "true" : undefined}
        aria-busy={local.busy ? "true" : undefined}
        aria-describedby={local.describedBy}
        onClick={(event) => {
          // A read-only checkbox is not a thing the platform has: cancelling
          // the click is what stops it toggling, from a pointer or from Space.
          if (inert()) {
            event.preventDefault();
            return;
          }
          // A click on the label reaches the input without focusing it in
          // every engine; focus it, so whatever the change opens hands focus
          // back here.
          event.currentTarget.focus();
        }}
        onChange={(event) => {
          const next = event.currentTarget.checked;
          // Controlled: put the element back to the value it was given, and let
          // `checked` move it if the caller agrees.
          event.currentTarget.checked = local.checked;
          local.onChange?.(next);
        }}
      />
      <span
        aria-hidden="true"
        data-checked={flag(local.checked)}
        data-readonly={flag(inert())}
        data-disabled={flag(local.disabled)}
        class="base:border-ui-hairline-strong base:bg-ui-ground base:data-[checked]:border-ui-accent base:data-[checked]:bg-ui-accent base:peer-focus-visible:ring-ui-focus base:peer-focus-visible:ring-offset-ui-ground base:inline-flex base:h-5 base:w-9 base:shrink-0 base:cursor-pointer base:items-center base:rounded-full base:border base:p-0.5 base:transition-colors base:peer-focus-visible:ring-2 base:peer-focus-visible:ring-offset-2 base:data-[disabled]:cursor-not-allowed base:data-[disabled]:opacity-50 base:data-[readonly]:cursor-default base:motion-reduce:transition-none"
      >
        <span
          data-checked={flag(local.checked)}
          class="base:bg-ui-ink-secondary base:data-[checked]:bg-ui-on-accent base:h-3.5 base:w-3.5 base:rounded-full base:transition-transform base:data-[checked]:translate-x-4 base:motion-reduce:transition-none"
        />
      </span>
      <span
        class={
          local.labelHidden
            ? "base:sr-only"
            : "base:text-ui-base base:leading-none base:text-ui-ink"
        }
      >
        {local.label}
      </span>
    </label>
  );
};

export { Switch };
export type { SwitchProps };
