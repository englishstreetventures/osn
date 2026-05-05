import { describe, it, expect } from "vitest";
import { EVENT_DRESS_CODES } from "./dress-codes";

describe("EVENT_DRESS_CODES", () => {
  it("contains mehndi, sangeet, and wedding events", () => {
    expect(Object.keys(EVENT_DRESS_CODES)).toEqual(
      expect.arrayContaining(["mehndi", "sangeet", "wedding"]),
    );
  });

  it.each(Object.entries(EVENT_DRESS_CODES))(
    "%s has a description and non-empty palette",
    (_, info) => {
      expect(info.description).toBeTruthy();
      expect(info.palette.length).toBeGreaterThan(0);
    },
  );

  it.each(Object.entries(EVENT_DRESS_CODES))(
    "%s palette entries have name and oklch color",
    (_, info) => {
      for (const swatch of info.palette) {
        expect(swatch.name).toBeTruthy();
        expect(swatch.color).toMatch(/^oklch\(/);
      }
    },
  );
});
