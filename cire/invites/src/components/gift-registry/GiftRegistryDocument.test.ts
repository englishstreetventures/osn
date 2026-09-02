import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * Drift guard for the gift page's shell.
 *
 * This file is the SOLE production caller of two things this branch also added
 * tests for — `invitePath` and `Z_CLASS.STICKY_RAIL` — and a unit test of a
 * helper nobody calls is a test that passes after the behaviour is removed.
 * Both edits below are one line, look harmless, and fail in a way no other test
 * in the workspace can see:
 *
 *  - writing `` `/${slug}` `` instead of `invitePath(slug)` ships an unencoded
 *    slug in the rail's back link, the signed-out prompt and the closed-list
 *    note, all three of which are the way back to the invitation;
 *  - writing `z-10` instead of `Z_CLASS.STICKY_RAIL` puts the rail under the
 *    cards, so the way home disappears from the moment the guest scrolls —
 *    which is the moment it matters.
 *
 * There is no Astro test harness in this workspace, so this is a source-text
 * guard in the same shape as `pages/_index.test.ts` and
 * `pages/[slug]/_registry.test.ts`.
 */
describe("GiftRegistryDocument.astro (the gift page's shell)", () => {
  const source = readFileSync(join(import.meta.dirname, "GiftRegistryDocument.astro"), "utf8");
  // Assertions run against the CODE, not the prose: this file's comments
  // legitimately explain every alternative it does NOT take.
  const code = source
    .replaceAll(/\{[ \t]*\/\*[\s\S]*?\*\/[ \t]*\}/g, "")
    .replaceAll(/^[ \t]*\/\/.*$/gm, "");

  it("builds the way back through invitePath, so the slug is encoded", () => {
    expect(code).toContain("invitePath(slug)");
    expect(code).not.toContain("`/${slug}`");
  });

  it("puts the sticky rail on its own layer, not a hand-written z-index", () => {
    expect(code).toContain("Z_CLASS.STICKY_RAIL");
    expect(code).not.toMatch(/class=["'][^"']*\bz-\d+/);
  });

  it("hydrates the island on load, never on visible", () => {
    // Its first job is a credentialed read that only it can make. Waiting for
    // the viewport would mean waiting to find out whether the guest is even
    // allowed in.
    expect(code).toContain("client:load");
    expect(code).not.toContain("client:visible");
  });

  it("resolves the masthead heading from the invite's copy alone", () => {
    // The `null` is deliberate: the registry module's own headline arrives with
    // the gated list, so the island renders the intro and the chain is never
    // run twice, in two places, with two answers.
    expect(code).toContain("giftRegistryHeading(invite?.registry?.heading, null)");
  });

  it("filters theme values before they reach a style attribute", () => {
    // `themeVars` is spread into the island's `style` object, and the allow-list
    // is what stops an organiser-supplied value getting there unvalidated.
    expect(code).toContain("filterThemeVars(sectionVars(");
  });
});
