import { clsx } from "@osn/ui/lib/utils";
import { A, useLocation } from "@solidjs/router";
import { For } from "solid-js";

import { isNavActive, NAV_ITEMS } from "./nav";

const GRID_COLS: Record<number, string> = {
  4: "grid-cols-4",
  5: "grid-cols-5",
};

/**
 * The mobile shell's primary navigation: a fixed bottom tab bar, rendered
 * below `md` only (the desktop rail takes over above it). Fixed positioning
 * keeps it clear of the scroll container; the scroll column pads itself with
 * `pb-nav` so content never hides behind the bar.
 */
export function MobileNav() {
  const location = useLocation();

  return (
    <nav
      aria-label="Primary"
      class="border-border bg-background pb-safe px-safe fixed inset-x-0 bottom-0 z-40 border-t md:hidden"
    >
      {/* Column count is derived, not hardcoded, but Tailwind only sees static
          class names — so the map below is the allow-list of supported widths.
          Adding a sixth NAV_ITEM means adding `grid-cols-6` here. */}
      <div class={clsx("grid h-14", GRID_COLS[NAV_ITEMS.length] ?? "grid-cols-4")}>
        <For each={NAV_ITEMS}>
          {(item) => (
            <A
              href={item.href}
              aria-current={isNavActive(location.pathname, item.href) ? "page" : undefined}
              class={clsx(
                "active:bg-muted/60 flex flex-col items-center justify-center gap-1 transition-colors",
                isNavActive(location.pathname, item.href) ? "text-foreground" : "text-subtle",
              )}
            >
              <item.icon class="h-5 w-5" />
              <span class="text-meta leading-none font-medium">{item.label}</span>
            </A>
          )}
        </For>
      </div>
    </nav>
  );
}
