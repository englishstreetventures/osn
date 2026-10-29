import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A control that takes focus fades only its text, background, border and
 * underline colours on hover, so its focus ring shows the moment focus lands.
 * Tailwind's `transition-colors` also fades `outline-color`, so the ring would
 * fade in over the hover's duration. A focusable control names its properties
 * instead: `transition-ui-colors`, the utility that lists those four properties.
 *
 * Static: this reads each opening tag of a button, link, field or `Button`, of
 * any tag with a `tabindex`, and each `buttonClass(` call under `src/`, and
 * lists the ones whose class text holds `transition-colors`. A tag runs to the
 * first `>` outside braces and quotes, so an arrow function's `=>` cannot end it
 * early. A class built elsewhere and passed in is not seen here.
 */

const SRC = join(import.meta.dirname, "..", "..", "src");

const FOCUSABLE = /^<(?:button|a|input|select|textarea|Button)(?=[\s/>])/;

/** The opening tag at `start`, through its closing `>` outside braces and quotes. */
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

/** The call at `start` (`buttonClass(`), through its matching `)`. */
function callText(text: string, start: number): string {
  let depth = 0;
  for (let i = text.indexOf("(", start); i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")" && (depth -= 1) === 0) return text.slice(start, i + 1);
  }
  return text.slice(start);
}

/** Every focusable control's opening tag or class call in `src/`, as `file:line` and its text. */
function controls(): Array<{ at: string; text: string }> {
  const found: Array<{ at: string; text: string }> = [];
  const files = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((f) =>
    /\.(tsx|astro)$/.test(f),
  );
  for (const file of files) {
    const source = readFileSync(join(SRC, file), "utf8");
    const add = (index: number, text: string) =>
      found.push({ at: `${file}:${source.slice(0, index).split("\n").length}`, text });
    for (const m of source.matchAll(/<[A-Za-z][\w.]*(?=[\s/>])/g)) {
      const tag = openingTag(source, m.index);
      if (FOCUSABLE.test(tag) || /\btabindex\b/i.test(tag)) add(m.index, tag);
    }
    for (const m of source.matchAll(/\bbuttonClass\(/g)) add(m.index, callText(source, m.index));
  }
  return found;
}

describe("focusable controls", () => {
  it("fade no outline colour, so the focus ring lands at once", () => {
    const all = controls();
    // A scan that found nothing would pass whatever the source says.
    expect(all.length).toBeGreaterThan(50);
    expect(all.filter((c) => c.text.includes("transition-colors")).map((c) => c.at)).toEqual([]);
  });
});
