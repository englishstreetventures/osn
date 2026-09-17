import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import { splitProps, type Component, type ComponentProps } from "solid-js";

const buttonVariants = cva(
  "base:inline-flex base:cursor-pointer base:items-center base:justify-center base:gap-2 base:whitespace-nowrap base:rounded-ui-control base:text-ui-base base:font-medium base:transition-colors base:focus-visible:outline-none base:focus-visible:ring-2 base:focus-visible:ring-ui-focus base:disabled:pointer-events-none base:disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "base:bg-ui-accent base:text-ui-on-accent base:hover:bg-ui-accent/90",
        destructive: "base:bg-ui-danger base:text-ui-on-danger base:hover:bg-ui-danger/90",
        outline:
          "base:border base:border-ui-hairline-strong base:bg-ui-ground base:hover:bg-ui-surface-sunk base:hover:text-ui-ink",
        secondary: "base:bg-ui-surface-sunk base:text-ui-ink base:hover:bg-ui-surface-sunk/80",
        ghost: "base:hover:bg-ui-surface-sunk base:hover:text-ui-ink",
        link: "base:text-ui-accent-ink base:underline-offset-4 base:hover:underline",
      },
      size: {
        default: "base:h-9 base:px-4 base:py-2",
        sm: "base:h-8 base:rounded-ui-control base:px-3 base:text-ui-sm",
        lg: "base:h-10 base:rounded-ui-control base:px-8",
        icon: "base:h-9 base:w-9",
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
