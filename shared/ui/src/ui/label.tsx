import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import { splitProps, type Component, type ComponentProps } from "solid-js";

/**
 * The name of a form control.
 *
 * `tone` and `size` exist because a label is read in two different places. Over
 * an editable field it is part of the form's own voice — full ink, the body
 * size. In a read-only settings list it is the quieter half of a label/value
 * pair, where the value is what the eye should land on. Those are the two
 * treatments in this repository, and they are variants rather than call-site
 * classes so the pair can never drift into three.
 */
const labelVariants = cva("base:font-medium base:leading-none", {
  variants: {
    tone: {
      default: "base:text-ui-ink",
      /** The label half of a label/value pair — recessive, so the value leads. */
      muted: "base:text-ui-ink-secondary",
    },
    size: {
      sm: "base:text-ui-sm",
      md: "base:text-ui-base",
      /** A section heading that also labels a control — a settings row's title. */
      lg: "base:text-ui-lg base:font-semibold",
    },
  },
  defaultVariants: {
    tone: "default",
    size: "md",
  },
});

type LabelProps = ComponentProps<"label"> & VariantProps<typeof labelVariants>;

const Label: Component<LabelProps> = (props) => {
  const [local, others] = splitProps(props, ["class", "tone", "size"]);
  return (
    <label
      class={clsx(
        labelVariants({ tone: local.tone, size: local.size }),
        "base:peer-disabled:cursor-not-allowed base:peer-disabled:opacity-70",
        local.class,
      )}
      {...others}
    />
  );
};

export { Label, labelVariants };
export type { LabelProps };
