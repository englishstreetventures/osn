import { clsx } from "clsx";
import { splitProps, type Component, type ComponentProps } from "solid-js";

type LabelProps = ComponentProps<"label">;

const Label: Component<LabelProps> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <label
      class={clsx(
        "base:text-sm base:font-medium base:leading-none base:peer-disabled:cursor-not-allowed base:peer-disabled:opacity-70",
        local.class,
      )}
      {...others}
    />
  );
};

export { Label };
export type { LabelProps };
