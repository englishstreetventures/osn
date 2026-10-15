import { describe, expect, it } from "bun:test";

import { PALETTE_SEED_KEYS } from "@cire/theme";

import { InviteThemeBody, THEME_SECTIONS } from "../../src/schemas/invite";

/**
 * Mechanical lockstep between the shared colour vocabulary in `@cire/theme` and
 * the wire body the organiser PUTs.
 *
 * The names are spelled out by hand in four places — this schema, the service's
 * `InviteTheme`, the guest site's `invite-theme.ts`, and the builder's own
 * interface. A renamed or added seed compiles fine on every side and silently
 * drops in transit: the guest ignores the unknown key and renders the default
 * preset, which looks like "the organiser didn't set anything" rather than a
 * bug. The deleted `invite-theme-preview.test.ts` used to catch exactly this
 * class of drift; sharing `derivePalette` removed the need for a MATHS mirror
 * but not for a NAME one.
 *
 * Same spirit as `db/ddl-lockstep.test.ts`: fail in CI, not in a preview deploy.
 */
describe("InviteThemeBody ↔ @cire/theme lockstep", () => {
  const fields = Object.keys(InviteThemeBody.fields);

  it("declares one seed field per palette seed key", () => {
    const expected = PALETTE_SEED_KEYS.map(
      (key) => `palette${key.charAt(0).toUpperCase()}${key.slice(1)}`,
    );
    expect(
      fields.filter((f) => f.startsWith("palette") && f !== "palettePreset").toSorted(),
    ).toEqual(expected.toSorted());
  });

  it("declares one tone field per themeable section", () => {
    const expected = THEME_SECTIONS.map((section) => `${section}Tone`);
    expect(fields.filter((f) => f.endsWith("Tone")).toSorted()).toEqual(expected.toSorted());
  });
});
