import { clsx } from "clsx";
import { splitProps, type Component, type ComponentProps } from "solid-js";

type InputProps = ComponentProps<"input">;

const Input: Component<InputProps> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <input
      class={clsx(
        "base:border-input base:bg-background base:text-foreground base:ring-offset-background base:placeholder:text-muted-foreground base:focus-visible:ring-ring base:flex base:h-9 base:w-full base:rounded-md base:border base:px-3 base:py-2 base:text-sm base:file:border-0 base:file:bg-transparent base:file:text-sm base:file:font-medium base:focus-visible:outline-none base:focus-visible:ring-2 base:focus-visible:ring-offset-2 base:disabled:cursor-not-allowed base:disabled:opacity-50",
        local.class,
      )}
      {...others}
    />
  );
};

export { Input };
export type { InputProps };
