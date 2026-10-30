import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A ticked checkbox or radio is the browser's own — its blue fill and white
 * tick read as a form control (owner, 2026-10-29; DESIGN.md §4, "Checkboxes and radios"). An
 * `accent-*` class would recolour it, and nothing on screen says the rule was
 * broken, so this reads every native `<input type="checkbox">` and
 * `<input type="radio">` under `src/` and fails on any that carries one. The
 * native inputs left are the radio cards; every other box is `@shared/ui`'s
 * `Checkbox` or `RadioGroup`, and the second case reads every one of those in
 * the four cire apps and fails on any that does not draw the browser's box
 * (`box="native"`) — left out, the part draws pulse's gold box instead.
 *
 * Static: a JSX `<input>` is self-closing, so its attributes run from `<input`
 * to the next `/>`, and an arrow function's `=>` cannot end it early. A part's
 * opening tag runs to the first `>` outside braces and quotes.
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
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.filter((box) => /\baccent-/.test(box.tag)).map((box) => box.at)).toEqual([]);
  });
});

const APPS = ["host", "vendor", "invites", "landing"].map((app) =>
  join(import.meta.dirname, "..", "..", "..", app, "src"),
);

/** The opening tag at `start`, through its closing `>`. */
function openingTag(text: string, start: number): string {
  let depth = 0;
  let quote = "";
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quote) {
      if (ch === quote) quote = "";
    } else if (depth === 0 && (ch === '"' || ch === "'")) {
      quote = ch;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
    } else if (ch === ">" && depth === 0) {
      return text.slice(start, i + 1);
    }
  }
  return text.slice(start);
}

/** Every `<Checkbox` and `<RadioGroup` (not its items) in the four apps, as `app/file:line` and its tag. */
function parts(): Array<{ at: string; tag: string }> {
  const found: Array<{ at: string; tag: string }> = [];
  for (const src of APPS) {
    const app = src.split("/").at(-2)!;
    for (const file of readdirSync(src, { recursive: true, encoding: "utf8" })) {
      if (!file.endsWith(".tsx")) continue;
      const text = readFileSync(join(src, file), "utf8");
      for (const m of text.matchAll(/<(Checkbox|RadioGroup)(?=[\s/>])/g)) {
        const line = text.slice(0, m.index).split("\n").length;
        found.push({ at: `${app}/${file}:${line}`, tag: openingTag(text, m.index) });
      }
    }
  }
  return found;
}

describe("@shared/ui's Checkbox and RadioGroup in cire", () => {
  it("draw the browser's own box, box=native, in every app", () => {
    const all = parts();
    expect(all.length).toBeGreaterThan(15);
    expect(all.filter((p) => !/\bbox="native"/.test(p.tag)).map((p) => p.at)).toEqual([]);
  });
});
