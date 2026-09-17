import { clsx } from "clsx";
import { splitProps, type Component, type ComponentProps } from "solid-js";

/**
 * How much room a card gives its contents.
 *
 * `none` is the default and is not an oversight: a card built from
 * `CardHeader` / `CardContent` / `CardFooter` gets its padding from those, and
 * adding any here would double it. The three sized steps are for the other
 * shape — a card whose children are just content — which is what 15 call sites
 * across `@pulse/web` and `@musubi/social` were spelling as `class="p-4"`,
 * `"p-5"` and `"p-6"`.
 */
type CardPadding = "none" | "sm" | "md" | "lg";

const CARD_PADDING = {
  none: "",
  sm: "base:p-4",
  md: "base:p-5",
  lg: "base:p-6",
} satisfies Readonly<Record<CardPadding, string>>;

type CardProps = ComponentProps<"div"> & { padding?: CardPadding };

const Card: Component<CardProps> = (props) => {
  const [local, others] = splitProps(props, ["class", "padding"]);
  return (
    <div
      class={clsx(
        "base:bg-ui-surface base:text-ui-ink base:rounded-ui-lg base:border base:border-border",
        CARD_PADDING[local.padding ?? "none"],
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
        "base:text-ui-ink base:text-ui-md base:font-semibold base:leading-none base:tracking-ui-tight",
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
  return (
    <p class={clsx("base:text-ui-ink-secondary base:text-ui-base", local.class)} {...others} />
  );
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
export type { CardPadding, CardProps };
