import { clsx } from "clsx";
import { splitProps, type Component, type ComponentProps } from "solid-js";

const Avatar: Component<ComponentProps<"span">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <span
      class={clsx(
        "base:relative base:flex base:shrink-0 base:overflow-hidden base:rounded-full",
        local.class,
      )}
      {...others}
    />
  );
};

const AvatarImage: Component<ComponentProps<"img">> = (props) => {
  const [local, others] = splitProps(props, ["class", "alt"]);
  return (
    <img
      class={clsx("base:aspect-square base:h-full base:w-full base:object-cover", local.class)}
      alt={local.alt ?? ""}
      {...others}
    />
  );
};

const AvatarFallback: Component<ComponentProps<"span">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <span
      class={clsx(
        "base:bg-muted base:text-muted-foreground base:flex base:h-full base:w-full base:items-center base:justify-center base:text-[10px] base:font-semibold",
        local.class,
      )}
      {...others}
    />
  );
};

export { Avatar, AvatarImage, AvatarFallback };
