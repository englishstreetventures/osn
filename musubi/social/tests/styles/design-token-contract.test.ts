/**
 * Does musubi's mapping onto `@shared/design-tokens` actually clear the
 * contrast floors the contract promises?
 *
 * This is the app's half of the contract. `@shared/design-tokens` says what the
 * roles are and what each one owes; this asserts that the colours musubi sends
 * to those roles pay it. A shared component rendered here reads the contract,
 * so a mapping that quietly puts secondary ink under 4.5:1 makes every
 * `@shared/ui` primitive illegible in this app and in no other.
 *
 * It parses the stylesheet rather than a duplicated table of colours, because a
 * duplicated table is the thing that drifts.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { checkContractConformance } from "@shared/design-tokens/conformance";
import { describe, expect, it } from "vitest";

const CSS = readFileSync(fileURLToPath(new URL("../../src/App.css", import.meta.url)), "utf8");

/**
 * Light is the bare `:root`; dark overrides it via `.dark` on `<html>`
 * (`src/lib/theme.ts`). Dark is therefore `:root` THEN `.dark` — the class
 * supplies only what it changes, and everything it does not override still
 * comes from `:root`.
 */
const SCOPES = [
  { name: "light", selectors: [":root"] },
  { name: "dark", selectors: [":root", ".dark"] },
] as const;

/**
 * Two tokens musubi maps but cannot currently defend, both predating this
 * contract and both tracked.
 *
 * A waiver suppresses the assertion; it does not change what renders. Both are
 * still mapped, so components draw musubi's colours rather than falling back to
 * the package's neutral greyscale — the point of waiving is to stop a known,
 * filed defect blocking unrelated work, not to hide it.
 */
const WAIVED = {
  "--ui-hairline-strong": [
    "`--input` is #e2e2e2 (1.30:1 on --background, 1.18:1 on --muted) and",
    "#3a3a3a in dark (1.50:1 / 1.24:1), against a 3:1 floor. The fix is a",
    "design decision — darken the border and lose the hairline look, or give",
    "controls a perceivable fill and keep it. Tracked as osn-tracker#653.",
  ].join(" "),
  "--ui-ink-tertiary": [
    "`--subtle` is #9e9e9e, 2.68:1 on --background and 2.44:1 on --muted in",
    "light, against a 3:1 floor. Dark passes at 3.97 / 3.30. Tracked as",
    "osn-tracker#653; the proposed fix is #8d8d8d.",
  ].join(" "),
} as const;

describe("design-token contract", () => {
  it("maps every role without breaking contrast, in both themes", () => {
    // `check` rather than `assert` so a failure arrives as a diff of readable
    // lines against `[]`, listing every bad pair at once. The thrown form
    // reports the same information, but vitest renders it as one long string
    // and the reader has to find the pair that moved inside it.
    const failures = checkContractConformance({ css: CSS, scopes: SCOPES, waived: WAIVED });
    expect(failures.map((f) => `[${f.scope}] ${f.fg} on ${f.bg} — ${f.reason}`)).toEqual([]);
  });

  it("imports the contract stylesheet, or none of the above is loaded at all", () => {
    // Without the import the mapping below is a block of custom properties no
    // utility reads, and this file would assert happily about a contract the
    // app does not actually use.
    expect(CSS).toMatch(/@import\s+["']@shared\/design-tokens\/tokens\.css["']/);
  });

  it("sends shadcn's neutral `--accent` to a surface, never to `--ui-accent-soft`", () => {
    // The trap the contract's own docs call out: shadcn's `--accent` is a
    // neutral grey here, and `--ui-accent-soft` means a tint of the ACCENT.
    // Getting this wrong gives components a grey wash where they asked for a
    // brand one — subtle enough to survive review, obvious in a design.
    expect(CSS).toMatch(/--ui-accent-soft:\s*var\(--muted\)/);
    expect(CSS).not.toMatch(/--ui-accent-soft:\s*var\(--accent\)/);
  });

  it("maps the contract through aliases, so `.dark` carries it automatically", () => {
    // A literal here would pin the light value into both themes, and the
    // failure would look like "dark mode ignores the theme" three steps later.
    const mapping = CSS.slice(CSS.indexOf("--ui-ground:"), CSS.indexOf("--ui-radius-hair:"));
    const literals = [...mapping.matchAll(/(--ui-[\w-]+):\s*(#[0-9a-f]{3,8})/gi)];
    expect(literals.map((m) => m[1])).toEqual([]);
  });

  it("maps all seven type steps rather than leaving gaps for the fallback", () => {
    // musubi's own scale is four steps. A shared component using a step the app
    // has not mapped renders the package's neutral default, which is a
    // different type system showing through in the middle of this one.
    for (const step of ["xs", "sm", "base", "md", "lg", "xl", "2xl"]) {
      expect(CSS).toMatch(new RegExp(`--ui-text-${step}:`));
    }
  });
});
