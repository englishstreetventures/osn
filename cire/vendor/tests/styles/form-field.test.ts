import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every form field is the portal's one height, 34px, and a `FORM_FIELD_CLASS`
 * on each `Input` and `Select` is how it gets there (`src/lib/form-field.ts`;
 * the host portal's DESIGN.md §4, "One form-field height"). A field added without it renders
 * at 36px beside 34px neighbours and nothing on screen says so, so this reads
 * every `<Input` and `<Select` tag under `src/` and names those without it.
 * This portal has no filter, so none is allowed.
 *
 * Static: a tag runs from its name to the first `>` outside braces and quotes,
 * so an arrow function's `=>` inside a prop cannot end it early.
 */
const SRC = join(import.meta.dirname, "..", "..", "src");

/** The opening tag at `start` (`<Input` or `<Select`), through its closing `>`. */
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

function fields(): Array<{ file: string; at: string; tag: string }> {
  const found: Array<{ file: string; at: string; tag: string }> = [];
  const files = readdirSync(SRC, { recursive: true, encoding: "utf8" }).filter((f) =>
    f.endsWith(".tsx"),
  );
  for (const file of files) {
    const text = readFileSync(join(SRC, file), "utf8");
    for (const m of text.matchAll(/<(Input|Select)(?=[\s/>])/g)) {
      const line = text.slice(0, m.index).split("\n").length;
      found.push({ file, at: `${file}:${line}`, tag: openingTag(text, m.index) });
    }
  }
  return found;
}

describe("Input and Select", () => {
  it("all carry the one form-field height", () => {
    const all = fields();
    // A scan that found nothing would pass whatever the source says.
    expect(all.length).toBeGreaterThan(5);
    expect(all.filter((f) => !f.tag.includes("FORM_FIELD_CLASS")).map((f) => f.at)).toEqual([]);
  });
});
