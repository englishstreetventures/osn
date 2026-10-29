import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A ticked checkbox or radio is the browser's own — its blue fill and white
 * tick read as a form control (owner, 2026-10-29; cire/host/DESIGN.md §4,
 * "Checkboxes and radios"). An
 * `accent-*` class would recolour it, and nothing on screen says the rule was
 * broken, so this reads every native `<input type="checkbox">` and
 * `<input type="radio">` under `src/` and fails on any that carries one.
 *
 * Static: a JSX `<input>` is self-closing, so its attributes run from `<input`
 * to the next `/>`, and an arrow function's `=>` cannot end it early.
 */

const SRC = join(import.meta.dirname, "..", "..", "src");

/** Each native checkbox and radio in `src/`, as `file:line` and its tag's text. */
function boxes(): Array<{ at: string; tag: string }> {
  const found: Array<{ at: string; tag: string }> = [];
  const files = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((f) =>
    /\.(tsx|astro)$/.test(f),
  );
  for (const file of files) {
    const text = readFileSync(join(SRC, file), "utf8");
    for (const m of text.matchAll(/<input\b/g)) {
      const end = text.indexOf("/>", m.index);
      const tag = text.slice(m.index, end === -1 ? undefined : end + 2);
      if (!/type=["'](checkbox|radio)["']/.test(tag)) continue;
      const line = text.slice(0, m.index).split("\n").length;
      found.push({ at: `${file}:${line}`, tag });
    }
  }
  return found;
}

describe("native checkboxes and radios", () => {
  it("carry no accent colour, so a ticked one is the browser's own", () => {
    const all = boxes();
    // A scan that found nothing would pass whatever the source says.
    expect(all.length).toBeGreaterThan(5);
    expect(all.filter((box) => /\baccent-/.test(box.tag)).map((box) => box.at)).toEqual([]);
  });
});
