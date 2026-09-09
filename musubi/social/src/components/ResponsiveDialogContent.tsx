import { clsx } from "@osn/ui/lib/utils";
import { DialogContent } from "@osn/ui/ui/dialog";
import { splitProps, type ComponentProps, type ParentComponent } from "solid-js";

/**
 * `DialogContent` with a mobile face. Below `md` the centered card becomes a
 * bottom sheet: pinned to the bottom edge, full-width, square bottom corners,
 * scrollable within 85dvh so the soft keyboard and small screens never clip a
 * form. At `md+` it renders exactly the shared centered card. Classes only —
 * the `@osn/ui` primitive is untouched (its `base:` zero-specificity variant
 * lets these call-site classes win).
 */
export const ResponsiveDialogContent: ParentComponent<ComponentProps<"div">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <DialogContent
      class={clsx(
        "rounded-card max-md:top-auto max-md:bottom-0 max-md:left-0 max-md:max-h-[85dvh] max-md:w-full max-md:max-w-none max-md:translate-x-0 max-md:translate-y-0 max-md:overflow-y-auto max-md:rounded-b-none max-md:border-x-0 max-md:border-b-0 max-md:pb-safe",
        local.class,
      )}
      {...others}
    />
  );
};
