import { clsx } from "@osn/ui/lib/utils";
import { A, useLocation } from "@solidjs/router";
import { For } from "solid-js";

import { isNavActive, NAV_ITEMS } from "./nav";

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
      <div class="grid h-14 grid-cols-4">
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
