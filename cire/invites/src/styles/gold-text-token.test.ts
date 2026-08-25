import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Drift guard for the split between the two golds.
 *
 * `--color-gold` is the METAL — rules, borders, fills, icons, large display
 * text — and `derivePalette` deliberately holds it to the 3:1 WCAG UI floor so
 * a genuinely gold gold survives instead of being bleached into a cream.
 * `--color-gold-ink` is the same hue walked to the 4.5:1 TEXT minimum against
 * all three surfaces. Painting normal-size text in the metal is therefore a
 * WCAG 1.4.3 failure by construction, and it is the failure that shipped: a
 * live invite's RSVP-by line measured 3.35:1.
 *
 * `--color-gold-dim` counts as the metal here, and is the worse case of the
 * two: it is the metal at 0.35 alpha, and `contrastOklch` ignores alpha by
 * design (a translucent colour over an unknown backdrop has no single ratio),
 * so NOTHING checks it. Composited it measured 2.05:1 on the built-in scheme —
 * below even the UI floor — while the undimmed metal cleared 8:1. An earlier
 * cut of this guard excluded it by name, which is how the worst ratio on the
 * page became the one thing the guard could not see.
 *
 * Nothing else catches this class of bug. happy-dom computes no colour, so no
 * component test can observe a ratio; the palette tests prove each TOKEN clears
 * its bar but cannot know which one a given element uses; and a build succeeds
 * either way. The usage rule is plain source text, so it is mechanically
 * checkable even though the rendering is not.
 *
 * Deliberately an explicit allow-list rather than a size heuristic: parsing
 * `text-[calc(clamp(2.5rem,8vw,5.5rem)*var(--invite-heading-scale,1))]` to
 * decide whether it clears 24px is exactly the kind of cleverness that fails
 * open. A new metal usage has to be justified here, in one line, by a human.
 */

const SRC = join(import.meta.dirname, "..");

/**
 * A metal text utility: `text-gold` or `text-gold-dim`, with or without an
 * opacity modifier. `text-gold-ink` (and `text-gold-ink/80`) must not match —
 * the negative lookahead after the base rejects the `-ink` suffix, and the
 * `-dim` alternative doesn't apply.
 *
 * The lookahead excludes `-` and word characters but NOT `/`, so an
 * opacity-modified metal (`text-gold/80`) is still caught. That form is the
 * sneakiest version of this bug: an alpha over a surface has no enforceable
 * ratio either, so it looks like a deliberate design choice rather than an
 * unchecked one.
 */
const METAL = /text-gold(?:-dim)?(?![-\w])/g;

/**
 * The metal reached WITHOUT the named utility. Both spellings are ordinary in
 * this codebase and both were proved to slip past a utility-only scan:
 * `text-[var(--color-gold)]` (a Tailwind arbitrary value) and
 * `style={{ color: "var(--color-gold)" }}` (the JSX style-object form that
 * `PaletteField` already uses). The negative lookahead spares `--color-gold-ink`
 * and `--color-gold-dim` is caught by the base alternative.
 */
