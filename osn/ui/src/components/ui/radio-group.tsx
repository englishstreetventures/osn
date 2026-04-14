import { RadioGroup as KobalteRadioGroup } from "@kobalte/core/radio-group";
import { clsx } from "clsx";
import { splitProps, type Component, type ComponentProps } from "solid-js";

type RadioGroupProps = Omit<ComponentProps<"div">, "onChange"> & {
  value?: string;
  onChange?: (value: string) => void;
  name?: string;
};

const RadioGroup: Component<RadioGroupProps> = (props) => {
  const [local, others] = splitProps(props, ["class", "value", "onChange", "name"]);
  return (
    <KobalteRadioGroup
      class={clsx("base:flex base:gap-2 base:text-sm", local.class)}
      value={local.value}
      onChange={local.onChange}
      name={local.name}
      {...others}
    />
  );
};

type RadioGroupItemProps = ComponentProps<"div"> & {
  value: string;
  label: string;
};

const RadioGroupItem: Component<RadioGroupItemProps> = (props) => {
  const [local, others] = splitProps(props, ["class", "value", "label"]);
  return (
    <KobalteRadioGroup.Item
      value={local.value}
      class={clsx("base:flex base:cursor-pointer base:items-center base:gap-1", local.class)}
      {...others}
    >
      <KobalteRadioGroup.ItemInput />
      <KobalteRadioGroup.ItemControl class="base:border-input base:bg-background base:data-[checked]:border-primary base:focus-visible:ring-ring base:aspect-square base:h-4 base:w-4 base:rounded-full base:border base:transition-colors base:focus-visible:ring-2 base:focus-visible:outline-none">
        <KobalteRadioGroup.ItemIndicator class="base:after:bg-primary base:flex base:items-center base:justify-center base:after:block base:after:h-2.5 base:after:w-2.5 base:after:rounded-full" />
      </KobalteRadioGroup.ItemControl>
      <KobalteRadioGroup.ItemLabel class="base:text-sm base:leading-none">
        {local.label}
      </KobalteRadioGroup.ItemLabel>
    </KobalteRadioGroup.Item>
  );
};

export { RadioGroup, RadioGroupItem };
export type { RadioGroupProps, RadioGroupItemProps };
