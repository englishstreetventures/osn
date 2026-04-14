import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import { splitProps, type Component, type ComponentProps } from "solid-js";

import { bx } from "../../lib/utils";

const buttonVariants = cva(
  bx(
    "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
  ),
  {
    variants: {
      variant: {
        default: bx("bg-primary text-primary-foreground hover:bg-primary/90"),
        destructive: bx("bg-destructive text-white hover:bg-destructive/90"),
        outline: bx(
          "border border-input bg-background hover:bg-secondary hover:text-secondary-foreground",
        ),
        secondary: bx("bg-secondary text-secondary-foreground hover:bg-secondary/80"),
        ghost: bx("hover:bg-secondary hover:text-secondary-foreground"),
        link: bx("text-primary underline-offset-4 hover:underline"),
      },
      size: {
        default: bx("h-9 px-4 py-2"),
        sm: bx("h-8 rounded-md px-3 text-xs"),
        lg: bx("h-10 rounded-md px-8"),
        icon: bx("h-9 w-9"),
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps = ComponentProps<"button"> & VariantProps<typeof buttonVariants>;

const Button: Component<ButtonProps> = (props) => {
  const [local, others] = splitProps(props, ["variant", "size", "class"]);
  return (
    <button
      class={clsx(buttonVariants({ variant: local.variant, size: local.size }), local.class)}
      {...others}
    />
  );
};

export { Button, buttonVariants };
export type { ButtonProps };
