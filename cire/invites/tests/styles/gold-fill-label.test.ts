import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/*
 * Drift guard: every label on a solid gold fill is written in the on-gold ink.
 *
 * `--color-gold` is held only to the 3:1 UI floor against the page, so a label
 * on it in the page colour (`text-bg`) reads under 4.5:1 on a mid-tone gold —
 * 3.69:1 on chapel, 3.86:1 on garden. `--color-on-gold` is derived to clear
 * 4.5:1 on the gold for every scheme. The rule is per state: a class list that
 * fills an element gold under `hover:` must write its `hover:` text in the
 * on-gold ink, and the same for no variant, `focus:` and `group-hover:`.
 *
 * Nothing else sees this. happy-dom computes no colour, the palette tests prove
 * the token pair but not which token an element uses, and a misspelt utility
 * (`hover:text-on-gol`) compiles to no CSS at all, silently. The contrast
 * browser test measures only the event card and `@cire/ui`'s Button.
 */

const SRC = join(import.meta.dirname, "..", "..", "src");

/** A solid gold fill, under any variant: `bg-gold`, `hover:bg-gold`, … Not `bg-gold/8`, not `bg-gold-dim`. */
const GOLD_FILL = /^((?:[\w-]+:)*)bg-gold$/;

/**
 * The one class list allowed a gold fill with no on-gold label beside it: the
 * event card's answer button, whose label ink lives in its `classList` and
 * flips with the fill under it — the on-gold ink on gold, the page colour on
 * the bloom fill once every member has answered (`EventCard.tsx`).
 */
const LABEL_ELSEWHERE = new Set(["components/EventCard.tsx"]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(tsx|ts|astro)$/.test(entry) && !entry.includes(".test.")) out.push(path);
  }
  return out;
}

/** Comments out, so a sentence that names a class is not read as one. */
function stripComments(source: string): string {
  return source
    .replaceAll(/\{[ \t]*\/\*[\s\S]*?\*\/[ \t]*\}/g, "")
    .replaceAll(/^[ \t]*\/\*[\s\S]*?\*\//gm, "")
    .replaceAll(/^\s*\/\/[^\n]*$/gm, "");
}

/** Every quoted string in the file — where class lists live. */
function strings(source: string): string[] {
  return [...source.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`([^`]*)`/g)].map(
    (m) => m[1] ?? m[2] ?? m[3] ?? "",
  );
}

interface GoldFill {
  file: string;
  variant: string;
  labels: string[];
}

/** Each gold fill found, with the text utilities its own class list gives the same variant. */
function goldFills(): GoldFill[] {
  return sourceFiles(SRC).flatMap((path) => {
    const file = path.slice(SRC.length + 1).replaceAll("\\", "/");
    return strings(stripComments(readFileSync(path, "utf8"))).flatMap((classes) => {
      const tokens = classes.split(/\s+/);
      return tokens.flatMap((token) => {
        const match = GOLD_FILL.exec(token);
        if (!match) return [];
        const variant = match[1] ?? "";
        const labels = tokens.filter(
          (t) => t.startsWith(`${variant}text-`) && !t.slice(variant.length + 5).includes(":"),
        );
        return [{ file, variant, labels }];
      });
    });
  });
}

describe("labels on a gold fill", () => {
  it("never writes the page colour on gold, in any state", () => {
    const offenders = goldFills().filter((fill) => fill.labels.includes(`${fill.variant}text-bg`));
    expect(offenders).toEqual([]);
  });

  it("writes every gold fill's label in the on-gold ink, in the same state", () => {
    const offenders = goldFills().filter(
      (fill) =>
        !LABEL_ELSEWHERE.has(fill.file) && !fill.labels.includes(`${fill.variant}text-on-gold`),
    );
    expect(offenders).toEqual([]);
  });

  it("finds the gold fills it is meant to be checking", () => {
    // Vacuity guard: a changed file layout or class spelling that matched
    // nothing would let both tests above pass while checking nothing. The
    // fills today: the consent "Save choices" button, the answer button, the
    // hover and focus states of the calendar menu's items (one shared class
    // list), the RSVP sheet's submit and both gift-registry links.
    const fills = goldFills();
    expect(fills.length).toBeGreaterThanOrEqual(7);
    expect(new Set(fills.map((f) => f.variant))).toEqual(new Set(["", "hover:", "focus:"]));
  });
});
