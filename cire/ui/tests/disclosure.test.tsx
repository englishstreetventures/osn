import "@testing-library/jest-dom/vitest";
// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cardBoxClass } from "../src/card";
import Disclosure, { type DisclosureTone } from "../src/disclosure";

/**
 * What a call site relies on: the summary opens and closes the body, the
 * marker turns with its own disclosure and no other, each tone draws its own
 * box, and the opening fade reaches nobody who asked for no motion.
 *
 * happy-dom computes no stylesheet, so where the guarantee is a style the test
 * reads the class that carries it, and the host's browser test
 * (`cire/host/tests/styles/disclosure.browser.test.tsx`) checks what Chromium
 * paints from it: the fade, the turn, the ink and the insets. The marker's
 * glyphs, its turn and its ink are the owner's choice on
 * englishstreetventures/osn#1834, so they are read by name.
 */

afterEach(cleanup);

const EVERY_TONE = Object.keys({
  card: true,
  rule: true,
} satisfies Record<DisclosureTone, true>) as DisclosureTone[];

const GLYPH = { card: "›", rule: "+" } satisfies Record<DisclosureTone, string>;

/** The pieces of a rendered disclosure, found the way the browser finds them. */
function parts(container: HTMLElement) {
  const details = container.querySelector("details");
  if (!details) throw new Error("no <details> rendered");
  const summary = details.querySelector<HTMLElement>(":scope > summary:first-child");
  if (!summary) throw new Error("no <summary> as the details' first child");
  const marker = [...summary.children].find(
    (el) => el.textContent === "›" || el.textContent === "+",
  );
  if (!marker) throw new Error("no marker in the summary");
  return { details, summary, marker };
}

function classes(el: Element): string[] {
  return [...el.classList];
}

/** Every class that sets a text colour; the size steps share the `text-` prefix. */
function inks(el: Element): string[] {
  return classes(el).filter(
    (c) => /(^|:)text-/.test(c) && !/(^|:)text-ui-(xs|sm|base|md|lg|xl|2xl)$/.test(c),
  );
}

describe("Disclosure — opening and closing", () => {
  it("opens and closes its body when the summary is clicked", () => {
    for (const tone of EVERY_TONE) {
      const { container, unmount } = render(() => (
        <Disclosure tone={tone} summary="Arrange tables">
          <p>Drag a table to move it.</p>
        </Disclosure>
      ));
      const { details, summary } = parts(container);
      expect(details.open).toBe(false);
      fireEvent.click(summary);
      expect(details.open).toBe(true);
      fireEvent.click(summary);
      expect(details.open).toBe(false);
      unmount();
    }
  });

  it("puts the summary first and the children in the body, never in the summary", () => {
    // The browser opens a details only from its first <summary> child.
    const { container } = render(() => (
      <Disclosure summary={<span data-testid="label">Change history</span>}>
        <p data-testid="row">Renamed the reception</p>
      </Disclosure>
    ));
    const { details, summary } = parts(container);
    expect(details.firstElementChild).toBe(summary);
    expect(summary.querySelector("[data-testid=label]")).not.toBeNull();
    const row = details.querySelector("[data-testid=row]");
    expect(row).not.toBeNull();
    expect(row?.closest("summary")).toBeNull();
  });

  it("starts open when told to, and closed otherwise", () => {
    const open = render(() => (
      <Disclosure open summary="How to structure your sheet">
        x
      </Disclosure>
    ));
    expect(parts(open.container).details).toHaveAttribute("open");
    open.unmount();

    const closed = render(() => <Disclosure summary="How to structure your sheet">x</Disclosure>);
    expect(parts(closed.container).details.open).toBe(false);
  });

  it("reports each new state, whoever changed it", () => {
    // The browser fires `toggle` for a script's change as well as a reader's,
    // which is why a "touched" count listens to `onSummaryClick` instead.
    const onToggle = vi.fn();
    const { container } = render(() => (
      <Disclosure summary="Change history" onToggle={onToggle}>
        x
      </Disclosure>
    ));
    const { details, summary } = parts(container);
    fireEvent.click(summary);
    fireEvent.click(summary);
    details.open = true;
    details.open = false;
    expect(onToggle.mock.calls).toEqual([[true], [false], [true], [false]]);
  });

  it("reports the summary's own click, and not a click in the body", () => {
    const onSummaryClick = vi.fn();
    const { container, getByText } = render(() => (
      <Disclosure summary="How to structure your sheet" onSummaryClick={onSummaryClick}>
        <button type="button">Download the template</button>
      </Disclosure>
    ));
    const { summary } = parts(container);
    fireEvent.click(summary);
    expect(onSummaryClick).toHaveBeenCalledTimes(1);
    fireEvent.click(getByText("Download the template"));
    expect(onSummaryClick).toHaveBeenCalledTimes(1);
  });

  it("works with no handlers at all", () => {
    const { container } = render(() => <Disclosure summary="Arrange tables">x</Disclosure>);
    const { details, summary } = parts(container);
    expect(() => fireEvent.click(summary)).not.toThrow();
    expect(details.open).toBe(true);
  });
});

