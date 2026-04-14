import { Checkbox as KobalteCheckbox } from "@kobalte/core/checkbox";
import { clsx } from "clsx";
import { splitProps, type Component, type ComponentProps } from "solid-js";

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
      class={clsx("base:flex base:items-center base:gap-2", local.class)}
      checked={local.checked}
      onChange={local.onChange}
      name={local.name}
      {...others}
    >
      <KobalteCheckbox.Input />
      <KobalteCheckbox.Control class="base:border-input base:bg-background base:data-[checked]:bg-primary base:data-[checked]:text-primary-foreground base:peer base:focus-visible:ring-ring base:h-4 base:w-4 base:shrink-0 base:rounded-sm base:border base:transition-colors base:focus-visible:ring-2 base:focus-visible:outline-none">
        <KobalteCheckbox.Indicator class="base:flex base:items-center base:justify-center">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="3"
            stroke-linecap="round"
            stroke-linejoin="round"
            class="base:h-3 base:w-3"
          >
            <path d="M20 6 9 17l-5-5" />
          </svg>
        </KobalteCheckbox.Indicator>
      </KobalteCheckbox.Control>
      {local.label && (
        <KobalteCheckbox.Label class="base:text-sm base:leading-none">
          {local.label}
        </KobalteCheckbox.Label>
      )}
    </KobalteCheckbox>
  );
};

export { Checkbox };
export type { CheckboxProps };
