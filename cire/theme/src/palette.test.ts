import { describe, expect, test } from "bun:test";

import {
  contrastRatio,
  DERIVED_TOKENS,
  derivePalette,
  FONT_CHOICES,
  FONT_STACKS,
  fontChoiceHasStack,
  fontStack,
  formatOklch,
  isSafeCssColor,
  PALETTE_PRESET_KEYS,
  PALETTE_PRESETS,
  paletteAdjustments,
  parseColor,
  resolveSeeds,
  type PaletteSeeds,
  rgbToOklch,
  sectionToneVars,
  WCAG_TEXT_MIN,
  WCAG_UI_MIN,
} from "./index";

describe("colour round-trip", () => {
  test("hex → oklch → rgb returns the original hex", () => {
    for (const hex of ["#d4af37", "#ffffff", "#000000", "#1b172a", "#c9a961"]) {
      const oklch = parseColor(hex);
      expect(oklch).not.toBeNull();
      const back = parseColor(formatOklch(oklch as never));
      expect(back).not.toBeNull();
      // Compare in sRGB — that's the space the browser paints in.
      const a = contrastRatio(hex, formatOklch(oklch as never));
      expect(a).toBeCloseTo(1, 2);
      expect(back?.l).toBeCloseTo((oklch as never as { l: number }).l, 2);
    }
  });

  test("an oklch input is read directly, not round-tripped through sRGB", () => {
    const parsed = parseColor("oklch(74.99% 0.0854 82.08)");
    expect(parsed?.l).toBeCloseTo(0.7499, 4);
    expect(parsed?.c).toBeCloseTo(0.0854, 4);
    expect(parsed?.h).toBeCloseTo(82.08, 2);
  });

  test("a neutral colour reports a stable hue rather than floating-point noise", () => {
    expect(rgbToOklch({ r: 0.5, g: 0.5, b: 0.5 }).h).toBe(0);
  });

  test("alpha is emitted only when translucent", () => {
    expect(formatOklch({ l: 0.5, c: 0.1, h: 90, a: 1 })).toBe("oklch(50% 0.1 90)");
    expect(formatOklch({ l: 0.5, c: 0.1, h: 90, a: 0.35 })).toBe("oklch(50% 0.1 90 / 0.35)");
  });
});

describe("derivePalette", () => {
  test("emits exactly the declared token set", () => {
    const vars = derivePalette(PALETTE_PRESETS.evergreen);
    expect(Object.keys(vars).toSorted()).toEqual([...DERIVED_TOKENS].toSorted());
  });

  test("is deterministic — same seeds, same output", () => {
    const a = derivePalette(PALETTE_PRESETS.jewel);
    const b = derivePalette({ ...PALETTE_PRESETS.jewel });
    expect(a).toEqual(b);
  });

  test("every emitted value passes the CSS-colour allow-list", () => {
    // Derived tokens are interpolated into guest-facing inline styles exactly
    // like hand-picked ones, so they must clear the same injection gate.
    for (const key of PALETTE_PRESET_KEYS) {
      for (const [token, value] of Object.entries(derivePalette(PALETTE_PRESETS[key]))) {
        expect(isSafeCssColor(value), `${key}/${token} = ${value}`).toBe(true);
      }
    }
  });

  test("a preset with no seed edits renders as THAT preset, not the default", () => {
    // The bug this guards, caught on a live preview: choosing a scheme saves the
    // KEY with five null seeds. When null resolved to the DEFAULT preset, every
    // scheme rendered as the built-in look to guests while previewing correctly
    // in the builder.
    for (const key of PALETTE_PRESET_KEYS) {
      expect(derivePalette({}, key), key).toEqual(derivePalette(PALETTE_PRESETS[key]));
    }
  });

  test("an organiser's own seed still wins over the preset it sits on", () => {
    const v = derivePalette({ gilt: "#112233" }, "chapel");
    expect(v["--color-gold"]).toBe(
      derivePalette({ ...PALETTE_PRESETS.chapel, gilt: "#112233" })["--color-gold"],
    );
    // …and the seeds they did NOT touch still follow chapel.
    expect(v["--color-bg"]).toBe(derivePalette(PALETTE_PRESETS.chapel)["--color-bg"]);
  });

  test("an unknown or absent preset key degrades to the built-in scheme", () => {
    const builtIn = derivePalette(PALETTE_PRESETS.evergreen);
    expect(derivePalette({}, "not-a-preset")).toEqual(builtIn);
    expect(derivePalette({}, null)).toEqual(builtIn);
    expect(derivePalette({})).toEqual(builtIn);
  });

  test("resolveSeeds is the one definition of a half-filled scheme", () => {
    expect(resolveSeeds({ gilt: "#112233" }, "jewel")).toEqual({
      ...PALETTE_PRESETS.jewel,
      gilt: "#112233",
    });
    expect(resolveSeeds(null, "fog")).toEqual({ ...PALETTE_PRESETS.fog });
  });

  test("falls back to the default preset for a missing or unparseable seed", () => {
    const expected = derivePalette(PALETTE_PRESETS.evergreen);
    expect(derivePalette(null)).toEqual(expected);
    expect(derivePalette({ ground: "not-a-colour", card: "" })).toEqual(expected);
  });
});

