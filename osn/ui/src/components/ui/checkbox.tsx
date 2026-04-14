import { Checkbox as KobalteCheckbox } from "@kobalte/core/checkbox";
import { clsx } from "clsx";
import { splitProps, type Component, type ComponentProps } from "solid-js";

import { bx } from "../../lib/utils";

type CheckboxProps = Omit<ComponentProps<"div">, "onChange"> & {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  label?: string;
  name?: string;
};

const Checkbox: Component<CheckboxProps> = (props) => {
  const [local, others] = splitProps(props, ["class", "checked", "onChange", "label", "name"]);
  return (
    <KobalteCheckbox
      class={clsx(bx("flex items-center gap-2"), local.class)}
      checked={local.checked}
      onChange={local.onChange}
      name={local.name}
      {...others}
    >
      <KobalteCheckbox.Input />
      <KobalteCheckbox.Control
        class={bx(
          "border-input bg-background data-[checked]:bg-primary data-[checked]:text-primary-foreground peer focus-visible:ring-ring h-4 w-4 shrink-0 rounded-sm border transition-colors focus-visible:ring-2 focus-visible:outline-none",
        )}
      >
        <KobalteCheckbox.Indicator class={bx("flex items-center justify-center")}>
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
            class={bx("h-3 w-3")}
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </KobalteCheckbox.Indicator>
      </KobalteCheckbox.Control>
      {local.label && (
        <KobalteCheckbox.Label class={bx("text-sm leading-none")}>
          {local.label}
        </KobalteCheckbox.Label>
      )}
    </KobalteCheckbox>
  );
};

export { Checkbox };
export type { CheckboxProps };
