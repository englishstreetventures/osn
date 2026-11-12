/**
 * `@shared/ui`'s default menu separator, read as every app draws it: a 1px
 * fill in `--ui-hairline` with no border of its own, so the line is the
 * hairline in both schemes and never the panel's ink
 * (`shared/ui/src/ui/menu-classes.ts`). `musubi-surfaces.ts` reads Musubi's
 * account menu with it and `pulse-menus.ts` pulse's two avatar menus.
 *
 * The four values come from one read in the page: the separator's border,
 * height and fill, and `var(--ui-hairline)` resolved on a probe beside it, so
 * a token that resolves elsewhere fails the fill.
 */

import type { Locator } from "@playwright/test";

import type { Flow } from "./fixtures";

export async function menuSeparator(flow: Flow, what: string, rule: Locator): Promise<void> {
  const read = await rule.evaluate((el) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--ui-hairline)";
    el.parentElement!.append(probe);
    const hairline = getComputedStyle(probe).color;
    probe.remove();
    const style = getComputedStyle(el);
    return {
      border: style.borderTopWidth,
      height: style.height,
      fill: style.backgroundColor,
      hairline,
    };
  });
  flow.check(`${what}: no border of its own`, "0px", read.border);
  flow.check(`${what}: 1px tall`, "1px", read.height);
  flow.check(`${what}: filled with the hairline`, read.hairline, read.fill);
}
