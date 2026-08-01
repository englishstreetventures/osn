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
  paletteContrastWarnings,
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

/**
 * Enforcement runs each token against ONE backdrop, and the surface it never
 * walks is `raised` — the one every `EventCard` sits on, carrying the card
 * title, the venue and description, and the date. Together with muted text on
 * `ground`, that is where a finished palette can still be illegible, so those
 * pairs are warned about instead.
 *
 * The pair of mechanisms only works if the warning is quiet for every scheme an
 * organiser is likely to have and loud for the ones that genuinely fail — hence
 * the preset sweep below, and the directional test pinning each pair to the
 * surface its message names (the first cut had `card` and `raised` crossed).
 */
describe("residual contrast warnings", () => {
  test("every curated preset is clean", () => {
    for (const key of PALETTE_PRESET_KEYS) {
      expect({
        key,
        warnings: paletteContrastWarnings(derivePalette(PALETTE_PRESETS[key])),
      }).toEqual({ key, warnings: [] });
    }
  });

  test("the two notices describe different things, neither derivable from the other", () => {
    // Near-identical mid-greys. `paletteAdjustments` names the seeds it MOVED
    // (ink, gilt, bloom); `paletteContrastWarnings` names what survived the
    // move (muted, on both surfaces it lands on). The two lists are disjoint
    // here, which is the point: a caller cannot infer either from the other, so
    // the builder has to show both.
    const seeds = { ground: "#999999", card: "#999999", ink: "#888888" };
    const moved = paletteAdjustments(seeds).map((a) => a.token);
    const survived = paletteContrastWarnings(derivePalette(seeds)).map((w) => w.id);
    expect(moved).toContain("ink");
    expect(survived).toEqual(["muted-on-raised", "muted-on-ground"]);
    // Nothing in the warning list is merely a restatement of an adjustment.
    for (const token of moved) expect(survived.some((id) => id.startsWith(token))).toBe(false);
  });

  test("a rescue that leaves a residual is still warned about", () => {
    // White page, white card: `ink` is darkened until it clears 4.5:1 on white,
    // which lands it just under that bar against `raised` — the surface a step
    // beyond the card, and the one every event card sits on. The rescue
    // happened AND real problems survived it, so both notices are true at once.
    const warnings = paletteContrastWarnings(
      derivePalette({
        ground: "#ffffff",
        card: "#ffffff",
        ink: "#fafafa",
        gilt: "#fefefe",
        bloom: "#fdfdfd",
      }),
    );
    expect(warnings.map((w) => w.id)).toEqual([
      "text-on-raised",
      "muted-on-raised",
      "muted-on-ground",
      "gilt-on-raised",
    ]);
    for (const warning of warnings) expect(warning.ratio).toBeLessThan(warning.required);
    expect(warnings.find((w) => w.id === "text-on-raised")!.ratio).toBeLessThan(WCAG_TEXT_MIN);
  });

  test("holds secondary text to the TEXT minimum, not the UI floor", () => {
    // Every `--color-text-muted` site on the guest invite is small text (0.74 –
    // 0.92rem), so WCAG AA asks 4.5:1 — but `derivePalette` only holds muted to
    // the 3:1 UI floor against `card`. That gap is precisely what this warning
    // exists to surface, and printing "needs 3:1" beside a text pair would
    // state the wrong requirement to the organiser as fact (C-L2).
    for (const id of ["muted-on-raised", "muted-on-ground"]) {
      const pair = paletteContrastWarnings(
        derivePalette({ ground: "#999999", card: "#999999", ink: "#888888" }),
      ).find((w) => w.id === id)!;
      expect(pair.required).toBe(WCAG_TEXT_MIN);
    }
  });

  test("names the pairs a near-white card on a black page breaks", () => {
    // The canonical failure: `gilt` clears the near-black page it was enforced
    // against and then sits on a near-white card at under 2:1, which is the
    // colour of the date on every event card.
    const warnings = paletteContrastWarnings(
      derivePalette({
        ground: "#101010",
        card: "#f2f2f2",
        ink: "#eeeeee",
        gilt: "#d4af37",
        bloom: "#c0392b",
      }),
    );
    expect(warnings.map((w) => w.id).toSorted()).toEqual([
      "gilt-on-raised",
      "muted-on-ground",
      "text-on-raised",
    ]);
    // Each carries the measured ratio and the bar it missed, so the notice can
    // show the organiser the numbers rather than a bare "this is bad".
    for (const warning of warnings) {
      expect(warning.ratio).toBeLessThan(warning.required);
      expect(warning.message.length).toBeGreaterThan(0);
    }
    const gilt = warnings.find((w) => w.id === "gilt-on-raised")!;
    expect(gilt.required).toBe(WCAG_UI_MIN);
    expect(warnings.find((w) => w.id === "text-on-raised")!.required).toBe(WCAG_TEXT_MIN);
  });

  test("measures each pair against the surface its message names", () => {
    // The first cut of this table had the two surfaces crossed — it measured
    // `--color-surface` while its copy said "event cards", and `raised` while
    // saying "pop-ups". It is the other way round on the guest site
    // (`EventCard` is `bg-surface-raised`, `AnimatedModal` is `bg-surface`), so
    // the warning could sit silent on the card copy a guest actually reads.
    // Pin the direction: a palette broken ONLY on `raised` must still warn.
    const raisedOnly = derivePalette({
      ground: "#101010",
      card: "#f2f2f2",
      ink: "#eeeeee",
      gilt: "#d4af37",
      bloom: "#c0392b",
    });
    const ids = paletteContrastWarnings(raisedOnly).map((w) => w.id);
    expect(ids).toContain("gilt-on-raised");
    // Gold on the MODAL surface is a different, better ratio here — proof the
    // reported failure is the raised one and not `--color-surface` mislabelled.
    const onCard = contrastRatio(raisedOnly["--color-gold"]!, raisedOnly["--color-surface"]!)!;
    const onRaised = contrastRatio(
      raisedOnly["--color-gold"]!,
      raisedOnly["--color-surface-raised"]!,
    )!;
    expect(onCard).not.toBeCloseTo(onRaised, 2);
    const reported = paletteContrastWarnings(raisedOnly).find((w) => w.id === "gilt-on-raised")!;
    expect(reported.ratio).toBeCloseTo(onRaised, 1);
  });

  test("says nothing about bloom, which the guest site paints nowhere", () => {
    // `--color-bloom` is a defined token with no render site in `cire/web`, so
    // a warning about it would be about a colour no guest can see. Deliberate
    // omission, not an oversight — this fails if a bloom pair is added without
    // the guest site gaining one.
    const invisibleBloom = derivePalette({
      ground: "#101010",
      card: "#101010",
      ink: "#eeeeee",
      gilt: "#d4af37",
      // Near-identical to the page: any bloom pair would fire on this.
      bloom: "#141414",
    });
    expect(paletteContrastWarnings(invisibleBloom).every((w) => !w.id.includes("bloom"))).toBe(
      true,
    );
  });

  test("an unparseable or missing token is skipped, not reported as a failure", () => {
    // The map is always machine-built, but a warning invented from a token that
    // isn't there would be worse than a missing one.
    expect(paletteContrastWarnings({})).toEqual([]);
    expect(paletteContrastWarnings({ "--color-text": "not-a-colour" })).toEqual([]);
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
