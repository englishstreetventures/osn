// @vitest-environment happy-dom
import { headingSizeCss, typographyVar } from "@cire/theme";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { captureDeclaredStyles } from "../../test-support/declared-style";
import { HeroSample, SectionSample } from "./previews";

/**
 * The two shared preview samples. Every preview layer in the builder is built
 * from them — the inline per-section cards, and the composed `PreviewPane` at
 * the wide breakpoint — so what they declare IS what an organiser sees while
 * editing, in all three layers at once.
 *
 * What is pinned here is the TYPOGRAPHY CONTRACT: every sample follows the
 * `--invite-*` variables with the guest packs' literals as fallbacks, and none
 * hardcodes a look. A sample that pins its own weight or italics renders the
 * same whatever the organiser picks, and so contradicts an explicit pick rather
 * than merely failing to follow it — the bug this file exists to prevent
 * recurring.
 *
 * Where a declaration lands matters as much as that it exists: heading samples
 * pin their own weight/style (so an italic BODY never drags the headings
 * along), while the body pair sits on the section WRAPPER and cascades to the
 * eyebrow and mini event card, mirroring how `global.css` applies it to the
 * guest invite's `<body>`.
 */

vi.mock("../../lib/api", () => ({ apiUrl: (path: string) => `https://api.test${path}` }));

describe("SectionSample", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const props = {
    surface: "var(--color-bg)",
    eyebrow: "Celebrate With Us",
    heading: "Your Events",
    body: "Your events, from the spreadsheet import.",
    card: { name: "Ceremony", meta: "Saturday, 4pm" },
  };

  it("carries the body weight + style on the wrapper, so they cascade", () => {
    const { container } = render(() => <SectionSample {...props} />);
    const wrapper = container.firstElementChild as HTMLElement;

    // Arbitrary properties, not inline style: the wrapper's style object also
    // carries the dynamic tone surface, and Solid applies that one through
    // `setProperty` — where happy-dom discards a `var()` value, making the
    // contract untestable. The guest packs use the same class idiom.
    expect(wrapper.className).toContain("[font-weight:var(--invite-body-weight,400)]");
    expect(wrapper.className).toContain("[font-style:var(--invite-body-style,normal)]");
    // The body FACE still rides the style object beside the surface.
    expect(wrapper.getAttribute("style")).toContain("font-family: var(--font-body)");
  });

  it("leaves the body line to inherit, rather than pinning the pair on it", () => {
    render(() => <SectionSample {...props} />);
    const body = screen.getByText(props.body);

    // Positive assertion first, so a selector that stopped matching cannot make
    // the negatives below pass vacuously.
    expect(body.getAttribute("style")).toContain("color:var(--color-text-muted)");
    // Declaring the pair HERE is the regression: it moves this one line and
    // leaves the eyebrow and the event card on the pack default — exactly the
    // reported "Body weight: Bold only changed one thing" symptom.
    expect(body.getAttribute("style")).not.toContain("font-weight");
    expect(body.getAttribute("style")).not.toContain("font-style");
    expect(body.className).not.toContain("invite-body-weight");
  });

  it("follows the heading variables, with the packs' base look as fallbacks", () => {
    const styles = captureDeclaredStyles();
    render(() => <SectionSample {...props} />);
    const heading = styles.of(screen.getByText(props.heading));

    // Compared against `@cire/theme`, not against a literal retyped here: if
    // the canonical fallback ever moves, this asserts the sample moved with it
    // rather than pinning today's value in a second place (T-S3).
    expect(heading["font-size"]).toBe(headingSizeCss("1.5rem"));
    expect(heading["font-weight"]).toBe(typographyVar("headingWeight"));
    expect(heading["font-style"]).toBe(typographyVar("headingStyle"));
  });

  it("keeps the heading free of a hardcoded weight or slant", () => {
    render(() => <SectionSample {...props} />);
    const heading = screen.getByText(props.heading);

    // A Tailwind `font-light italic` would win over the variables above — the
    // heading would then render identically for every pick.
    expect(heading.className).not.toContain("italic");
    expect(heading.className).not.toContain("font-light");
  });
});

describe("HeroSample", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("follows the heading variables on the title, fallbacks intact", () => {
    const styles = captureDeclaredStyles();
    const { container } = render(() => (
      <HeroSample
        imageUrl={null}
        title="Anita & Ben"
        heroBlur={28}
        backdropOpacity={0}
        backdropBlur={0}
        surface="var(--color-bg)"
      />
    ));
    const title = screen.getByText("Anita & Ben");
    const style = styles.of(title);

    // The hero keeps its own responsive curve; only the scale is shared. `cqi`,
    // not `vw` — the title scales off the preview frame's own width, not the
    // real browser viewport (WT-P… mobile-preview proportions).
    expect(style["font-size"]).toBe(headingSizeCss("clamp(1.25rem,9cqi,2rem)"));
    expect(style["font-weight"]).toBe(typographyVar("headingWeight"));
    expect(style["font-style"]).toBe(typographyVar("headingStyle"));
    expect(title.className).not.toContain("italic");
    // `cqi` only resolves against a query container — a class-string match on
    // the font-size alone can't catch this container being dropped (happy-dom
    // computes no layout, so the string would still "look" right).
    expect(container.firstElementChild?.className).toContain("@container");
    expect(title.className).not.toContain("font-light");
  });
});
