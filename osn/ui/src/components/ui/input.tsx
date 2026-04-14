import { clsx } from "clsx";
import { splitProps, type Component, type ComponentProps } from "solid-js";

import { bx } from "../../lib/utils";

type InputProps = ComponentProps<"input">;

const Input: Component<InputProps> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <input
      class={clsx(
        bx(
          "border-input bg-background text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex h-9 w-full rounded-md border px-3 py-2 text-sm file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        ),
        local.class,
      )}
      {...others}
    />
  );
};

export { Input };
export type { InputProps };
