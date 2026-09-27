import { Switch as KobalteSwitch } from "@kobalte/core/switch";
import { clsx } from "clsx";
import { splitProps, type Component } from "solid-js";

import type { SafeProps } from "./props";

type SwitchProps = Omit<SafeProps<"div">, "onChange"> & {
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
 * saved later is a `Checkbox`. The native element underneath is a visually
 * hidden `<input type="checkbox" role="switch">`, so Space toggles it and a
 * screen reader announces it as a switch; the track and thumb beside it are
 * what paints.
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
  return (
    <KobalteSwitch
      class={clsx("base:inline-flex base:items-center base:gap-2", local.class)}
      checked={local.checked}
      onChange={(next) => local.onChange?.(next)}
      readOnly={local.readOnly || local.busy}
      disabled={local.disabled}
      name={local.name}
      {...others}
    >
      {/* `peer` is a marker for the track's focus ring, not a utility: the
          input is the element that takes focus, and it is visually hidden. */}
      <KobalteSwitch.Input
        class="peer"
        aria-busy={local.busy ? "true" : undefined}
        aria-describedby={local.describedBy}
      />
      <KobalteSwitch.Control class="base:border-ui-hairline-strong base:bg-ui-ground base:data-[checked]:border-ui-accent base:data-[checked]:bg-ui-accent base:peer-focus-visible:ring-ui-focus base:peer-focus-visible:ring-offset-ui-ground base:inline-flex base:h-5 base:w-9 base:shrink-0 base:cursor-pointer base:items-center base:rounded-full base:border base:p-0.5 base:transition-colors base:peer-focus-visible:ring-2 base:peer-focus-visible:ring-offset-2 base:data-[disabled]:cursor-not-allowed base:data-[disabled]:opacity-50 base:data-[readonly]:cursor-default base:motion-reduce:transition-none">
        <KobalteSwitch.Thumb class="base:bg-ui-ink-secondary base:data-[checked]:bg-ui-on-accent base:h-3.5 base:w-3.5 base:rounded-full base:transition-transform base:data-[checked]:translate-x-4 base:motion-reduce:transition-none" />
      </KobalteSwitch.Control>
      <KobalteSwitch.Label
        class={
          local.labelHidden
            ? "base:sr-only"
            : "base:text-ui-base base:leading-none base:text-ui-ink"
        }
      >
        {local.label}
      </KobalteSwitch.Label>
    </KobalteSwitch>
  );
};

export { Switch };
export type { SwitchProps };
