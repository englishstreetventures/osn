import { Tabs as KobalteTabs } from "@kobalte/core/tabs";
import { clsx } from "clsx";
import { splitProps, type Component, type JSX } from "solid-js";

const Tabs = KobalteTabs;

const TabsList: Component<{ class?: string; children?: JSX.Element }> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return <KobalteTabs.List class={clsx("base:flex base:gap-1", local.class)} {...others} />;
};

/**
 * `sm` is for a tab strip inside a dialog or a card header, where the tabs are
 * a control rather than the page's own navigation. Size and padding move
 * together — a smaller label in the full-size box reads as a mistake — which is
 * why it is one prop and not a class at the call site.
 */
const TABS_TRIGGER_SIZE = {
  sm: "base:px-2 base:py-1 base:text-ui-sm",
  md: "base:px-3 base:py-1.5 base:text-ui-base",
} satisfies Readonly<Record<"sm" | "md", string>>;

const TabsTrigger: Component<{
  value: string;
  class?: string;
  children?: JSX.Element;
  disabled?: boolean;
  size?: "sm" | "md";
}> = (props) => {
  const [local, others] = splitProps(props, ["class", "value", "size"]);
  return (
    <KobalteTabs.Trigger
      value={local.value}
      class={clsx(
        "base:rounded-ui-md base:font-medium base:transition-colors",
        TABS_TRIGGER_SIZE[local.size ?? "md"],
        "base:text-ui-ink-secondary base:hover:bg-ui-surface-sunk",
        "base:data-[selected]:bg-ui-accent base:data-[selected]:text-ui-on-accent",
        local.class,
      )}
      {...others}
    />
  );
};

const TabsContent: Component<{ value: string; class?: string; children?: JSX.Element }> = (
  props,
) => {
  const [local, others] = splitProps(props, ["class", "value"]);
  return (
    <KobalteTabs.Content
      value={local.value}
      class={clsx("base:mt-2 base:focus-visible:outline-none", local.class)}
      {...others}
    />
  );
};

export { Tabs, TabsList, TabsTrigger, TabsContent };
