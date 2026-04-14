import { clsx } from "clsx";
import { splitProps, type Component, type ComponentProps } from "solid-js";

import { bx } from "../../lib/utils";

const Avatar: Component<ComponentProps<"span">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <span
      class={clsx(bx("relative flex shrink-0 overflow-hidden rounded-full"), local.class)}
      {...others}
    />
  );
};

const AvatarImage: Component<ComponentProps<"img">> = (props) => {
  const [local, others] = splitProps(props, ["class", "alt"]);
  return (
    <img
      class={clsx(bx("aspect-square h-full w-full object-cover"), local.class)}
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
        bx(
          "bg-muted text-muted-foreground flex h-full w-full items-center justify-center text-[10px] font-semibold",
        ),
        local.class,
      )}
      {...others}
    />
  );
};

export { Avatar, AvatarImage, AvatarFallback };
