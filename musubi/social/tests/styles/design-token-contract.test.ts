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
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { contrastOklch, type Oklch, oklchToRgb, parseColor, rgbToOklch } from "@shared/color";
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
 * One token musubi maps but cannot currently defend, predating this contract.
 *
 * A waiver suppresses the assertion; it does not change what renders. The token
 * is still mapped, so components draw musubi's colour rather than falling back
 * to the package's neutral greyscale — the point of waiving is to stop a known
 * defect blocking unrelated work, not to hide it.
 */
const WAIVED = {
  "--ui-hairline-strong": [
    "`--input` is #e2e2e2 (1.30:1 on --background, 1.18:1 on --muted) and",
    "#3a3a3a in dark (1.50:1 / 1.24:1), against a 3:1 floor. The fix is a",
    "design decision — darken the border and lose the hairline look, or give",
    "controls a perceivable fill and keep it.",
  ].join(" "),
} as const;

/**
 * Every custom property one theme declares, a later block winning, as the
 * cascade has it. Musubi's theme blocks are flat and start their line, so a
 * block body runs to its first `}`.
 */
function declarations(selectors: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const selector of selectors) {
    const block = new RegExp(`^${selector.replaceAll(".", "\\.")}\\s*\\{([^}]*)\\}`, "gm");
    for (const [, body] of CSS.matchAll(block)) {
      for (const [, name, value] of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
        out.set(name, value.trim());
      }
    }
  }
  return out;
}

/** A token's colour in one theme, followed through its `var()` hops. */
function colour(name: string, decls: Map<string, string>): Oklch {
  let value = decls.get(name);
  for (let hop = 0; value?.startsWith("var(") && hop < 8; hop++) {
    value = decls.get(/^var\(\s*(--[\w-]+)/.exec(value)?.[1] ?? "");
  }
  const parsed = value === undefined ? null : parseColor(value);
  if (!parsed) throw new Error(`\`${name}\` does not resolve to a colour`);
  return parsed;
}

/** `ink` at `alpha` laid over an opaque `ground`, composited in sRGB as a browser does. */
function over(ink: Oklch, alpha: number, ground: Oklch): Oklch {
  const i = oklchToRgb(ink);
  const g = oklchToRgb(ground);
  return rgbToOklch({
    r: alpha * i.r + (1 - alpha) * g.r,
    g: alpha * i.g + (1 - alpha) * g.g,
    b: alpha * i.b + (1 - alpha) * g.b,
  });
}

describe("design-token contract", () => {
  it("maps every role without breaking contrast, in both themes", () => {
    // `check` rather than `assert` so a failure arrives as a diff of readable
    // lines against `[]`, listing every bad pair at once. The thrown form
    // reports the same information, but vitest renders it as one long string
    // and the reader has to find the pair that moved inside it.
    const failures = checkContractConformance({ css: CSS, scopes: SCOPES, waived: WAIVED });
    expect(failures.map((f) => `[${f.scope}] ${f.fg} on ${f.bg} — ${f.reason}`)).toEqual([]);
  });

  it("holds danger ink to 4.5:1 on the grounds an error line sits on", () => {
    // The contract measures `--ui-danger` only as a fill, but every error line
    // and the shell's failed-load lines paint it as text. On the page, a card
    // and a popover it clears the floor in both themes. On `--muted` and
    // `--secondary` it does not in light (4.34:1), so no error line sits on
    // them, nor on the warn wash.
    const grounds = [
      "--ui-ground",
      "--ui-surface",
      "--ui-surface-raised",
      "--ui-ground-deep",
      "--ui-surface-sunk",
    ];
    const failures = checkContractConformance({
      css: CSS,
      scopes: SCOPES,
      pairs: grounds.map((bg) => ({ fg: "--ui-danger", bg, min: 4.5 })),
    });
    expect(failures.map((f) => `[${f.scope}] ${f.fg} on ${f.bg}`)).toEqual([
      "[light] --ui-danger on --ui-ground-deep",
      "[light] --ui-danger on --ui-surface-sunk",
    ]);
  });

  it("holds warn ink to 4.5:1 on a warn `Notice`'s wash, in both themes", () => {
    // Warn is ink in one place only: inside a `Notice` (the legal pages' draft
    // line), whose words and mark paint `--ui-warn` over a wash of the same
    // hue laid on the page. The contract measures warn on the bare grounds,
    // and the wash lowers the ratio. The wash's strength and the ink are read
    // from the part itself, so a change to either fails here rather than
    // leaving this measuring a notice that no longer paints.
    const notice = readFileSync(
      createRequire(import.meta.url).resolve("@shared/ui/ui/notice"),
      "utf8",
    );
    expect(notice).toMatch(/\bwarn:\s*"base:text-ui-warn"/);
    const percent = /\bwarn:\s*"base:bg-ui-warn\/(\d+)"/.exec(notice)?.[1];
    expect(percent, "notice.tsx's warn fill is no longer `base:bg-ui-warn/N`").toBeDefined();
    const alpha = Number(percent) / 100;

    const ratios = SCOPES.map((scope) => {
      const decls = declarations(scope.selectors);
      const ink = colour("--ui-warn", decls);
      return {
        scope: scope.name,
        ratio: contrastOklch(ink, over(ink, alpha, colour("--ui-ground", decls))),
      };
    });
    expect(
      ratios.filter((r) => r.ratio < 4.5).map((r) => `[${r.scope}] ${r.ratio.toFixed(2)}:1`),
    ).toEqual([]);
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
