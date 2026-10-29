// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The tab icon and the browser's chrome colour are copies of `--color-bg`
 * written by hand. Reading all three from source keeps them one colour.
 */
const ROOT = join(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");

/** `--color-bg: oklch(L% C H)` from a stylesheet, as `#rrggbb`. */
function oklchBgHex(css: string): string {
  const m = /--color-bg:\s*oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)/.exec(css);
  if (!m) throw new Error("--color-bg is not a literal oklch(L% C H)");
  const l = Number(m[1]) / 100;
  const c = Number(m[2]);
  const h = (Number(m[3]) * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l3 = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m3 = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s3 = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const linear = [
    4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.707614701 * s3,
  ];
  return `#${linear
    .map((v) => {
      const x = Math.min(1, Math.max(0, v));
      const encoded = x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
      return Math.round(encoded * 255)
        .toString(16)
        .padStart(2, "0");
    })
    .join("")}`;
}

describe("the page background colour, --color-bg", () => {
  const ground = oklchBgHex(read("src/styles/global.css"));

  it("is the fill of public/favicon.svg's background <rect>", () => {
    const fill = /<rect\b[^>]*\bfill="(#[0-9a-f]{6})"/i.exec(read("public/favicon.svg"))?.[1];
    expect(fill?.toLowerCase()).toBe(ground);
  });

  it("is the theme-color BaseLayout.astro sets", () => {
    const content = /<meta\s+name="theme-color"\s+content="(#[0-9a-f]{6})"/i.exec(
      read("src/layouts/BaseLayout.astro"),
    )?.[1];
    expect(content?.toLowerCase()).toBe(ground);
  });
});
