import { clsx } from "clsx";
import { splitProps, type Component, type ComponentProps } from "solid-js";

import { bx } from "../../lib/utils";

const Card: Component<ComponentProps<"div">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <div
      class={clsx(bx("bg-card text-card-foreground rounded-xl border border-border"), local.class)}
      {...others}
    />
  );
};

const CardHeader: Component<ComponentProps<"div">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return <div class={clsx(bx("flex flex-col space-y-1.5 p-4"), local.class)} {...others} />;
};

const CardTitle: Component<ComponentProps<"h3">> = (props) => {
  const [local, others] = splitProps(props, ["class", "children"]);
  return (
    <h3
      class={clsx(
        bx("text-foreground text-base font-semibold leading-none tracking-tight"),
        local.class,
      )}
      {...others}
    >
      {local.children}
    </h3>
  );
};

const CardDescription: Component<ComponentProps<"p">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return <p class={clsx(bx("text-muted-foreground text-sm"), local.class)} {...others} />;
};

const CardContent: Component<ComponentProps<"div">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return <div class={clsx(bx("p-4 pt-0"), local.class)} {...others} />;
};

const CardFooter: Component<ComponentProps<"div">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return <div class={clsx(bx("flex items-center p-4 pt-0"), local.class)} {...others} />;
};

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
