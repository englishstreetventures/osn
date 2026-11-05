import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * A loading placeholder is `@cire/ui`'s `Skeleton` (cire/host/DESIGN.md §4,
 * englishstreetventures/osn#1837): it takes the corner and fill of what it
 * stands in for, and pulses on the motion tokens with `Loading`. A block drawn
 * by hand with Tailwind's `animate-pulse` picks its own corner and fill and
 * pulses at a fixed pace, and nothing on screen says so, so this reads every
 * source file under `src/` and fails on any that writes the class.
 */

const SRC = join(import.meta.dirname, "..", "..", "src");

function sources(): Array<{ file: string; text: string }> {
  return readdirSync(SRC, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.(tsx?|astro|css)$/.test(file))
    .map((file) => ({ file, text: readFileSync(join(SRC, file), "utf8") }));
}

describe("loading placeholders", () => {
  it("are Skeleton, never a hand-drawn animate-pulse block", () => {
    const all = sources();
    // A scan that read nothing would pass whatever the source says.
    expect(all.length).toBeGreaterThan(100);
    const drawn = all.flatMap(({ file, text }) =>
      text
        .split("\n")
        .flatMap((line, i) => (/\banimate-pulse\b/.test(line) ? [`${file}:${i + 1}`] : [])),
    );
    expect(drawn).toEqual([]);
  });
});
