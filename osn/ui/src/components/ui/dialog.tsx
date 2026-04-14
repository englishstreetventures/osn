import { Dialog as KobalteDialog } from "@kobalte/core/dialog";
import { clsx } from "clsx";
import { splitProps, type Component, type ComponentProps, type ParentComponent } from "solid-js";

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
        "base:fixed base:inset-0 base:z-50 base:bg-black/50 base:data-[expanded]:animate-in base:data-[closed]:animate-out base:data-[closed]:fade-out-0 base:data-[expanded]:fade-in-0",
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
          "base:bg-card base:border-border base:fixed base:top-[50%] base:left-[50%] base:z-50 base:w-full base:max-w-lg base:translate-x-[-50%] base:translate-y-[-50%] base:rounded-xl base:border base:shadow-xl base:focus:outline-none sm:base:rounded-xl",
          "base:data-[expanded]:animate-in base:data-[closed]:animate-out base:data-[closed]:fade-out-0 base:data-[expanded]:fade-in-0 base:data-[closed]:zoom-out-95 base:data-[expanded]:zoom-in-95 base:data-[closed]:slide-out-to-left-1/2 base:data-[closed]:slide-out-to-top-[48%] base:data-[expanded]:slide-in-from-left-1/2 base:data-[expanded]:slide-in-from-top-[48%]",
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
      class={clsx(
        "base:flex base:items-center base:justify-between base:border-b base:border-border base:p-4",
        local.class,
      )}
      {...others}
    />
  );
};

const DialogFooter: Component<ComponentProps<"div">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <div
      class={clsx(
        "base:flex base:items-center base:justify-end base:gap-2 base:border-t base:border-border base:p-4",
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
      class={clsx("base:text-foreground base:text-base base:font-semibold", local.class)}
      {...others}
    />
  );
};

const DialogDescription: Component<ComponentProps<"p">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <KobalteDialog.Description
      class={clsx("base:text-muted-foreground base:text-sm", local.class)}
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
