import { clsx } from "clsx";
import { splitProps, type Component, type ComponentProps } from "solid-js";

const Card: Component<ComponentProps<"div">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <div
      class={clsx(
        "base:bg-card base:text-card-foreground base:rounded-xl base:border base:border-border",
        local.class,
      )}
      {...others}
    />
  );
};

const CardHeader: Component<ComponentProps<"div">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <div
      class={clsx("base:flex base:flex-col base:space-y-1.5 base:p-4", local.class)}
      {...others}
    />
  );
};

const CardTitle: Component<ComponentProps<"h3">> = (props) => {
  const [local, others] = splitProps(props, ["class", "children"]);
  return (
    <h3
      class={clsx(
        "base:text-foreground base:text-base base:font-semibold base:leading-none base:tracking-tight",
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
  return <p class={clsx("base:text-muted-foreground base:text-sm", local.class)} {...others} />;
};

const CardContent: Component<ComponentProps<"div">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return <div class={clsx("base:p-4 base:pt-0", local.class)} {...others} />;
};

const CardFooter: Component<ComponentProps<"div">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <div class={clsx("base:flex base:items-center base:p-4 base:pt-0", local.class)} {...others} />
  );
};

export { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
