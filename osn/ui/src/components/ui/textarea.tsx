import { clsx } from "clsx";
import { splitProps, type Component, type ComponentProps } from "solid-js";

import { bx } from "../../lib/utils";

type TextareaProps = ComponentProps<"textarea">;

const Textarea: Component<TextareaProps> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <textarea
      class={clsx(
        bx(
          "border-input bg-background text-foreground ring-offset-background placeholder:text-muted-foreground focus-visible:ring-ring flex min-h-[60px] w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        ),
        local.class,
      )}
      {...others}
    />
  );
};

export { Textarea };
export type { TextareaProps };
