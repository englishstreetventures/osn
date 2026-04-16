import { DropdownMenu as KobalteDropdownMenu } from "@kobalte/core/dropdown-menu";
import { clsx } from "clsx";
import { splitProps, type ComponentProps, type ParentComponent } from "solid-js";

const DropdownMenu = KobalteDropdownMenu;
const DropdownMenuTrigger = KobalteDropdownMenu.Trigger;

const DropdownMenuContent: ParentComponent<ComponentProps<"div">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <KobalteDropdownMenu.Portal>
      <KobalteDropdownMenu.Content
        class={clsx(
          "base:bg-popover base:text-popover-foreground base:border-border base:z-50 base:min-w-[8rem] base:rounded-md base:border base:p-1 base:shadow-md base:outline-none",
          "base:data-[expanded]:animate-in base:data-[closed]:animate-out base:data-[closed]:fade-out-0 base:data-[expanded]:fade-in-0 base:data-[closed]:zoom-out-95 base:data-[expanded]:zoom-in-95",
          local.class,
        )}
        {...others}
      />
    </KobalteDropdownMenu.Portal>
  );
};

const DropdownMenuItem: ParentComponent<ComponentProps<"div"> & { onSelect?: () => void }> = (
  props,
) => {
  const [local, others] = splitProps(props, ["class", "onSelect"]);
  return (
    <KobalteDropdownMenu.Item
      class={clsx(
        "base:relative base:flex base:cursor-pointer base:select-none base:items-center base:rounded-sm base:px-2 base:py-1.5 base:text-sm base:outline-none",
        "base:focus:bg-accent base:focus:text-accent-foreground",
        "base:data-[disabled]:pointer-events-none base:data-[disabled]:opacity-50",
        local.class,
      )}
      onSelect={local.onSelect}
      {...others}
    />
  );
};

const DropdownMenuLabel: ParentComponent<ComponentProps<"span">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <KobalteDropdownMenu.GroupLabel
      class={clsx("base:px-2 base:py-1.5 base:text-sm base:font-semibold", local.class)}
      {...others}
    />
  );
};

const DropdownMenuSeparator: ParentComponent<ComponentProps<"hr">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <KobalteDropdownMenu.Separator
      class={clsx("base:bg-border base:-mx-1 base:my-1 base:h-px", local.class)}
      {...others}
    />
  );
};

const DropdownMenuGroup = KobalteDropdownMenu.Group;

export {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuGroup,
};
