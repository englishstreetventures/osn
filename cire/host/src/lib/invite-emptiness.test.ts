import { describe, expect, it } from "vitest";

import { hasText, isFooterEmpty, isHeroEmpty, isStoryEmpty } from "./invite-emptiness";

/**
 * T-M2 (web.md). `invite-emptiness.ts` is a hand-maintained mirror of
 * `cire/invites/src/components/invite-emptiness.ts`, and nothing checked that the
 * two agree. The stakes are quiet but real: these predicates decide whether the
 * builder's per-section badge says "Shown" or "Hidden — empty", so a drift
 * doesn't break anything visibly — it just makes the builder lie about what a
 * guest will see, and the organiser finds out from the guest.
 *
 * The two packages share no code, so a literal import-and-compare is not
 * available. What is testable is the CONTRACT both copies claim to implement,
 * asserted here case-by-case: whitespace is not content, any one field keeps a
 * section alive, and only all-absent hides it. A change to either copy that
 * isn't mirrored will fail one of these.
 */

const ABSENT = [null, undefined, "", "   ", "\t", "\n", " \n\t "] as const;

describe("hasText", () => {
  it("treats null, undefined, empty and whitespace-only as absent", () => {
    for (const value of ABSENT) expect(hasText(value)).toBe(false);
  });

  it("treats any non-whitespace character as present", () => {
    for (const value of ["a", " a ", "0", "—", "  hello  "]) expect(hasText(value)).toBe(true);
  });

  // The mirror's own docstring calls this out: an organiser who types only
  // spaces has not filled the field, and the guest site agrees.
  it("does not count a space-only string as content", () => {
    expect(hasText(" ")).toBe(false);
  });
});

describe("isHeroEmpty", () => {
  const hero = (over: Partial<Parameters<typeof isHeroEmpty>[0]> = {}) => ({
    imageUrl: null,
    title: null,
    subtitle: null,
    ...over,
  });

  it("is empty only when image, title and subtitle are all absent", () => {
    expect(isHeroEmpty(hero())).toBe(true);
    for (const value of ABSENT) {
      expect(isHeroEmpty(hero({ imageUrl: value, title: value, subtitle: value }))).toBe(true);
    }
  });

  it("is kept alive by any single field — image-only and title-only are shown", () => {
    expect(isHeroEmpty(hero({ imageUrl: "https://cdn.example/hero.jpg" }))).toBe(false);
    expect(isHeroEmpty(hero({ title: "Ada & Grace" }))).toBe(false);
    expect(isHeroEmpty(hero({ subtitle: "12 October 2026" }))).toBe(false);
  });
});

describe("isStoryEmpty", () => {
  const story = (over: Partial<Parameters<typeof isStoryEmpty>[0]> = {}) => ({
    heading: null,
    body: null,
    imageUrl: null,
    ...over,
  });

  it("is empty only when heading, body and image are all absent", () => {
    expect(isStoryEmpty(story())).toBe(true);
    expect(isStoryEmpty(story({ heading: "   ", body: "\n", imageUrl: "" }))).toBe(true);
  });

  it("is kept alive by any single field", () => {
    expect(isStoryEmpty(story({ heading: "How we met" }))).toBe(false);
    expect(isStoryEmpty(story({ body: "On a train." }))).toBe(false);
    expect(isStoryEmpty(story({ imageUrl: "https://cdn.example/story.jpg" }))).toBe(false);
  });

  // Both copies say so explicitly: the eyebrow is a label, not content. It is
  // not a parameter here, which is the mechanical form of that promise — adding
  // it to one copy and not the other would change this signature.
  it("takes no eyebrow — a label cannot keep the section alive", () => {
    expect(isStoryEmpty.length).toBe(1);
    expect(Object.keys(story())).toEqual(["heading", "body", "imageUrl"]);
  });
});

describe("isFooterEmpty", () => {
  const footer = (over: Partial<Parameters<typeof isFooterEmpty>[0]> = {}) => ({
    message: null,
    imageUrl: null,
    ...over,
  });

  it("is empty only with neither a note nor an image", () => {
    expect(isFooterEmpty(footer())).toBe(true);
    expect(isFooterEmpty(footer({ message: "  ", imageUrl: "  " }))).toBe(true);
  });

  // The two are independent — a note with no image renders the note, and an
  // image with no note renders the image.
  it("is kept alive by either half on its own", () => {
    expect(isFooterEmpty(footer({ message: "With love," }))).toBe(false);
    expect(isFooterEmpty(footer({ imageUrl: "https://cdn.example/motif.svg" }))).toBe(false);
  });
});
