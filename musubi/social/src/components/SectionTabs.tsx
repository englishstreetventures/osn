import { clsx } from "@shared/ui/lib/utils";
import { For, type JSX } from "solid-js";

/**
 * The underline tab bar the Connections and Settings pages share.
 *
 * Both pages had the same nineteen classes written out twice, and the two
 * copies were byte-identical — which is the failure mode this exists to end,
 * not a stylistic preference. A change to the selected-state colour had to be
 * made in two files, and nothing said so.
 *
 * ## Why not `@shared/ui`'s `Tabs`
 *
 * That one is Kobalte's, and it is a *pill* tab: a filled accent chip, with its
 * own `Tabs.Content` structure and roving arrow-key focus. This is a different
 * visual and a different shape of page — Settings is deep-linked by URL
 * fragment and its sections are `<Show>` blocks, not panels owned by a tab
 * component. Reskinning the pill to look like an underline would leave one
 * component with two unrelated appearances, so this stays musubi's.
 *
 * ## Tabs, honestly named
 *
 * `aria-current="page"` rather than `role="tab"` and `aria-selected`. The full
 * tab pattern is a contract — a `tablist`, a `tabpanel` per tab, arrow keys
 * moving selection, one tab stop for the set — and a bar that claims the roles
 * without keeping the contract is worse for a screen-reader user than plain
 * buttons, because it promises navigation that is not there. Reach for
 * `@shared/ui`'s `Tabs` when the page can own real panels.
 */
export interface SectionTab<T extends string> {
  value: T;
  label: string;
}

export interface SectionTabsProps<T extends string> {
  /** Names the bar for a screen reader: "Connection filters", "Settings sections". */
  label: string;
  tabs: readonly SectionTab<T>[];
  current: T;
  onSelect: (value: T) => void;
  class?: string;
}

export function SectionTabs<T extends string>(props: SectionTabsProps<T>): JSX.Element {
  return (
    <nav
      aria-label={props.label}
      class={clsx(
        "border-border flex gap-1 overflow-x-auto border-b whitespace-nowrap",
        props.class,
      )}
    >
      <For each={props.tabs}>
        {(tab) => (
          <button
            type="button"
            // `max-md:min-h-11` is the 44px touch target; above that breakpoint
            // the bar is pointed at with a cursor and the extra height only
            // pads the rule it sits on.
            class={clsx(
              "text-body border-b-2 px-3 pb-2.5 font-medium transition-colors max-md:min-h-11",
              props.current === tab.value
                ? "border-foreground text-foreground"
                : "text-muted-foreground hover:text-foreground border-transparent",
            )}
            aria-current={props.current === tab.value ? "page" : undefined}
            onClick={() => props.onSelect(tab.value)}
          >
            {tab.label}
          </button>
        )}
      </For>
    </nav>
  );
}