const METAL_VAR = /(?:text-\[|color:\s*["']?)var\(--color-gold(?!-ink)/g;

/** Text colour set from raw CSS rather than a utility (the `.astro` layouts). */
const CSS_TEXT_COLOUR = /(?<![-\w])color:\s*["']?var\(--color-gold[^)]*\)/g;

/**
 * Comments, stripped before matching.
 *
 * Load-bearing, not tidiness: the rationale comments on the swapped elements
 * NAME the anti-pattern ("`text-gold-ink`, not `text-gold`"). A guard that
 * cannot tell a class from a mention of one taxes every comment that explains
 * the rule — and an earlier cut of this file did exactly that, silently
 * rewriting three of those comments into "not `text-gold-ink`", which asserts
 * nothing. The tax was paid by deleting the documentation that prevents the
 * regression.
 *
 * Block comments cover both `/* … *\/` and the JSX `{/* … *\/}` form. Line
 * comments are only stripped when they START the line, so a `//` inside a
 * string (a URL) can't swallow real code and hide an offender.
 */
function stripComments(source: string): string {
  return (
    source
      // JSX comment containers, and block comments that START a line. Anchored
      // rather than matched anywhere, because `/*` inside a string literal — a
      // CSP source list, a path glob, a URL — would otherwise open a fake
      // comment and swallow real code up to the next `*/`, hiding an offender.
      // Proved with a `"img-src https://cdn.example.com/*"` sandwich: the
      // unanchored version passed while a `text-gold` element sat between.
      // `[ \t]*`, not `\s*`: allowing a NEWLINE between `{` and `/*` makes an
      // ordinary `interface Props {` followed by a JSDoc line look like a JSX
      // comment opener, and the non-greedy body then runs to the first `*/}`
      // anywhere below — which swallowed all of `NotFoundDocument.astro`
      // between its frontmatter and its consent comment, allow-listed metal
      // included. A JSX comment container never has a line break there.
      .replaceAll(/\{[ \t]*\/\*[\s\S]*?\*\/[ \t]*\}/g, "")
      .replaceAll(/^[ \t]*\/\*[\s\S]*?\*\//gm, "")
      .replaceAll(/^\s*\/\/[^\n]*$/gm, "")
  );
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    // `.ts` too: a plain module exporting a class-name string literal is a
    // valid Tailwind source (the scanner reads source as text), and there are
    // ~58 such files here the utility scan would otherwise never open.
    if (/\.(tsx|ts|astro)$/.test(entry) && !entry.includes(".test.")) out.push(path);
  }
  return out;
}

function relative(path: string): string {
  return path.slice(SRC.length + 1).replaceAll("\\", "/");
}

/** Metal text utilities per file, comments excluded. */
function metalUsage(): { file: string; metal: number }[] {
  return sourceFiles(SRC)
    .map((path) => ({
      file: relative(path),
      metal: (() => {
        const source = stripComments(readFileSync(path, "utf8"));
        return (source.match(METAL) ?? []).length + (source.match(METAL_VAR) ?? []).length;
      })(),
    }))
    .filter((entry) => entry.metal > 0)
    .toSorted((a, b) => (a.file < b.file ? -1 : 1));
}

/**
 * The only elements allowed to paint text in the metal, with the COUNT each
 * file may contain and why each clears WCAG's large-text bar (24px normal /
 * 18.66px bold) or is exempt from it.
 *
 * The count is the point. An earlier cut compared only the SET of offending
 * files, so three of these five files — which also hold swapped small-text
 * sites — could have had one reverted without the guard noticing.
 *
 * Heading sizes are `clamp()` minimums times the organiser's smallest heading
 * scale (`0.85`, `HEADING_SIZE_SCALES` in `@cire/theme`), so each figure is the
 * smallest the element can actually render at, not the value read off the class.
 */
const ALLOWED: { file: string; metal: number; reason: string }[] = [
  {
    file: "components/LoginSection.tsx",
    metal: 2,
    reason: "the two claim headings — clamp(2rem,…), no heading-scale factor, so 32px",
  },
  {
    file: "components/MapPreview.tsx",
    metal: 1,
    reason: "the map pin — an aria-hidden SVG, a graphical object, not text",
  },
  {
    file: "components/NotFoundDocument.astro",
    metal: 1,
    reason: "the 404 numeral — clamp(3rem,…) = 48px, large text",
  },
  {
    file: "components/gift-registry/GiftRegistryDocument.astro",
    metal: 1,
    reason: "the gift page's masthead heading — clamp(2.25rem,…) × 0.85 = 30.6px, large text",
  },
  {
    file: "designs/classic/InviteHeader.tsx",
    metal: 2,
    reason: "the hero couple names — clamp(2.5rem,…) × 0.85 = 34px, large text",
  },
  {
    file: "designs/gala/InviteHeader.tsx",
    metal: 2,
    reason: "the hero couple names — clamp(2.75rem,…) × 0.85 = 37.4px, large text",
  },
];

describe("gold token usage", () => {
  it("paints no normal-size text in the metal gold", () => {
    // Compared with counts, so adding a metal usage to an already-allow-listed
    // file fails just as loudly as adding a new file.
    expect(metalUsage()).toEqual(ALLOWED.map(({ file, metal }) => ({ file, metal })));
  });

  it("sets no text colour from raw CSS in the metal gold", () => {
    // `SiteFooter.astro` and `LegalLayout.astro` colour text with
    // `var(--color-gold…)` directly rather than through a utility, so the scan
    // above cannot see them. Swept over EVERY walked file rather than a
    // hand-maintained pair, so a third file styling text this way is caught the
    // day it appears.
    const offenders = sourceFiles(SRC).flatMap((path) =>
      (stripComments(readFileSync(path, "utf8")).match(CSS_TEXT_COLOUR) ?? [])
        .filter((declaration) => !declaration.includes("--color-gold-ink"))
        .map((declaration) => ({ file: relative(path), declaration })),
    );
    expect(offenders).toEqual([]);
  });

  it("still finds the raw-CSS declarations it is meant to be checking", () => {
    // Vacuity guard for the test above: if the selector, the file layout or the
    // variable name changes, an empty match set would let it pass while
    // checking nothing.
    const found = sourceFiles(SRC).flatMap(
      (path) => stripComments(readFileSync(path, "utf8")).match(CSS_TEXT_COLOUR) ?? [],
    );
    expect(found.length).toBeGreaterThan(0);
  });

  it("declares the prose token so every swapped utility resolves", () => {
    // A `text-gold-ink` with no `--color-gold-ink` in `@theme` emits no CSS at
    // all — Tailwind silently drops an unknown utility — so the sweep would
    // leave the text unstyled rather than dark. Pin the pair.
    const css = readFileSync(join(SRC, "styles/global.css"), "utf8");
    expect(css).toMatch(/--color-gold-ink:/);
  });
});
