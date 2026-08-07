import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Drift guard for the two layout utilities in `global.css` (`page-frame`,
 * `auto-grid`) and the custom properties that tune them.
 *
 * Why this exists: Tailwind silently ignores a class it doesn't recognise and CSS
 * silently ignores a custom property nobody reads. Rename an `@utility`, or typo
 * `[--autogrid-min:20rem]`, and there is no build error, no lint error and no
 * component-test failure — just every card grid collapsing to one column, or the
 * whole portal losing its measure, with a green suite. Container queries can't be
 * tested here (happy-dom evaluates no CSS), but *this* class of breakage is plain
 * text, so it can be.
 *
 * Deliberately static: no DOM, no CSSOM, no build step.
 */

const SRC = join(import.meta.dirname, "..");
const CSS = readFileSync(join(SRC, "styles/global.css"), "utf8");

/** Every `.tsx` / `.astro` / `.css` file under `src/`, excluding tests. */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      sourceFiles(path, acc);
      continue;
    }
    if (!/\.(tsx|astro|css)$/.test(entry) || entry.includes(".test.")) continue;
    acc.push(path);
  }
  return acc;
}

const FILES = sourceFiles(SRC);
const ALL_SOURCE = FILES.map((f) => readFileSync(f, "utf8")).join("\n");

/** The utility names `global.css` actually defines. */
const DEFINED_UTILITIES = new Set(
  [...CSS.matchAll(/@utility\s+([a-z0-9-]+)\s*\{/g)].map((m) => m[1]!),
);

/** The body of one `@utility` block, for reading its `var(--…)` references. */
function utilityBody(name: string): string {
  const start = CSS.indexOf(`@utility ${name} {`);
  if (start === -1) return "";
  let depth = 0;
  for (let i = CSS.indexOf("{", start); i < CSS.length; i++) {
    if (CSS[i] === "{") depth++;
    else if (CSS[i] === "}" && --depth === 0) return CSS.slice(start, i + 1);
  }
  return "";
}

describe("layout utilities", () => {
  it("defines the two utilities the portal's layout is built on", () => {
    expect(DEFINED_UTILITIES).toContain("page-frame");
    expect(DEFINED_UTILITIES).toContain("auto-grid");
  });

  it("uses both utilities from source (a rename would orphan every call site)", () => {
    for (const name of ["page-frame", "auto-grid"]) {
      const uses = [...ALL_SOURCE.matchAll(new RegExp(`class="[^"]*\\b${name}\\b`, "g"))];
      expect(uses.length, `${name} has no call sites`).toBeGreaterThan(0);
    }
  });

  it("reads every layout custom property that source files set", () => {
    // Every `[--foo:bar]` arbitrary property written in a class attribute must be
    // one the utilities actually read, or it tunes nothing.
    const set = new Set(
      [...ALL_SOURCE.matchAll(/\[(--(?:page-max|auto-grid)[a-z-]*):[^\]]+\]/g)].map((m) => m[1]!),
    );
    const read = new Set(
      [...CSS.matchAll(/var\((--(?:page-max|auto-grid)[a-z-]*)/g)].map((m) => m[1]!),
    );
    expect(set.size, "no layout custom properties found in source").toBeGreaterThan(0);
    for (const property of set) {
      expect(read, `${property} is set in a class but no @utility reads it`).toContain(property);
    }
  });

  it("keeps every layout custom property inside the utility that owns it", () => {
    expect(utilityBody("page-frame")).toContain("var(--page-max");
    const autoGrid = utilityBody("auto-grid");
    expect(autoGrid).toContain("var(--auto-grid-min");
    expect(autoGrid).toContain("var(--auto-grid-gap");
  });

  it("gives every layout custom property a fallback", () => {
    // `var(--auto-grid-min)` with no fallback would collapse every grid that
    // doesn't set it — and most call sites rely on the default.
    for (const [, ref] of CSS.matchAll(/(var\((--(?:page-max|auto-grid)[a-z-]*)[^)]*\))/g)) {
      expect(ref, `${ref} has no fallback value`).toMatch(/,/);
    }
  });

  it("keeps auto-grid's track minimum a fixed length", () => {
    // `minmax(min(100%, <length>), 1fr)` never asks a child for its intrinsic
    // contribution. That is what makes it safe to put `container-type:
    // inline-size` (`@container/card`) on an auto-grid child: swapping the
    // minimum for `min-content` / `max-content` / `auto` would ask an
    // inline-size container for a contribution it cannot give and collapse the
    // track to zero width.
    const track =
      /grid-template-columns:\s*repeat\(\s*auto-fit\s*,\s*minmax\(\s*min\(\s*100%\s*,\s*var\(--auto-grid-min\s*,\s*[\d.]+rem\s*\)\s*\)\s*,\s*1fr\s*\)\s*\)/;
    expect(utilityBody("auto-grid")).toMatch(track);
  });
});

describe("the `frame` container", () => {
  const INDEX_ASTRO = readFileSync(join(SRC, "pages/index.astro"), "utf8");

  it("is declared on the document wrapper, since every `@2xl/frame:*` class is inert without it", () => {
    // `@container/frame` is declared in exactly ONE place, and `page-frame`
    // (asserted above) is NOT it — that utility sets width/max-width/margin/
    // padding and establishes no container. Nothing else in the package renders
    // `index.astro`, so without this line the declaration is unguarded.
    //
    // What breaks if it is dropped or renamed: every container-scoped class in
    // the top bar goes inert while every test stays green, because they are all
    // class-string assertions. Concretely, `PreviewInviteButton`'s label stays
    // `sr-only` at EVERY width — which is the "no visible route to the invite
    // preview" regression this guard exists downstream of — and the bar loses
    // its `@2xl/frame:h-16`, the role badge and the ⌘K hint.
    expect(INDEX_ASTRO).toContain("@container/frame");
  });

  it("declares every container that a `@<size>/<name>:` variant queries", () => {
    // A variant naming a container nobody declares compiles to CSS that can
    // never match — silently, exactly like a misspelled utility, and with the
    // same green suite. `frame` is only the one this file is named for; the
    // portal runs six others (`shell`, `panel`, `page`, `card`, `enquiries`,
    // `builder`), each declared next to the component that owns it, and every
    // one of them is a rename away from the same failure.
    const queried = new Set(
      [...ALL_SOURCE.matchAll(/@[\w.[\]()-]+\/([\w-]+):/g)].map((m) => m[1]!),
    );
    expect(queried.size).toBeGreaterThan(0);

    const undeclared = [...queried].filter(
      (name) => !new RegExp(String.raw`@container/${name}\b`).test(ALL_SOURCE),
    );
    expect(undeclared).toEqual([]);
  });
});
