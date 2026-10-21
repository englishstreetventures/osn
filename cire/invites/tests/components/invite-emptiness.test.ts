import { describe, it, expect } from "vitest";

import {
  faqState,
  footerState,
  hasDressCode,
  hasFooterMessage,
  hasGuestPolicy,
  hasPinterest,
  hasRunOfShow,
  hasText,
  hasVenue,
  heroState,
  isFaqEmpty,
  isFooterEmpty,
  isHeroEmpty,
  isStoryEmpty,
  storyState,
} from "../../src/components/invite-emptiness";

describe("hasText", () => {
  it("is false for null, undefined, empty, and whitespace-only", () => {
    expect(hasText(null)).toBe(false);
    expect(hasText(undefined)).toBe(false);
    expect(hasText("")).toBe(false);
    expect(hasText("   ")).toBe(false);
    expect(hasText("\t\n ")).toBe(false);
  });

  it("is true for any non-whitespace text", () => {
    expect(hasText("x")).toBe(true);
    expect(hasText("  padded  ")).toBe(true);
  });
});

describe("isHeroEmpty", () => {
  const empty = { imageUrl: null, title: null, subtitle: null };

  it("is empty only when image, title and subtitle are all absent", () => {
    expect(isHeroEmpty(empty)).toBe(true);
    expect(isHeroEmpty({ ...empty, title: "  " })).toBe(true); // whitespace-only ⇒ absent
  });

  it("is NOT empty with an image only", () => {
    expect(isHeroEmpty({ ...empty, imageUrl: "/img" })).toBe(false);
  });

  it("is NOT empty with a title only", () => {
    expect(isHeroEmpty({ ...empty, title: "A & B" })).toBe(false);
  });

  it("is NOT empty with a subtitle only", () => {
    expect(isHeroEmpty({ ...empty, subtitle: "Save the date" })).toBe(false);
  });
});

describe("isStoryEmpty", () => {
  const empty = { heading: null, body: null, imageUrl: null };

  it("is empty when heading, body and image are all absent", () => {
    expect(isStoryEmpty(empty)).toBe(true);
    expect(isStoryEmpty({ heading: " ", body: "", imageUrl: null })).toBe(true);
  });

  it("is NOT empty with any one of heading / body / image", () => {
    expect(isStoryEmpty({ ...empty, heading: "How It Began" })).toBe(false);
    expect(isStoryEmpty({ ...empty, body: "Once upon a time" })).toBe(false);
    expect(isStoryEmpty({ ...empty, imageUrl: "/img" })).toBe(false);
  });
});

describe("hasPinterest", () => {
  it("is false for absent / whitespace-only URLs", () => {
    expect(hasPinterest(null)).toBe(false);
    expect(hasPinterest("   ")).toBe(false);
  });

  it("is true for a real URL", () => {
    expect(hasPinterest("https://pinterest.com/x")).toBe(true);
  });

  it("is false for a link the moodboard would not show (F16)", () => {
    // `PinterestBoard` draws nothing for these, so a true here left an
    // "Inspiration" label over an empty space.
    expect(hasPinterest("https://instagram.com/couple")).toBe(false);
    expect(hasPinterest("http://pinterest.com/x/board")).toBe(false);
    expect(hasPinterest("not a url")).toBe(false);
  });
});

describe("hasVenue", () => {
  it("is false when nothing could open a map (F15)", () => {
    expect(hasVenue(null, null)).toBe(false);
    expect(hasVenue("   ", "  ")).toBe(false);
    // A mapsUrl that is not http(s) never reaches a link, so it is no venue.
    expect(hasVenue(null, "javascript:alert(1)")).toBe(false);
  });

  it("is true for an address, or for a usable maps link on its own (F15)", () => {
    expect(hasVenue("12 Banksia Lane", null)).toBe(true);
    expect(hasVenue("   ", "https://maps.app.goo.gl/x")).toBe(true);
  });

  // A sheet's Location with a blank Address leaves a name and nothing else,
  // and the row still names the venue and searches the map for it.
  it("is true for a venue name alone, and false for a blank one", () => {
    expect(hasVenue(null, null, "The Glasshouse")).toBe(true);
    expect(hasVenue(null, null, "   ")).toBe(false);
  });
});

describe("hasDressCode", () => {
  it("is false with no description and an empty / null palette", () => {
    expect(hasDressCode(null, null)).toBe(false);
    expect(hasDressCode("  ", [])).toBe(false);
  });

  it("is true with a description", () => {
    expect(hasDressCode("Black tie", null)).toBe(true);
  });

  it("is true with at least one palette swatch", () => {
    expect(hasDressCode(null, [{ name: "Gold", color: "#d4af37" }])).toBe(true);
  });
});

describe("hasFooterMessage", () => {
  it("is false for absent / whitespace-only notes (footer note not rendered)", () => {
    expect(hasFooterMessage(null)).toBe(false);
    expect(hasFooterMessage(undefined)).toBe(false);
    expect(hasFooterMessage("")).toBe(false);
    expect(hasFooterMessage("   ")).toBe(false);
  });

  it("is true once the couple has written something", () => {
    expect(hasFooterMessage("No boxed gifts please")).toBe(true);
  });
});