describe("contrast is enforced, not advised", () => {
  const textPairs = [
    ["--color-text", "--color-bg"],
    ["--color-text", "--color-surface"],
    ["--color-text", "--color-surface-raised"],
  ] as const;
  const uiPairs = [
    ["--color-text-muted", "--color-surface"],
    // The `raised` tone paints whole sections, so text has to clear on it too —
    // it passed by luck of the presets before this pair existed.
    ["--color-text-muted", "--color-bg"],
    ["--color-text-muted", "--color-surface-raised"],
    ["--color-gold", "--color-surface-raised"],
    ["--color-gold", "--color-bg"],
    ["--color-bloom", "--color-bg"],
    ["--invite-focus", "--color-bg"],
    ["--color-error", "--color-surface"],
    ["--color-success", "--color-surface"],
  ] as const;

  for (const key of PALETTE_PRESET_KEYS) {
    test(`preset ${key} clears WCAG on every derived pair`, () => {
      const v = derivePalette(PALETTE_PRESETS[key]);
      for (const [fg, bg] of textPairs) {
        expect(
          contrastRatio(v[fg] as string, v[bg] as string),
          `${key} ${fg}/${bg}`,
        ).toBeGreaterThanOrEqual(WCAG_TEXT_MIN);
      }
      for (const [fg, bg] of uiPairs) {
        expect(
          contrastRatio(v[fg] as string, v[bg] as string),
          `${key} ${fg}/${bg}`,
        ).toBeGreaterThanOrEqual(WCAG_UI_MIN);
      }
    });
  }

  test("a deliberately awful palette still comes out readable", () => {
    // Every seed nearly the same mid-grey — the worst case an organiser can
    // reach with five pickers.
    const awful: PaletteSeeds = {
      ground: "#7a7a7a",
      card: "#7d7d7d",
      ink: "#808080",
      gilt: "#828282",
      bloom: "#858585",
    };
    const v = derivePalette(awful);
    expect(
      contrastRatio(v["--color-text"] as string, v["--color-bg"] as string),
    ).toBeGreaterThanOrEqual(WCAG_TEXT_MIN);
    expect(
      contrastRatio(v["--color-text"] as string, v["--color-surface"] as string),
    ).toBeGreaterThanOrEqual(WCAG_TEXT_MIN);
  });

  test("a well-chosen seed is passed through untouched", () => {
    const v = derivePalette(PALETTE_PRESETS.evergreen);
    // Evergreen's gilt already clears 3:1 on its ground, so it must survive
    // derivation exactly — the enforcement only moves what needs moving.
    expect(v["--color-gold"]).toBe(
      formatOklch(parseColor(PALETTE_PRESETS.evergreen.gilt) as never),
    );
  });

  test("reports which seeds it had to move, and stays quiet when it moved none", () => {
    expect(paletteAdjustments(PALETTE_PRESETS.evergreen)).toEqual([]);
    const reports = paletteAdjustments({
      ground: "#ffffff",
      card: "#ffffff",
      ink: "#fafafa",
      gilt: "#fefefe",
      bloom: "#fdfdfd",
    });
    expect(reports.map((r) => r.token).toSorted()).toEqual(["bloom", "gilt", "ink"]);
  });
});

