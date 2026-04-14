import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import { splitProps, type Component, type ComponentProps } from "solid-js";

const buttonVariants = cva(
  "base:inline-flex base:cursor-pointer base:items-center base:justify-center base:gap-2 base:whitespace-nowrap base:rounded-md base:text-sm base:font-medium base:transition-colors base:focus-visible:outline-none base:focus-visible:ring-2 base:focus-visible:ring-ring base:disabled:pointer-events-none base:disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "base:bg-primary base:text-primary-foreground base:hover:bg-primary/90",
        destructive: "base:bg-destructive base:text-white base:hover:bg-destructive/90",
        outline:
          "base:border base:border-input base:bg-background base:hover:bg-secondary base:hover:text-secondary-foreground",
        secondary: "base:bg-secondary base:text-secondary-foreground base:hover:bg-secondary/80",
        ghost: "base:hover:bg-secondary base:hover:text-secondary-foreground",
        link: "base:text-primary base:underline-offset-4 base:hover:underline",
      },
      size: {
        default: "base:h-9 base:px-4 base:py-2",
        sm: "base:h-8 base:rounded-md base:px-3 base:text-xs",
        lg: "base:h-10 base:rounded-md base:px-8",
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
