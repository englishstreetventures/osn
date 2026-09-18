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

/**
 * What kind of thing the card is, which decides its fill and its edge together.
 *
 * `muted` is a card that holds something already on the page rather than
 * introducing it — a preview, a quoted block, a disabled row — so it sits in a
 * well instead of on a surface. `dashed` is the empty slot a thing will go in:
 * a drop target, an "add one" tile. Its edge is dashed *and* it has no fill,
 * because a filled dashed box reads as a broken card rather than an absence.
 */
type CardVariant = "default" | "muted" | "dashed";

const CARD_VARIANT = {
  default: "base:bg-ui-surface base:border-ui-hairline",
  muted: "base:bg-ui-surface-sunk base:border-ui-hairline",
  dashed: "base:bg-transparent base:border-dashed base:border-ui-hairline-strong",
} satisfies Readonly<Record<CardVariant, string>>;

/**
 * Whether the card is lifted off the page.
 *
 * A card is told apart by its surface, not a shadow — so `flat` is the default.
 * `raised` is for the one case where a card overlaps content it is not part of
 * and needs to say which is in front.
 */
const CARD_ELEVATION = {
  flat: "",
  raised: "base:shadow-[var(--ui-elev-2)]",
} satisfies Readonly<Record<"flat" | "raised", string>>;

/**
 * `md` is for a card nested inside another card, where the outer corner has
 * already been spent and repeating it reads as two competing frames.
 */
const CARD_RADIUS = {
  md: "base:rounded-ui-md",
  lg: "base:rounded-ui-lg",
} satisfies Readonly<Record<"md" | "lg", string>>;

type CardProps = ComponentProps<"div"> & {
  padding?: CardPadding;
  variant?: CardVariant;
  elevation?: keyof typeof CARD_ELEVATION;
  radius?: keyof typeof CARD_RADIUS;
};

const Card: Component<CardProps> = (props) => {
  const [local, others] = splitProps(props, ["class", "padding", "variant", "elevation", "radius"]);
  return (
    <div
      class={clsx(
        "base:text-ui-ink base:border",
        CARD_VARIANT[local.variant ?? "default"],
        CARD_RADIUS[local.radius ?? "lg"],
        CARD_ELEVATION[local.elevation ?? "flat"],
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
export type { CardPadding, CardProps, CardVariant };
