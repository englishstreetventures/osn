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
import { isValidColor as renderSideValidator } from "./dress-code-render";

describe("WT-S-L1 colour-validator identity", () => {
  it("render-side isValidColor IS the @cire/theme isSafeCssColor (same function reference)", () => {
    // If dress-code-render.ts ever changes from a direct re-export to a local
    // implementation or wrapper, this identity check will fail, alerting us
    // that write-side and render-side may diverge.
    expect(renderSideValidator).toBe(isSafeCssColor);
  });

  it("render-side and write-side agree on every accepted colour (behavioural cross-check)", () => {
    const accepted = [
      "#fff",
      "#aabbccff",
      "#ffffff",
      "#ffffffff",
      "rgb(255, 0, 0)",
      "rgba(255, 0, 0, 0.5)",
      "hsl(120, 100%, 50%)",
      "oklch(74.99% 0.0854 82.08)",
      "oklch(22.7% 0.0275 152.78)",
    ];
    for (const color of accepted) {
      expect(renderSideValidator(color), `render-side must accept ${color}`).toBe(true);
      expect(isSafeCssColor(color), `write-side must accept ${color}`).toBe(true);
    }
  });

  it("render-side and write-side agree on every rejected colour (no split allows/blocks)", () => {
    const rejected = [
      "red",
      "rebeccapurple",
      "var(--colour)",
      "expression(alert(1))",
      "url(https://evil.example/x.png)",
      "",
      "   ",
    ];
    for (const color of rejected) {
      expect(renderSideValidator(color), `render-side must reject ${JSON.stringify(color)}`).toBe(
        false,
      );
      expect(isSafeCssColor(color), `write-side must reject ${JSON.stringify(color)}`).toBe(false);
    }
  });
});
