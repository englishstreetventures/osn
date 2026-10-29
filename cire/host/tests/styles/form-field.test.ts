import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Every form field is the portal's one height, 34px, and a `FORM_FIELD_CLASS`
 * on each `Input` and `Select` is how it gets there (`src/lib/form-field.ts`;
 * DESIGN.md §4, "One form-field height"). A field added without it renders
 * at 36px beside 34px neighbours and nothing on screen says so, so this reads
 * every `<Input` and `<Select` tag under `src/` and names those without it.
 * Those are the filters: `size="sm"` plus `FILTER_FIELD_CLASS`, 28px with round
 * ends, since an `sm` `Select` with no height of its own takes the platform's
 * line and draws 27px on Linux. Each is found by its file and a marker in its
 * own handler, not by line number.
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

/** Each filter: the file it is in and text unique to its own tag. */
const FILTERS = [
  { file: "components/SeatingView.tsx", marker: "setEventId(" },
  { file: "components/GuestTable.tsx", marker: "handleSearchInput(" },
  { file: "components/RsvpView.tsx", marker: "setQuery(" },
  { file: "components/RsvpView.tsx", marker: 'aria-label="Sort guests"' },
  { file: "components/DirectoryBrowseView.tsx", marker: "setCategory(" },
  { file: "components/DirectoryBrowseView.tsx", marker: "setQ(" },
  { file: "components/DirectoryBrowseView.tsx", marker: "setLocation(" },
];

describe("Input and Select", () => {
  it("carry the one form-field height, except the named filters", () => {
    const all = fields();
    // A scan that found nothing would pass whatever the source says.
    expect(all.length).toBeGreaterThan(50);
    const without = all.filter((f) => !f.tag.includes("FORM_FIELD_CLASS"));
    const named = without.map((f) => {
      const filter = FILTERS.find((x) => x.file === f.file && f.tag.includes(x.marker));
      return filter ? `${filter.file} ${filter.marker}` : f.at;
    });
    expect(named.sort()).toEqual(FILTERS.map((x) => `${x.file} ${x.marker}`).sort());
  });

  it("keep each named filter at 28px, size sm with the filter height", () => {
    for (const filter of FILTERS) {
      const tag = fields().find((f) => f.file === filter.file && f.tag.includes(filter.marker));
      expect(tag?.tag, `${filter.file} ${filter.marker}`).toMatch(/\bsize="sm"/);
      expect(tag?.tag, `${filter.file} ${filter.marker}`).toContain("FILTER_FIELD_CLASS");
    }
  });
});
