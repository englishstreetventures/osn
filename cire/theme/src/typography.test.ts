import { describe, expect, test } from "bun:test";

import {
  FONT_STYLE_CHOICES,
  FONT_WEIGHT_CHOICES,
  fontStyleValue,
  fontWeightValue,
  HEADING_SIZE_CHOICES,
  headingScale,
  TYPOGRAPHY_VAR_KEYS,
  typographyVars,
} from "./index";

describe("typography choices", () => {
  test("every non-default choice resolves to a concrete CSS value", () => {
    for (const choice of HEADING_SIZE_CHOICES) {
      expect(headingScale(choice) === null).toBe(choice === "default");
    }
    for (const choice of FONT_WEIGHT_CHOICES) {
      expect(fontWeightValue(choice) === null).toBe(choice === "default");
    }
    for (const choice of FONT_STYLE_CHOICES) {
      expect(fontStyleValue(choice) === null).toBe(choice === "default");
    }
  });

  test("unknown / absent keys resolve to null (keep the pack default)", () => {
    for (const resolve of [headingScale, fontWeightValue, fontStyleValue]) {
      expect(resolve(null)).toBeNull();
      expect(resolve(undefined)).toBeNull();
      expect(resolve("")).toBeNull();
      expect(resolve("comic-sans")).toBeNull();
      // A value, not a key — the maps must never pass raw input through.
      expect(resolve("italic; background: url(x)")).toBeNull();
    }
  });

  test("weights are numeric and styles are the two CSS keywords", () => {
    expect(fontWeightValue("light")).toBe("300");
    expect(fontWeightValue("regular")).toBe("400");
    expect(fontWeightValue("bold")).toBe("700");
    expect(fontStyleValue("normal")).toBe("normal");
    expect(fontStyleValue("italic")).toBe("italic");
  });
});

describe("typographyVars", () => {
  test("emits nothing for an absent / all-default / unknown settings object", () => {
    expect(typographyVars(null)).toEqual({});
    expect(typographyVars(undefined)).toEqual({});
    expect(typographyVars({})).toEqual({});
    expect(
      typographyVars({
        headingSize: "default",
        headingWeight: null,
        headingStyle: "default",
        bodyWeight: null,
        bodyStyle: "default",
      }),
    ).toEqual({});
    expect(typographyVars({ headingSize: "huge", bodyStyle: "wavy" })).toEqual({});
  });

  test("emits one variable per set field, all from the declared key set", () => {
    const vars = typographyVars({
      headingSize: "large",
      headingWeight: "bold",
      headingStyle: "italic",
      bodyWeight: "light",
      bodyStyle: "italic",
    });
    expect(vars).toEqual({
      "--invite-heading-scale": "1.15",
      "--invite-heading-weight": "700",
      "--invite-heading-style": "italic",
      "--invite-body-weight": "300",
      "--invite-body-style": "italic",
    });
    for (const key of Object.keys(vars)) {
      expect(TYPOGRAPHY_VAR_KEYS).toContain(key);
    }
  });

  test("a partial pick emits only its own variable", () => {
    expect(typographyVars({ headingStyle: "italic" })).toEqual({
      "--invite-heading-style": "italic",
    });
  });
});
