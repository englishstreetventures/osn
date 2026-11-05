import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * The marketing site draws no glass: its stylesheet leaves `@cire/ui`'s
 * `lib/glass.ts` and `segmented-tabs.tsx` out of the Tailwind scan, so none of
 * the portals' frosted rules reaches it. This site has no browser tier, so the
 * guard reads the two lines; `cire/invites`'
 * `tests/styles/no-glass.browser.test.tsx` measures the same rule painted.
 */

const CSS = readFileSync(join(import.meta.dirname, "../../src/styles/global.css"), "utf8");

describe("the marketing site's stylesheet", () => {
  it("leaves the portals' glass out of its scan", () => {
    expect(CSS).toContain('@source not "../../../ui/src/lib/glass.ts";');
    expect(CSS).toContain('@source not "../../../ui/src/segmented-tabs.tsx";');
  });
});
