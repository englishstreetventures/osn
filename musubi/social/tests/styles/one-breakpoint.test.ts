import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The app has one breakpoint, `md` (768px), where the phone shell hands over to
 * the rail (`DESIGN.md` §Responsive layout). A class that switches anywhere
 * else changes the layout at a width no shell change marks, and the e2e flows,
 * which shoot 390 and 1440, never see the band it changes. So the source is
 * read for any other breakpoint variant: Tailwind's `sm:`, `lg:`, `xl:`,
 * `2xl:`, their `max-*:` forms, and arbitrary `min-[…]:` / `max-[…]:` widths.
 */

const SRC = new URL("../../src/", import.meta.url).pathname;

/** A variant is followed at once by its utility, which tells it from an object key (`sm: "…"`). */
const OTHER_BREAKPOINT =
  /(?<![\w-])(?:(?:max-)?(?:sm|lg|xl|2xl)|(?:min|max)-\[[^\]\s]*\]):(?=[\w[!-])/;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry.name) ? [path] : [];
  });
}

describe("one breakpoint", () => {
  it("knows the variants it is looking for", () => {
    const hits = ["sm:grid-cols-2", "lg:px-8", "max-sm:hidden", "2xl:block", "min-[900px]:flex"];
    expect(hits.filter((hit) => !OTHER_BREAKPOINT.test(`"${hit}"`))).toEqual([]);
    const allowed = ["md:flex-row", "max-md:h-10", 'size="sm"', "text-sm", 'sm: "md:max-w-sm"'];
    expect(allowed.filter((ok) => OTHER_BREAKPOINT.test(`"${ok}"`))).toEqual([]);
  });

  it("switches nothing in src/ at a width other than md", () => {
    const hits = sourceFiles(SRC).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          OTHER_BREAKPOINT.test(line)
            ? [`${relative(SRC, file)}:${index + 1}: ${line.trim()}`]
            : [],
        ),
    );
    expect(hits).toEqual([]);
  });
});
