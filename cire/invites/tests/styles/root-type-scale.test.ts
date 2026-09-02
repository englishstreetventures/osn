import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Drift guard for the guest invite's root type scale in `global.css`.
 *
 * Why this exists: the invite's entire type scale is written in rem — every
 * `text-[0.82rem]`, every heading `clamp()` curve — so the root `font-size` is
 * the single lever that sizes all of it. Nothing else can catch a change to it.
 * happy-dom evaluates no CSS, so no component test can observe a rendered size;
 * a build succeeds either way; and losing the desktop step would show up only
 * as "the invite looks small on a laptop", which is exactly the report this
 * rule was added to answer. The rule is plain text, so *this* class of
 * breakage is mechanically checkable even though the rendering isn't.
 *
 * Deliberately static: no DOM, no CSSOM, no build step.
 */

const CSS = readFileSync(join(import.meta.dirname, "../../src/styles/global.css"), "utf8");

describe("root type scale", () => {
  it("keeps the 16px base every rem in the invite is measured against", () => {
    expect(CSS).toMatch(/html\s*\{[^}]*font-size:\s*16px/);
  });

  it("steps the root size up on desktop", () => {
    // The pair that matters: a desktop-width media query, and a root font-size
    // inside it that is larger than the 16px base.
    const step = CSS.match(
      /@media\s*\(min-width:\s*(\d+)px\)\s*\{\s*html\s*\{\s*font-size:\s*(\d+)px/,
    );
    expect(step).not.toBeNull();
    const [, breakpoint, size] = step!;
    expect(Number(breakpoint)).toBeGreaterThanOrEqual(1024);
    expect(Number(size)).toBeGreaterThan(16);
  });

  it("states the desktop breakpoint in px, never rem", () => {
    // A rem breakpoint here would be a trap rather than a bug: `rem` inside a
    // media query resolves against the root's INITIAL size, not the one this
    // very rule sets, so it would read correctly and behave inconsistently with
    // the declared base. px keeps the query from appearing to chase the size it
    // is setting.
    const queries = CSS.match(/@media\s*\([^)]*\)\s*\{\s*html\s*\{\s*font-size/g) ?? [];
    expect(queries.length).toBeGreaterThan(0);
    for (const query of queries) expect(query).not.toContain("rem");
  });
});
