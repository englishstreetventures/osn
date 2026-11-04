import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { faqEntries } from "../../src/components/faq-entries";
import { FaqList } from "../../src/components/InviteFaq";

afterEach(() => {
  cleanup();
});

describe("faqEntries", () => {
  it("keeps well-formed entries, in order, field by field", () => {
    expect(
      faqEntries([
        { id: "a", question: "Parking?", answer: "Yes.", sortOrder: 0, extra: "<b>" },
        { question: "Children?", answer: "Ceremony." },
      ]),
    ).toEqual([
      { question: "Parking?", answer: "Yes." },
      { question: "Children?", answer: "Ceremony." },
    ]);
  });

  it("drops an entry missing a field, with a non-string field, or with blank text", () => {
    expect(
      faqEntries([
        null,
        "entry",
        { question: "No answer?" },
        { question: 5, answer: "Yes." },
        { question: "Answer a number?", answer: 7 },
        { question: "Blank answer?", answer: " \n" },
        { question: "   ", answer: "Blank question." },
        { question: "Parking?", answer: "Yes." },
      ]),
    ).toEqual([{ question: "Parking?", answer: "Yes." }]);
  });

  it("reads anything that is not an array as no entries", () => {
    for (const value of [undefined, null, {}, "entries", 3]) expect(faqEntries(value)).toEqual([]);
  });
});

describe("FaqList", () => {
  const entries = [
    { question: "Is there parking?", answer: "Yes." },
    { question: "Are children invited?", answer: "To the ceremony." },
  ];

  it("renders each entry as a closed native disclosure", () => {
    const { container } = render(() => <FaqList entries={entries} />);
    const items = [...container.querySelectorAll("details")];
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.open).toBe(false);
      // The summary is the question; the marker glyph is hidden from AT.
      const summary = item.querySelector("summary")!;
      expect(summary.querySelector("[aria-hidden='true']")?.textContent).toBe("+");
    }
    expect(items[0]!.querySelector("summary")!.textContent).toContain("Is there parking?");
    expect(items[1]!.querySelector("p")!.textContent).toBe("To the ceremony.");
  });

  it("draws organiser-written markup in a question or an answer as text", () => {
    // Couples and co-hosts write these, and every guest who has claimed reads
    // them; the shared Disclosure must insert them as text, never parse them.
    const markup = '<img src="x" onerror="window.__faqScript = 1">';
    const { container } = render(() => (
      <FaqList entries={[{ question: markup, answer: markup }]} />
    ));
    expect(container.querySelector("img")).toBeNull();
    const item = container.querySelector("details")!;
    expect(item.querySelector("summary")!.textContent).toContain(markup);
    expect(item.querySelector("p")!.textContent).toBe(markup);
  });

  it("puts no heading inside a summary", () => {
    const { container } = render(() => <FaqList entries={entries} />);
    expect(container.querySelector("summary h1, summary h2, summary h3, summary h4")).toBeNull();
  });
});
