import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The app has one breakpoint, `md` (768px), where the phone shell hands over to
 * the rail (`DESIGN.md` §Responsive layout). A class or rule that switches
 * anywhere else changes the layout at a width no shell change marks, and the
 * e2e flows, which shoot 390 and 1440, never see the band it changes. So the
 * source is read for any other breakpoint:
 *
 * - in `.ts`, `.tsx` and `.css` files (an `@apply` line included), Tailwind's
 *   `sm:`, `lg:`, `xl:`, `2xl:`, their `max-*:` forms, and arbitrary
 *   `min-[…]:` / `max-[…]:` widths;
 * - in `.css` files, an `@media`, `@custom-variant` or `@variant` line whose
 *   width is anything but `md`'s edge: 767px or 768px (48rem).
 */

const SRC = new URL("../../src/", import.meta.url).pathname;

/** A variant is followed at once by its utility, which tells it from an object key (`sm: "…"`). */
const OTHER_BREAKPOINT =
  /(?<![\w-])(?:(?:max-)?(?:sm|lg|xl|2xl)|(?:min|max)-\[[^\]\s]*\]):(?=[\w[!-])/;

/** A CSS at-rule that can switch on the viewport's width. */
const WIDTH_RULE = /@(?:media|custom-variant|variant)\b/;
/** The widths in `(min-width: X)`, `(max-width: X)`, `(width >= X)` and `(X < width)`. */
const WIDTHS =
  /\((?:min-|max-)?width\s*:\s*([^)\s]+)\s*\)|\bwidth\s*[<>]=?\s*([\d.]+[a-z]+)|([\d.]+[a-z]+)\s*[<>]=?\s*width\b/g;
const MD_EDGE = new Set(["767px", "768px", "48rem"]);

/** True when a CSS line switches at a width other than `md`'s edge. */
function otherWidth(line: string): boolean {
  if (!WIDTH_RULE.test(line)) return false;
  return [...line.matchAll(WIDTHS)].some((m) => !MD_EDGE.has(m[1] ?? m[2] ?? m[3] ?? ""));
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|css)$/.test(entry.name) ? [path] : [];
  });
}

describe("one breakpoint", () => {
  it("knows the variants it is looking for", () => {
    const hits = ["sm:grid-cols-2", "lg:px-8", "max-sm:hidden", "2xl:block", "min-[900px]:flex"];
    expect(hits.filter((hit) => !OTHER_BREAKPOINT.test(`"${hit}"`))).toEqual([]);
    const allowed = ["md:flex-row", "max-md:h-10", 'size="sm"', "text-sm", 'sm: "md:max-w-sm"'];
    expect(allowed.filter((ok) => OTHER_BREAKPOINT.test(`"${ok}"`))).toEqual([]);
  });

  it("knows the CSS widths it is looking for", () => {
    const hits = [
      "@media (min-width: 640px) {",
      "@media (max-width: 1023px) {",
      "@media (width >= 64rem) {",
      "@media (40rem <= width) {",
      "@custom-variant tablet (@media (min-width: 900px));",
      "@media (prefers-reduced-motion: reduce) and (min-width: 1024px) {",
    ];
    expect(hits.filter((hit) => !otherWidth(hit))).toEqual([]);
    const allowed = [
      "@media (max-width: 767px) {",
      "@media (min-width: 768px) {",
      "@media (width >= 48rem) {",
      "@media (prefers-reduced-motion: reduce) {",
      "@media (forced-colors: active) {",
      "  width: 240px;",
    ];
    expect(allowed.filter((ok) => otherWidth(ok))).toEqual([]);
  });

  it("switches nothing in src/ at a width other than md", () => {
    const hits = sourceFiles(SRC).flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          OTHER_BREAKPOINT.test(line) || (file.endsWith(".css") && otherWidth(line))
            ? [`${relative(SRC, file)}:${index + 1}: ${line.trim()}`]
            : [],
        ),
    );
    expect(hits).toEqual([]);
  });
});