describe("Disclosure — the marker", () => {
  it("is hidden from assistive technology", () => {
    // Read aloud, it would put "›" or "plus" before every question; the
    // details announces its own expanded state.
    for (const tone of EVERY_TONE) {
      const { container, unmount } = render(() => (
        <Disclosure tone={tone} summary="Is there parking?">
          x
        </Disclosure>
      ));
      expect(parts(container).marker).toHaveAttribute("aria-hidden", "true");
      unmount();
    }
  });

  it("leads a card's summary and ends a rule's, each with its own glyph", () => {
    for (const tone of EVERY_TONE) {
      const { container, unmount } = render(() => (
        <Disclosure tone={tone} summary="Is there parking?">
          x
        </Disclosure>
      ));
      const { summary, marker } = parts(container);
      expect(marker.textContent).toBe(GLYPH[tone]);
      expect(tone === "card" ? summary.firstElementChild : summary.lastElementChild).toBe(marker);
      unmount();
    }
  });

  it("turns with its own disclosure only, so a nested one keeps its own state", () => {
    // `details[open] > summary > marker`: a turn keyed to any open ancestor
    // would show a closed disclosure inside an open one as open.
    const TURN = {
      card: "base:[details[open]>summary>&]:rotate-90",
      rule: "base:[details[open]>summary>&]:rotate-45",
    } satisfies Record<DisclosureTone, string>;
    for (const tone of EVERY_TONE) {
      const { container, unmount } = render(() => (
        <Disclosure tone={tone} summary="Is there parking?">
          x
        </Disclosure>
      ));
      const { details, summary, marker } = parts(container);
      expect(classes(marker).filter((c) => c.includes(":rotate-"))).toEqual([TURN[tone]]);
      expect(marker.parentElement).toBe(summary);
      expect(summary.parentElement).toBe(details);
      expect(classes(marker).filter((c) => c.includes("group"))).toEqual([]);
      unmount();
    }
  });

  it("is painted in the readable gold", () => {
    // The owner's choice: `--ui-accent` is gold as metal, about 2.4:1 on the
    // light ground.
    for (const tone of EVERY_TONE) {
      const { container, unmount } = render(() => (
        <Disclosure tone={tone} summary="Is there parking?">
          x
        </Disclosure>
      ));
      expect(inks(parts(container).marker)).toEqual(["base:text-ui-accent-ink"]);
      unmount();
    }
  });

  it("hides the browser's own triangle", () => {
    for (const tone of EVERY_TONE) {
      const { container, unmount } = render(() => (
        <Disclosure tone={tone} summary="Is there parking?">
          x
        </Disclosure>
      ));
      const summary = classes(parts(container).summary);
      expect(summary).toContain("base:list-none");
      expect(summary).toContain("base:[&::-webkit-details-marker]:hidden");
      unmount();
    }
  });
});

describe("Disclosure — the box", () => {
  it("is a card when no tone is asked for", () => {
    const { container } = render(() => <Disclosure summary="Change history">x</Disclosure>);
    const { details, marker } = parts(container);
    expect(marker.textContent).toBe(GLYPH.card);
    expect(details.className).toContain(cardBoxClass({ fill: "well" }));
  });

  function detailsClasses(tone: DisclosureTone): string[] {
    const { container, unmount } = render(() => (
      <Disclosure tone={tone} summary="Is there parking?">
        x
      </Disclosure>
    ));
    const found = classes(parts(container).details);
    unmount();
    return found;
  }

  it("draws a card's box from Card, with the well fill", () => {
    const card = detailsClasses("card");
    expect(
      cardBoxClass({ fill: "well" })
        .split(" ")
        .filter((c) => !card.includes(c)),
    ).toEqual([]);
  });

  it("draws a rule as a hairline under the row, with no fill and no corner", () => {
    const rule = detailsClasses("rule");
    expect(rule).toContain("base:border-b");
    expect(rule).toContain("base:border-ui-hairline");
    expect(rule.filter((c) => c.includes("bg-") || c.includes("rounded-"))).toEqual([]);
  });

  it("keeps the caller's class after its own, and adds nothing without one", () => {
    // The import guide glows until it is touched.
    const plain = render(() => <Disclosure summary="How to structure your sheet">x</Disclosure>);
    const own = parts(plain.container).details.className;
    plain.unmount();
    expect(own).not.toContain("undefined");

    const glowing = render(() => (
      <Disclosure summary="How to structure your sheet" class="attention-glow">
        x
      </Disclosure>
    ));
    expect(parts(glowing.container).details.className).toBe(`${own} attention-glow`);
  });

  it("writes every class of its own at zero specificity, so a caller's utility wins", () => {
    for (const tone of EVERY_TONE) {
      const { container, unmount } = render(() => (
        <Disclosure tone={tone} summary="Is there parking?">
          <p>x</p>
        </Disclosure>
      ));
      const { details } = parts(container);
      const own = [details, ...details.querySelectorAll("*")]
        .filter((el) => el.tagName !== "P")
        .flatMap(classes);
      expect(own.filter((c) => !/^(motion-safe:)?base:/.test(c))).toEqual([]);
      unmount();
    }
  });
});

describe("Disclosure — the opening fade", () => {
  function fade(tone: DisclosureTone): string[] {
    const { container, unmount } = render(() => (
      <Disclosure tone={tone} summary="Is there parking?">
        x
      </Disclosure>
    ));
    const found = classes(parts(container).details).filter((c) => c.includes("details-content"));
    unmount();
    return found;
  }

  it("fades the body in, for readers who did not ask for less motion", () => {
    // The apps' reduced-motion rule selects `*`, which no pseudo-element
    // matches, so the fade carries its own gate.
    for (const tone of EVERY_TONE) {
      const found = fade(tone);
      expect(found).toContain("motion-safe:base:details-content:opacity-0");
      expect(found).toContain("motion-safe:base:open:details-content:opacity-100");
      expect(found.filter((c) => !c.startsWith("motion-safe:"))).toEqual([]);
    }
  });

  it("closes at once: the transition exists only while open", () => {
    // A fading body would leave its controls focusable in a box that is
    // going away.
    for (const tone of EVERY_TONE) {
      const timed = fade(tone).filter((c) => /transition|duration-|ease-/.test(c));
      expect(timed.length).toBeGreaterThan(0);
      expect(timed.filter((c) => !c.includes(":open:"))).toEqual([]);
    }
  });
});
