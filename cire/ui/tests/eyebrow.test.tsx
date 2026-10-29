import "@testing-library/jest-dom/vitest";
// @vitest-environment happy-dom
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import Eyebrow, { type EyebrowElement, type EyebrowTone, eyebrowClass } from "../src/eyebrow";

/**
 * The eyebrow is one label at one letter-spacing in two inks, and those three
 * classes are the owner's choice (englishstreetventures/osn#1833): the widest
 * tracking step, readable gold for `accent` and the neutral secondary ink for
 * `muted`. So, unlike the rest of `@cire/ui`'s tests, these read the tracking
 * and the colour by name — a different value is a different design, not a
 * refactor.
 */

afterEach(cleanup);

const EVERY_TONE = Object.keys({
  accent: true,
  muted: true,
} satisfies Record<EyebrowTone, true>) as EyebrowTone[];

const EVERY_ELEMENT = Object.keys({
  p: true,
  span: true,
  h2: true,
  h3: true,
  legend: true,
  dt: true,
} satisfies Record<EyebrowElement, true>) as EyebrowElement[];

/** The size steps, which share the `text-` prefix with the colours. */
const SIZE = /(^|:)text-ui-(xs|sm|base|md|lg|xl|2xl)$/;

/** Every class that sets a text colour, prefixed or not: a plain one would win over the part's own. */
function inks(cls: string): string[] {
  return cls.split(/\s+/).filter((c) => /(^|:)text-/.test(c) && !SIZE.test(c));
}

function trackings(cls: string): string[] {
  return cls.split(/\s+/).filter((c) => c.includes("tracking-"));
}

describe("eyebrowClass", () => {
  it("gives each tone its own look, and accent when none is asked for", () => {
    expect(eyebrowClass({ tone: "accent" })).not.toBe(eyebrowClass({ tone: "muted" }));
    expect(eyebrowClass()).toBe(eyebrowClass({ tone: "accent" }));
  });

  it("paints accent in the readable gold, never the metal one", () => {
    // `--ui-accent` is gold as metal: about 2.4:1 on cire's light ground, and
    // the host's design system bars it from carrying text.
    expect(EVERY_TONE.map((tone) => inks(eyebrowClass({ tone })))).toEqual([
      ["base:text-ui-accent-ink"],
      ["base:text-ui-ink-secondary"],
    ]);
  });

  it("sets every eyebrow at the one letter-spacing", () => {
    for (const tone of EVERY_TONE) {
      expect(trackings(eyebrowClass({ tone }))).toEqual(["base:tracking-ui-widest"]);
    }
  });

  it("leaves the weight to the page", () => {
    // On a guest's invite the couple picks the body weight, and an eyebrow
    // follows it like the rest of the text.
    for (const tone of EVERY_TONE) {
      expect(
        eyebrowClass({ tone })
          .split(/\s+/)
          .filter((c) => c.includes("font-") && !c.includes("font-ui-body")),
      ).toEqual([]);
    }
  });
});

describe("Eyebrow", () => {
  it("renders the element it is asked for, and a paragraph by default", () => {
    const wrong = EVERY_ELEMENT.filter((as) => {
      const { container, unmount } = render(() => <Eyebrow as={as}>Next step</Eyebrow>);
      const tag = (container.firstElementChild as HTMLElement).tagName.toLowerCase();
      unmount();
      return tag !== as;
    });
    expect(wrong).toEqual([]);
    const { container } = render(() => <Eyebrow>Next step</Eyebrow>);
    expect((container.firstElementChild as HTMLElement).tagName).toBe("P");
  });

  it("renders a paragraph for any element it does not offer, however it was typed", () => {
    // A tag name read from stored data and cast to the type must not become a
    // `<script>` or an `<img onerror>` on a guest's page.
    for (const tag of ["script", "img", "iframe", "p onclick=x"]) {
      const { container, unmount } = render(() => (
        <Eyebrow as={tag as EyebrowElement}>Next step</Eyebrow>
      ));
      expect((container.firstElementChild as HTMLElement).tagName).toBe("P");
      unmount();
    }
  });

  it("draws the same label `eyebrowClass` does, for each tone", () => {
    const wrong = EVERY_TONE.filter((tone) => {
      const { container, unmount } = render(() => <Eyebrow tone={tone}>Next step</Eyebrow>);
      const cls = (container.firstElementChild as HTMLElement).className;
      unmount();
      return cls !== eyebrowClass({ tone });
    });
    expect(wrong).toEqual([]);
  });

  it("keeps the caller's own classes after its own", () => {
    const { container } = render(() => (
      <Eyebrow tone="muted" class="mb-1">
        Spent so far
      </Eyebrow>
    ));
    expect((container.firstElementChild as HTMLElement).className).toBe(
      `${eyebrowClass({ tone: "muted" })} mb-1`,
    );
  });

  it("carries an id, so a section can be named by its eyebrow", () => {
    const { getByRole } = render(() => (
      <section aria-labelledby="budget-eyebrow">
        <Eyebrow as="h2" id="budget-eyebrow">
          Budget
        </Eyebrow>
      </section>
    ));
    expect(getByRole("region")).toHaveAccessibleName("Budget");
  });
});
