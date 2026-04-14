import { clsx } from "clsx";
import { splitProps, type Component, type ComponentProps } from "solid-js";

import { bx } from "../../lib/utils";

type LabelProps = ComponentProps<"label">;

const Label: Component<LabelProps> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <label
      class={clsx(
        bx(
          "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        ),
        local.class,
      )}
      {...others}
    />
  );
};

export { Label };
export type { LabelProps };
