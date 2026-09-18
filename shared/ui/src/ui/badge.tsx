import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import { splitProps, type Component, type ComponentProps } from "solid-js";

const badgeVariants = cva(
  "base:inline-flex base:items-center base:rounded-ui-pill base:px-2.5 base:py-0.5 base:text-ui-sm base:font-semibold base:transition-colors base:focus:outline-none base:focus:ring-2 base:focus:ring-ui-focus base:focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "base:bg-ui-accent base:text-ui-on-accent",
        secondary: "base:bg-ui-surface-sunk base:text-ui-ink-secondary",
        destructive: "base:bg-ui-danger base:text-ui-on-danger",
        outline: "base:text-ui-ink base:border base:border-ui-hairline",
      },
      /**
       * How the label inside the badge is set.
       *
       * `eyebrow` is the small-caps treatment a category or status pill takes
       * when it sits above or beside a heading: a step down in size, upper
       * case, and the tracking that keeps upper case legible at that size.
       * It is a variant rather than three classes at the call site because
       * the three only work together — upper case at the default size and
       * tracking reads as shouting, and the tracking alone does nothing.
       */
      treatment: {
        default: "",
        eyebrow: "base:text-ui-xs base:uppercase base:tracking-ui-wider",
      },
    },
    defaultVariants: {
      variant: "default",
      treatment: "default",
    },
  },
);

type BadgeProps = ComponentProps<"div"> & VariantProps<typeof badgeVariants>;

const Badge: Component<BadgeProps> = (props) => {
  const [local, others] = splitProps(props, ["variant", "treatment", "class"]);
  return (
    <div
      class={clsx(
        badgeVariants({ variant: local.variant, treatment: local.treatment }),
        local.class,
      )}
      {...others}
    />
  );
};

export { Badge, badgeVariants };
export type { BadgeProps };
