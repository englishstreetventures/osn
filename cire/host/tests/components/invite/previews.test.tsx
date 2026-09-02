// @vitest-environment happy-dom
import { headingSizeCss, typographyVar } from "@cire/theme";
import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  HeroPreview,
  HeroSample,
  LEGACY_CROP_ASPECT,
  SectionPreview,
  SectionSample,
} from "../../../src/components/invite/previews";
import { CROP_ASPECT } from "../../../src/lib/image-crop";
import { captureDeclaredStyles } from "../../test-support/declared-style";

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

vi.mock("../../../src/lib/api", () => ({ apiUrl: (path: string) => `https://api.test${path}` }));

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

  it("renders the closing image edge to edge, as the guest band does", () => {
    const { container } = render(() => (
      <SectionSample {...props} imageUrl="/api/invite/anita-ben/image/footer?v=7" />
    ));
    const img = container.querySelector("img") as HTMLImageElement;

    expect(img.getAttribute("src")).toBe(
      "https://api.test/api/invite/anita-ben/image/footer?v=7&variant=card",
    );
    // Full width, cover-fitted — the miniature of the guest's full-bleed band.
    // It must sit OUTSIDE the padded content block, or the preview would show a
    // framed thumbnail for an image that publishes edge to edge.
    expect(img.className).toContain("w-full");
    expect(img.className).toContain("object-cover");
    expect(img.className).not.toContain("w-10");
    // The frame-scaled twin of the guest cap: without it a tall closing image
    // swallows the whole preview card and pushes the note out of view.
    expect(img.className).toContain("max-h-24");
    expect(img.className).toContain("shrink-0");
    expect((img.parentElement as HTMLElement).className).not.toContain("p-4");
  });

  it("previews the CROP the organiser saved, at the shape it will publish", () => {
    const { container } = render(() => (
      <SectionSample
        {...props}
        imageUrl="/api/invite/anita-ben/image/footer?v=7"
        // 2:1 pixel aspect — (0.5·1000) / (0.5·500) = 2.
        imageCrop={{ x: 0.1, y: 0.1, w: 0.5, h: 0.5, natW: 1000, natH: 500 }}
      />
    ));
    const band = container.querySelector("[role='img']") as HTMLElement;

    // The crop replaces the plain <img>, exactly as it does on the guest page.
    expect(container.querySelector("img")).toBeNull();
    expect(band.style.getPropertyValue("background-image")).toContain(
      "https://api.test/api/invite/anita-ben/image/footer?v=7&variant=card",
    );
    // The same exact-region render and the same crop-driven shape the invite
    // uses — this sample is the organiser's answer to "what will my closing
    // image look like", so a focal-point approximation here would mislead.
    // happy-dom keeps the fixed-point form the helper emits (100/0.5).
    expect(band.style.getPropertyValue("background-size")).toBe("200.0000%");
    expect(band.style.getPropertyValue("aspect-ratio")).toBe("2 / 1");
    expect(band.className).toContain("w-full");
    expect((band.parentElement as HTMLElement).className).not.toContain("p-4");
  });

  it("bounds a tall preview crop by width, so the framing is never clipped", () => {
    const { container } = render(() => (
      <SectionSample
        {...props}
        imageUrl="/api/invite/anita-ben/image/footer?v=7"
        // 0.8 — portrait, the case the bound exists for. This frame is short, so
        // the cap fires far more often here than on the guest page.
        imageCrop={{ x: 0, y: 0, w: 0.4, h: 0.5, natW: 1000, natH: 1000 }}
      />
    ));
    const band = container.querySelector("[role='img']") as HTMLElement;

    // `width: 100%` + `max-width: cap × aspect` is the guest band's rule. A
    // `max-height` clip would trim the organiser's framing in the one surface
    // whose entire job is showing them that framing.
    expect(band.className).toContain("w-full");
    expect(band.style.getPropertyValue("max-width")).toMatch(/^calc\(.*rem.*\)$/);
    expect(band.style.getPropertyValue("max-height")).toBe("");
  });

  it("previews a legacy dims-less crop at the same shape the invite falls back to", () => {
    const { container } = render(() => (
      <SectionSample
        {...props}
        imageUrl="/api/invite/anita-ben/image/footer?v=7"
        imageCrop={{ x: 0, y: 0, w: 0.5, h: 0.5 }}
      />
    ));
    const band = container.querySelector("[role='img']") as HTMLElement;
    // happy-dom normalises a bare ratio to `<w> / <h>`.
    expect(band.style.getPropertyValue("aspect-ratio")).toBe(`${16 / 9} / 1`);
  });

  it("keeps the closing band's fallback shape in step with the crop editor", () => {
    // Three hand-kept copies of this number: `CROP_ASPECT.footer` (the editor
    // frame), this package's `LEGACY_CROP_ASPECT` (the preview) and the guest
    // site's (the invite). The cross-package pair can only be hand-diffed, but
    // the two in THIS package must fail loudly rather than drift — a divergence
    // publishes one shape and previews another, the exact bug the closing band
    // was reworked to remove.
    expect(LEGACY_CROP_ASPECT).toBe(CROP_ASPECT.footer);
  });

  it("names the closing image identically whether or not a crop is saved", () => {
    // Same image, same slot: whether a non-sighted organiser is told the band
    // exists must not hinge on an unrelated setting (C-L1).
    const cropped = render(() => (
      <SectionSample
        {...props}
        imageUrl="/api/invite/anita-ben/image/footer?v=7"
        imageCrop={{ x: 0.1, y: 0.1, w: 0.5, h: 0.5, natW: 1000, natH: 500 }}
      />
    ));
    expect(
      (cropped.container.querySelector("[role='img']") as HTMLElement).getAttribute("aria-label"),
    ).toBe("Closing section artwork");
    cleanup();

    const plain = render(() => (
      <SectionSample {...props} imageUrl="/api/invite/anita-ben/image/footer?v=7" />
    ));
    expect((plain.container.querySelector("img") as HTMLElement).getAttribute("alt")).toBe(
      "Closing section artwork",
    );
  });

  it("keeps the sample's padding on the content block, not on the band", () => {
    // The negative assertions above ("the band's parent has no p-4") pass just
    // as happily if the content block lost its classes altogether — which would
    // un-pad and un-centre EVERY preview surface in the builder with the whole
    // suite green, since the other specs locate by text and read inline styles.
    const { container } = render(() => <SectionSample {...props} />);
    const content = screen.getByText(props.body).parentElement as HTMLElement;
    expect(content.className).toContain("p-4");
    expect(content.className).toContain("text-center");
    expect(content.className).toContain("items-center");
    expect((container.firstElementChild as HTMLElement).className).not.toContain("p-4");
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

/**
 * The samples follow the wedding's DESIGN PACK, not just its scheme. This is
 * the half that was missing: colours, fonts and copy were exact and the layout
 * was a fiction, so switching Classic → Gala changed the radio card and nothing
 * else in the preview. What's asserted here is the class contract for each
 * pack's structural moves — see `design-layout.ts` for what each one traces
 * back to in `cire/invites/src/designs/<id>/`.
 */
describe("design-aware shape", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  const hero = {
    imageUrl: null,
    title: "Anita & Ben",
    heroBlur: 28,
    backdropOpacity: 0,
    backdropBlur: 0,
    surface: "var(--color-bg)",
  };
  const section = {
    surface: "var(--color-bg)",
    eyebrow: "Celebrate With Us",
    heading: "Your Events",
    body: "Your events, from the spreadsheet import.",
  };

  it("centres classic's hero title and anchors gala's bottom-left", () => {
    const classic = render(() => <HeroSample {...hero} design="classic" />);
    expect(classic.container.firstElementChild?.className).toContain("items-center");
    cleanup();

    const gala = render(() => <HeroSample {...hero} design="gala" />);
    const frame = gala.container.firstElementChild!.className;
    // `items-start justify-end` — the editorial hero the pack is named for.
    expect(frame).toContain("items-start");
    expect(frame).toContain("justify-end");
    expect(frame).not.toContain("items-center");
    expect(screen.getByText("Anita & Ben").className).toContain("text-left");
  });

  it("previews an unknown or absent design as the default pack, never as nothing", () => {
    const { container } = render(() => <HeroSample {...hero} design="not-a-design" />);
    expect(container.firstElementChild?.className).toContain("items-center");
    cleanup();
    // No `design` at all (the inline callers before a load resolves).
    const bare = render(() => <HeroSample {...hero} />);
    expect(bare.container.firstElementChild?.className).toContain("items-center");
  });

  it("centres classic's section copy and left-aligns gala's", () => {
    const classic = render(() => <SectionSample {...section} design="classic" />);
    expect(classic.container.querySelector(".text-center")).toBeTruthy();
    cleanup();

    const gala = render(() => <SectionSample {...section} design="gala" />);
    expect(gala.container.querySelector(".text-left")).toBeTruthy();
    expect(gala.container.querySelector(".text-center")).toBeNull();
  });

  it("draws the events hairline only for the pack that has one", () => {
    // The flag is the CALLER saying "this is the events section"; the pack
    // decides whether that section carries a rule.
    const classic = render(() => <SectionSample {...section} design="classic" rule />);
    expect(classic.container.querySelector("hr")).toBeNull();
    cleanup();

    const gala = render(() => <SectionSample {...section} design="gala" rule />);
    expect(gala.container.querySelector("hr")).toBeTruthy();
    cleanup();

    // …and a gala section that isn't the events one gets no rule either.
    const galaStory = render(() => <SectionSample {...section} design="gala" />);
    expect(galaStory.container.querySelector("hr")).toBeNull();
  });

  it("insets gala's code-entry block as a panel, leaving classic's a full band", () => {
    const classic = render(() => <SectionSample {...section} design="classic" panel />);
    const classicBlock = classic.container.querySelector(".p-4")!;
    expect(classicBlock.className).not.toContain("border");
    cleanup();

    const gala = render(() => <SectionSample {...section} design="gala" panel />);
    const galaBlock = gala.container.querySelector(".rounded-sm")!;
    expect(galaBlock.className).toContain("border");
    expect(galaBlock.className).toContain("m-4");
  });
});

/**
 * The INLINE preview layer's design forwarding. `PreviewPane` is the wide
 * layout's sticky pane; these two wrappers are what a builder narrower than
 * `@4xl/builder` shows instead — i.e. what an organiser on a laptop or phone
 * is actually looking at while editing. The samples' shape contract is pinned
 * above, so all that's needed here is that the prop arrives: without these,
 * deleting `design=` from the six inline call sites in `InviteBuilder.tsx`
 * leaves the whole suite green on the majority surface.
 */
describe("inline preview wrappers forward the design", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("HeroPreview renders gala's bottom-left hero, not classic's centred one", () => {
    render(() => (
      <HeroPreview
        imageUrl={null}
        title="Anita & Ben"
        heroBlur={28}
        backdropOpacity={0}
        backdropBlur={0}
        tokens={{}}
        surface="var(--color-bg)"
        design="gala"
      />
    ));
    const frame = screen.getByLabelText("Hero preview");
    expect(frame.querySelector(".items-start")).toBeTruthy();
    expect(frame.querySelector(".justify-end")).toBeTruthy();
    expect(within(frame).getByText("Anita & Ben").className).toContain("text-left");
  });

  it("HeroPreview still centres for classic", () => {
    render(() => (
      <HeroPreview
        imageUrl={null}
        title="Anita & Ben"
        heroBlur={28}
        backdropOpacity={0}
        backdropBlur={0}
        tokens={{}}
        surface="var(--color-bg)"
        design="classic"
      />
    ));
    const frame = screen.getByLabelText("Hero preview");
    expect(frame.querySelector(".items-center")).toBeTruthy();
    expect(frame.querySelector(".justify-end")).toBeNull();
  });

  it("SectionPreview forwards design + rule (gala's events hairline)", () => {
    render(() => (
      <SectionPreview
        label="Events Section"
        tokens={{}}
        surface="var(--color-bg)"
        eyebrow="Celebrate With Us"
        heading="Your Events"
        body="Your events, from the spreadsheet import."
        design="gala"
        rule
      />
    ));
    const frame = screen.getByLabelText("Events Section preview");
    expect(frame.querySelector(".text-left")).toBeTruthy();
    expect(frame.querySelector("hr")).toBeTruthy();
  });

  it("SectionPreview forwards panel (gala's inset code-entry card)", () => {
    render(() => (
      <SectionPreview
        label="Code Entry & Welcome"
        tokens={{}}
        surface="var(--color-bg)"
        eyebrow="Your Invitation"
        heading="Enter Your Code"
        body="We are delighted to invite you."
        design="gala"
        panel
      />
    ));
    const block = screen.getByLabelText("Code Entry & Welcome preview").querySelector(".m-4")!;
    expect(block.className).toContain("border");
  });

  it("SectionPreview leaves classic a full band with no rule", () => {
    render(() => (
      <SectionPreview
        label="Events Section"
        tokens={{}}
        surface="var(--color-bg)"
        eyebrow="Celebrate With Us"
        heading="Your Events"
        body="Your events, from the spreadsheet import."
        design="classic"
        rule
        panel
      />
    ));
    const frame = screen.getByLabelText("Events Section preview");
    expect(frame.querySelector("hr")).toBeNull();
    expect(frame.querySelector(".m-4")).toBeNull();
  });
});
