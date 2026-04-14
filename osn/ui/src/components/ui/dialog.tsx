import { Dialog as KobalteDialog } from "@kobalte/core/dialog";
import { clsx } from "clsx";
import { splitProps, type Component, type ComponentProps, type ParentComponent } from "solid-js";

import { bx } from "../../lib/utils";

const Dialog = KobalteDialog;
const DialogTrigger = KobalteDialog.Trigger;
const DialogClose = KobalteDialog.CloseButton;

const DialogPortal: ParentComponent = (props) => {
  return <KobalteDialog.Portal>{props.children}</KobalteDialog.Portal>;
};

const DialogOverlay: Component<ComponentProps<"div">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <KobalteDialog.Overlay
      class={clsx(
        bx(
          "fixed inset-0 z-50 bg-black/50 data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0",
        ),
        local.class,
      )}
      {...others}
    />
  );
};

const DialogContent: ParentComponent<ComponentProps<"div">> = (props) => {
  const [local, others] = splitProps(props, ["class", "children"]);
  return (
    <DialogPortal>
      <DialogOverlay />
      <KobalteDialog.Content
        class={clsx(
          bx(
            "bg-card border-border fixed top-[50%] left-[50%] z-50 w-full max-w-lg translate-x-[-50%] translate-y-[-50%] rounded-xl border shadow-xl focus:outline-none sm:rounded-xl",
          ),
          bx(
            "data-[expanded]:animate-in data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:fade-in-0 data-[closed]:zoom-out-95 data-[expanded]:zoom-in-95 data-[closed]:slide-out-to-left-1/2 data-[closed]:slide-out-to-top-[48%] data-[expanded]:slide-in-from-left-1/2 data-[expanded]:slide-in-from-top-[48%]",
          ),
          local.class,
        )}
        {...others}
      >
        {local.children}
      </KobalteDialog.Content>
    </DialogPortal>
  );
};

const DialogHeader: Component<ComponentProps<"div">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <div
      class={clsx(bx("flex items-center justify-between border-b border-border p-4"), local.class)}
      {...others}
    />
  );
};

const DialogFooter: Component<ComponentProps<"div">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <div
      class={clsx(
        bx("flex items-center justify-end gap-2 border-t border-border p-4"),
        local.class,
      )}
      {...others}
    />
  );
};

const DialogTitle: Component<ComponentProps<"h2">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <KobalteDialog.Title
      class={clsx(bx("text-foreground text-base font-semibold"), local.class)}
      {...others}
    />
  );
};

const DialogDescription: Component<ComponentProps<"p">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <KobalteDialog.Description
      class={clsx(bx("text-muted-foreground text-sm"), local.class)}
      {...others}
    />
  );
};

export {
  Dialog,
  DialogTrigger,
  DialogClose,
  DialogPortal,
  DialogOverlay,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
};
