import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import { splitProps, type Component, type ComponentProps } from "solid-js";

const badgeVariants = cva(
  "base:inline-flex base:items-center base:rounded-full base:px-2.5 base:py-0.5 base:text-xs base:font-semibold base:transition-colors base:focus:outline-none base:focus:ring-2 base:focus:ring-ring base:focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "base:bg-primary base:text-primary-foreground",
        secondary: "base:bg-muted base:text-muted-foreground",
        destructive: "base:bg-destructive base:text-white",
        outline: "base:text-foreground base:border base:border-border",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

type BadgeProps = ComponentProps<"div"> & VariantProps<typeof badgeVariants>;

const Badge: Component<BadgeProps> = (props) => {
  const [local, others] = splitProps(props, ["variant", "class"]);
  return <div class={clsx(badgeVariants({ variant: local.variant }), local.class)} {...others} />;
};

export { Badge, badgeVariants };
export type { BadgeProps };