describe("isFooterEmpty", () => {
  const empty = { message: null, imageUrl: null };

  it("is empty with neither a note nor an image", () => {
    expect(isFooterEmpty(empty)).toBe(true);
    expect(isFooterEmpty({ message: "  ", imageUrl: "  " })).toBe(true);
    expect(isFooterEmpty({ message: undefined, imageUrl: undefined })).toBe(true);
  });

  // The two are independent — either alone keeps the sign-off block alive.
  it("is not empty with only a note, or only an image", () => {
    expect(isFooterEmpty({ ...empty, message: "No boxed gifts please" })).toBe(false);
    expect(isFooterEmpty({ ...empty, imageUrl: "/api/invite/x/image/footer?v=1" })).toBe(false);
  });
});

/**
 * The switch combined with the content check — what decides whether the hero,
 * Our Story and the closing section render. The organiser builder's badge reads
 * the same three functions in its mirror, so these cases are the ones both
 * sides must agree on: on with content, off with content, and on but empty.
 */
type StateFn = (visible: boolean | null | undefined, content: never) => string;

/** The four cases every switchable section's state function must satisfy. */
function stateContract<F extends StateFn>(
  state: F,
  filled: Parameters<F>[1],
  blank: Parameters<F>[1],
): void {
  it("is shown when switched on and it has content", () => {
    expect(state(true, filled as never)).toBe("shown");
  });

  it("is off when switched off, content or not", () => {
    expect(state(false, filled as never)).toBe("off");
    expect(state(false, blank as never)).toBe("off");
  });

  it("is empty when switched on with no content — it still renders nothing", () => {
    expect(state(true, blank as never)).toBe("empty");
  });

  it("reads a payload without the switch as on", () => {
    expect(state(undefined, filled as never)).toBe("shown");
    expect(state(null, blank as never)).toBe("empty");
  });
}

describe("section state (switch + content)", () => {
  describe("heroState", () => {
    stateContract(
      heroState,
      { imageUrl: null, title: "A & B", subtitle: null },
      { imageUrl: null, title: "  ", subtitle: null },
    );
  });

  describe("storyState", () => {
    stateContract(
      storyState,
      { heading: null, body: "Once upon a time", imageUrl: null },
      // The eyebrow is a label, so it is not part of the story's content.
      { heading: " ", body: null, imageUrl: null },
    );
  });

  describe("footerState", () => {
    stateContract(
      footerState,
      { message: null, imageUrl: "/api/invite/x/image/footer?v=1" },
      { message: "\n", imageUrl: null },
    );
  });

  describe("faqState", () => {
    stateContract(
      faqState,
      [{ question: "Parking?", answer: "Yes." }],
      // Half an entry is not content: it would paint an empty disclosure.
      [{ question: "Parking?", answer: " " }],
    );
  });
});

describe("isFaqEmpty", () => {
  it("is empty with no entries, or none with both a question and an answer", () => {
    expect(isFaqEmpty([])).toBe(true);
    expect(isFaqEmpty(null)).toBe(true);
    expect(isFaqEmpty(undefined)).toBe(true);
    for (const value of [null, undefined, "", "  ", "\n\t"]) {
      expect(isFaqEmpty([{ question: value, answer: "Yes." }])).toBe(true);
      expect(isFaqEmpty([{ question: "Parking?", answer: value }])).toBe(true);
    }
  });

  it("has content once any one entry has both", () => {
    expect(
      isFaqEmpty([
        { question: " ", answer: "Yes." },
        { question: "Parking?", answer: "Yes." },
      ]),
    ).toBe(false);
  });
});

// The organiser's events tab shows these blocks by twins of these two
// predicates (`cire/host/src/lib/invite-emptiness.ts`), held to the same cases.
describe("hasRunOfShow", () => {
  it("is empty with no items, or none with both a 24-hour time and a label", () => {
    expect(hasRunOfShow([])).toBe(false);
    expect(hasRunOfShow(null)).toBe(false);
    expect(hasRunOfShow(undefined)).toBe(false);
    for (const value of ["", "  ", "\n\t"]) {
      expect(hasRunOfShow([{ time: "16:00", label: value }])).toBe(false);
      expect(hasRunOfShow([{ time: value, label: "Tea" }])).toBe(false);
    }
    expect(hasRunOfShow([{ time: "4pm", label: "Tea" }])).toBe(false);
  });

  it("has content once any one item has both", () => {
    expect(
      hasRunOfShow([
        { time: "16:00", label: " " },
        { time: "17:15", label: "Speeches" },
      ]),
    ).toBe(true);
  });
});

describe("hasGuestPolicy", () => {
  it("is empty with no preset it knows and no note", () => {
    expect(hasGuestPolicy(null, null, null)).toBe(false);
    expect(hasGuestPolicy(undefined, undefined, undefined)).toBe(false);
    expect(hasGuestPolicy("kids_ok", "sometimes", null)).toBe(false);
    for (const value of ["", "  ", "\n\t"]) expect(hasGuestPolicy(null, null, value)).toBe(false);
  });

  it("has content with either preset or a note", () => {
    expect(hasGuestPolicy("adults_only", null, null)).toBe(true);
    expect(hasGuestPolicy("children_welcome", null, null)).toBe(true);
    expect(hasGuestPolicy(null, "by_invitation", null)).toBe(true);
    expect(hasGuestPolicy(null, "welcome", null)).toBe(true);
    expect(hasGuestPolicy(null, null, "Hats encouraged.")).toBe(true);
  });
});