describe("surface ordering", () => {
  test("raised sits further from the page than card, in either direction", () => {
    const dark = derivePalette(PALETTE_PRESETS.evergreen);
    const light = derivePalette(PALETTE_PRESETS.fog);
    const l = (v: string) => (parseColor(v) as never as { l: number }).l;

    // Dark scheme: card is lighter than ground, raised lighter still.
    expect(l(dark["--color-surface"] as string)).toBeGreaterThan(l(dark["--color-bg"] as string));
    expect(l(dark["--color-surface-raised"] as string)).toBeGreaterThan(
      l(dark["--color-surface"] as string),
    );

    // Light scheme: the card is already near white, so there is no room to go
    // lighter — raised must go the OTHER way rather than clamp onto white and
    // stop being a third surface.
    expect(l(light["--color-surface-raised"] as string)).not.toBe(
      l(light["--color-surface"] as string),
    );
  });

  test("a raised surface is always visibly distinct from its card", () => {
    // The failure this guards: a near-white card on a pale page clipped at
    // white, so the "raised" tone rendered identically to "card" and the
    // section rhythm silently collapsed.
    const l = (v: string) => (parseColor(v) as never as { l: number }).l;
    for (const key of PALETTE_PRESET_KEYS) {
      const v = derivePalette(PALETTE_PRESETS[key]);
      const gap = Math.abs(
        l(v["--color-surface-raised"] as string) - l(v["--color-surface"] as string),
      );
      expect(gap, `${key} raised vs card`).toBeGreaterThan(0.02);
    }
    // …and at the extremes, where clipping is most likely.
    for (const card of ["#ffffff", "#000000", "#fefefe", "#010101"]) {
      const v = derivePalette({ ground: card, card, ink: "#808080", gilt: "#888", bloom: "#777" });
      const gap = Math.abs(
        l(v["--color-surface-raised"] as string) - l(v["--color-surface"] as string),
      );
      expect(gap, `card ${card}`).toBeGreaterThan(0.02);
    }
  });

  test("an inverted pick (dark card on a pale page) keeps the surfaces in order", () => {
    const v = derivePalette({
      ground: "#ffffff",
      card: "#e0e0e0",
      ink: "#111111",
      gilt: "#8a6d1f",
      bloom: "#7a3f5f",
    });
    const l = (s: string) => (parseColor(s) as never as { l: number }).l;
    expect(l(v["--color-surface"] as string)).toBeLessThan(l(v["--color-bg"] as string));
    expect(l(v["--color-surface-raised"] as string)).toBeLessThan(
      l(v["--color-surface"] as string),
    );
  });
});

describe("fonts", () => {
  test("every choice but `default` has a stack, and every stack is a choice", () => {
    // `FONT_CHOICES` is spelled out by hand so the literal union survives into
    // the API's Schema.Literal; this is the test that comment promises. A key in
    // one and not the other is either a 400 on a font the guest can render, or a
    // font choice that silently resolves to nothing.
    for (const choice of FONT_CHOICES) {
      expect(fontChoiceHasStack(choice), choice).toBe(true);
      if (choice !== "default") expect(fontStack(choice), choice).not.toBeNull();
    }
    expect(FONT_CHOICES.filter((c) => c !== "default").toSorted()).toEqual(
      Object.keys(FONT_STACKS).toSorted(),
    );
  });

  test("an unknown choice keeps the built-in token rather than injecting a value", () => {
    for (const bad of ["default", "unknown", "../../etc/passwd", ""]) {
      expect(fontStack(bad), bad).toBeNull();
    }
  });
});

describe("hero scrim", () => {
  test("scrims dark on a dark page and light on a light page", () => {
    // The failure this guards: a fixed dark scrim over a cream scheme turned
    // the whole hero muddy grey instead of cream.
    const l = (v: string) => (parseColor(v) as never as { l: number }).l;
    const dark = derivePalette(PALETTE_PRESETS.evergreen);
    const light = derivePalette(PALETTE_PRESETS.chapel);
    expect(l(dark["--invite-scrim-to"] as string)).toBeLessThan(0.2);
    expect(l(light["--invite-scrim-to"] as string)).toBeGreaterThan(0.8);
  });

  test("keeps the built-in scrim dark, so today's invite is unchanged", () => {
    const v = derivePalette(PALETTE_PRESETS.evergreen);
    expect(v["--invite-scrim-from"]).toContain("/ 0.3");
    expect(v["--invite-scrim-to"]).toContain("/ 0.55");
  });
});

describe("sectionToneVars", () => {
  test("maps each tone to its surface token", () => {
    expect(sectionToneVars("ground")).toEqual({ "--invite-section-bg": "var(--color-bg)" });
    expect(sectionToneVars("card")).toEqual({ "--invite-section-bg": "var(--color-surface)" });
    expect(sectionToneVars("raised")).toEqual({
      "--invite-section-bg": "var(--color-surface-raised)",
    });
  });

  test("an absent or unknown tone falls back to the page ground", () => {
    expect(sectionToneVars(null)).toEqual({ "--invite-section-bg": "var(--color-bg)" });
    expect(sectionToneVars("nonsense" as never)).toEqual({
      "--invite-section-bg": "var(--color-bg)",
    });
  });
});
