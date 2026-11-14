/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

/**
 * The views' own classes write only the `ui-*` contract (`DESIGN.md` §2): a
 * class in a host's vocabulary renders right in Musubi, which defines that
 * vocabulary, and wrong in any host that does not, so no test in Musubi and no
 * end-to-end flow can see it. Each check reads every source file's string
 * literals, comments left out, so a rule named in prose is not a class.
 */

const files = import.meta.glob<string>("../src/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
});

const sources = Object.entries(files).map(([path, source]) => ({
  file: path.replace("../src/", ""),
  text: stringsOf(source),
}));

/** The source's string literals, with every comment gone. */
function stringsOf(source: string): string {
  const code = source
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  const literals = code.match(/"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\.)*`|'(?:[^'\\\n]|\\.)*'/g);
  return (literals ?? []).join("\n");
}

/** Every match of `pattern` across the sources, as `file: class`. */
function hits(pattern: RegExp): string[] {
  return sources.flatMap(({ file, text }) =>
    [...text.matchAll(pattern)].map((match) => `${file}: ${match[0]}`),
  );
}

// A class may carry variants (`max-md:`, `hover:`) before it and an opacity
// after it (`/40`).
const VARIANTS = String.raw`(?<![\w:/-])(?:[\w-]+:)*`;
const END = String.raw`(?:\/\d+)?(?![\w-])`;

const COLOUR_PREFIXES = [
  "text",
  "bg",
  "border",
  "border-[trblxy]",
  "ring",
  "ring-offset",
  "outline",
  "divide",
  "fill",
  "stroke",
  "placeholder",
  "decoration",
  "caret",
  "accent",
  "shadow",
  "from",
  "via",
  "to",
];
const HOST_COLOURS = [
  "primary",
  "secondary",
  "accent",
  "destructive",
  "muted",
  "popover",
  "input",
  "ring",
  "card",
  "background",
  "foreground",
  "border",
  "subtle",
  "success",
  "warning",
];

describe("the views' own classes", () => {
  it("reads the sources", () => {
    expect(sources.length).toBeGreaterThan(10);
    expect(sources.some(({ text }) => text.includes("text-ui-ink"))).toBe(true);
  });

  it("name no host colour, only ui-* roles", () => {
    const pattern = new RegExp(
      `${VARIANTS}(?:${COLOUR_PREFIXES.join("|")})-(?:${HOST_COLOURS.join("|")})(?:-foreground)?${END}`,
      "g",
    );
    expect(hits(pattern)).toEqual([]);
  });

  it("name no Tailwind palette colour", () => {
    const pattern = new RegExp(
      `${VARIANTS}(?:${COLOUR_PREFIXES.join("|")})-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|black|white)(?:-\\d{2,3})?${END}`,
      "g",
    );
    expect(hits(pattern)).toEqual([]);
  });

  it("take type sizes from text-ui-* and no weight above 500", () => {
    const sizes = new RegExp(`${VARIANTS}text-(?:xs|sm|base|lg|xl|[2-9]xl)${END}`, "g");
    const weights = new RegExp(`${VARIANTS}font-(?:semibold|bold|extrabold|black)${END}`, "g");
    expect([...hits(sizes), ...hits(weights)]).toEqual([]);
  });

  it("take corners from rounded-ui-*", () => {
    const pattern = new RegExp(
      `${VARIANTS}rounded(?:-(?:[trbl]|[trbl][lr]|[se][se]?))?(?:-(?:none|sm|md|lg|xl|2xl|3xl|full))?${END}`,
      "g",
    );
    expect(hits(pattern)).toEqual([]);
  });

  it("write no arbitrary value", () => {
    expect(hits(/(?<![\w:/-])(?:[\w-]+:)*[\w-]+-\[[^\]\s]+\]/g)).toEqual([]);
  });

  it("draw no checkbox of their own", () => {
    expect(hits(/type="checkbox"|"checkbox"/g)).toEqual([]);
  });
});
