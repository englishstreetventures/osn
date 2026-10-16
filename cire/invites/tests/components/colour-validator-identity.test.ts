/**
 * WT-S-L1 — colour-validator identity: write-side and render-side must use
 * the same @cire/theme export.
 *
 * The guest site re-validates persisted theme colours at render time
 * (`paletteRootVars` → `isValidColor` from `dress-code-render.ts`).
 * The write gate uses `isSafeCssColor` from `@cire/theme` (via the API
 * schema at `cire/api/src/schemas/invite.ts` and the organiser's
 * `guest-validation.ts`).
 *
 * Both should resolve to the same function from @cire/theme.  If someone
 * inlines a local copy or adds a separate regex, a persisted value could
 * pass the write gate but be silently dropped at render — or vice-versa.
 *
 * The assertion is function-reference identity: both sides must be the exact
 * same function object (not a wrapper, not a reimplementation).
 */

// The shared single source of truth.
import { isSafeCssColor } from "@cire/theme";
import { describe, it, expect } from "vitest";

// Render-side: `isValidColor` in dress-code-render.ts is declared as:
//   export { isSafeCssColor as isValidColor } from "@cire/theme";
// It must be the same function reference as the @cire/theme export, not a
// wrapper or inline copy.
import { isValidColor as renderSideValidator } from "../../src/components/dress-code-render";

describe("WT-S-L1 colour-validator identity", () => {
  it("render-side isValidColor IS the @cire/theme isSafeCssColor (same function reference)", () => {
    // If dress-code-render.ts ever changes from a direct re-export to a local
    // implementation or wrapper, this identity check will fail, alerting us
    // that write-side and render-side may diverge.
    expect(renderSideValidator).toBe(isSafeCssColor);
  });
});
