import { readFileSync } from "node:fs";
import { join } from "node:path";

import { checkContractConformance } from "@shared/design-tokens/conformance";
import { describe, expect, it } from "vitest";

/**
 * Does the invite's mapping onto `@shared/design-tokens` clear the contrast
 * floors the contract promises?
 *
 * This is the app's half of the contract. `@shared/design-tokens` says what the
 * roles are and what each one owes; this asserts that the colours the invite
 * sends to those roles pay it. A shared component rendered here reads the
 * contract, so a mapping that puts secondary ink under 4.5:1 makes every
 * `@shared/ui` primitive illegible on the guest site and nowhere else.
 *
 * ## What it can and cannot see
 *
 * It measures the **evergreen fallback** — the literals in the `@theme` block —
 * because those are the only values that exist at rest. A real invite is
 * repainted at runtime by `paletteRootVars`, which overrides `--color-*` on
 * `<html>` from the organiser's five seeds, and the contract rides through that
 * join unchanged because the mapping aliases `--color-*` rather than the
 * literals behind them.
 *
 * Those derived palettes have their own guard: `invite-theme.test.ts` holds
 * `derivePalette` to the same floors. This one holds the fallback, which is not
 * a hypothetical — `/privacy` and `/terms` never receive a derived palette and
 * paint these literals verbatim.
 */

const CSS = readFileSync(join(import.meta.dirname, "../../src/styles/global.css"), "utf8");

/**
 * One scope, because the invite has one theme. `@theme` carries the brand
 * literals and `:root` carries the mapping onto them, so the harness needs
 * both — in that order, since the mapping is what reads the block above it.
 */
const SCOPES = [{ name: "evergreen", selectors: ["@theme", ":root"] }] as const;

describe("design-token contract", () => {
  it("maps every role without breaking contrast", () => {
    const failures = checkContractConformance({ css: CSS, scopes: SCOPES });
    expect(failures.map((f) => `[${f.scope}] ${f.fg} on ${f.bg} — ${f.reason}`)).toEqual([]);
  });

  it("imports the contract stylesheet, or none of the above is loaded at all", () => {
    expect(CSS).toMatch(/@import\s+["']@shared\/design-tokens\/tokens\.css["']/);
  });

  it("aliases `--color-*`, so an organiser's palette rides through the contract", () => {
    // The one mapping decision that matters on this surface. The palette is
    // injected at runtime as `--color-*` overrides on <html>; a literal here
    // would pin the evergreen fallback into every wedding's invite, and the
    // failure would look like "the theme picker stopped working" with nothing
    // pointing back at this file.
    const mapping = CSS.slice(CSS.indexOf("--ui-ground:"), CSS.indexOf("--ui-radius-hair:"));
    const literals = [...mapping.matchAll(/(--ui-[\w-]+):\s*(oklch|#)/gi)].map((m) => m[1]);
    expect(literals).toEqual([]);
    expect(mapping).toMatch(/--ui-ground:\s*var\(--color-bg\)/);
  });

  it("names the control boundary rather than leaving it written out", () => {
    // `border-text/55` appears at every form control on the guest site — the
    // claim-code box, the three gift-registry fields. That is a token by any
    // other measure, and the contract needs it by name to hold it to 3:1.
    expect(CSS).toMatch(/--color-border-strong:/);
    expect(CSS).toMatch(/--ui-hairline-strong:\s*var\(--color-border-strong\)/);
  });

  it("maps all seven type steps rather than leaving gaps for the fallback", () => {
    for (const step of ["xs", "sm", "base", "md", "lg", "xl", "2xl"]) {
      expect(CSS).toMatch(new RegExp(`--ui-text-${step}:`));
    }
  });
});
