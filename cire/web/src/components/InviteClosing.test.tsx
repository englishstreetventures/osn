import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { BAND_IMG_CLASS, BAND_MAX_HEIGHT, bandMaxWidth, InviteClosing } from "./InviteClosing";

/**
 * Unit tests for the invite's closing section. The two design packs' InvitePage
 * tests cover the CLAIM GATE (absent pre-claim, present post-claim); this file
 * covers the component's own branches, which those tests can't reach cheaply:
 * the cropped-background path vs the plain <img> path, the aspect fallbacks, and
 * the note/image combinations.
 */

const API = "https://api.test";
const IMG = "/api/invite/anita-ben/image/footer?v=7";

const closing = (el: HTMLElement) => el.querySelector("[data-invite-closing]");

describe("InviteClosing", () => {
  afterEach(cleanup);

  describe("emptiness (the whole section is conditional)", () => {
    it("renders nothing when neither a note nor an image is set", () => {
      const { container } = render(() => <InviteClosing apiUrl={API} />);
      expect(closing(container)).toBeNull();
    });

    it("renders nothing for a whitespace-only note and no image", () => {
      const { container } = render(() => <InviteClosing apiUrl={API} message="   " />);
      expect(closing(container)).toBeNull();
    });

    it("renders for a note alone", () => {
      const { container } = render(() => (
        <InviteClosing apiUrl={API} message="No boxed gifts please" />
      ));
      const section = closing(container) as HTMLElement;
      expect(section).toBeTruthy();
      expect(section.querySelector("p")?.textContent).toBe("No boxed gifts please");
      expect(section.querySelector("img")).toBeNull();
    });

    it("renders for an image alone", () => {
      const { container } = render(() => <InviteClosing apiUrl={API} imageUrl={IMG} />);
      const section = closing(container) as HTMLElement;
      expect(section.querySelector("img")).toBeTruthy();
      expect(section.querySelector("p")).toBeNull();
    });
  });

  describe("note + image together", () => {
    it("puts the image above the note, and pads the note's own block", () => {
      const { container } = render(() => (
        <InviteClosing apiUrl={API} imageUrl={IMG} message="See you there" />
      ));
      const section = closing(container) as HTMLElement;
      const img = section.querySelector("img") as HTMLElement;
      const note = section.querySelector("p") as HTMLElement;

      // The image opens the sign-off; the couple's words read last.
      expect(img.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(note.dataset.hasImage).toBe("true");
      // The section itself is unpadded so the band can reach the viewport edge;
      // the padding that used to live there now sits on the note's own block.
      expect(section.className).not.toContain("px-6");
      expect((note.parentElement as HTMLElement).className).toContain("px-6");
      expect((note.parentElement as HTMLElement).className).toContain("py-16");
    });

    it("pads a note that has no image above it just the same", () => {
      const { container } = render(() => <InviteClosing apiUrl={API} message="See you there" />);
      const note = (closing(container) as HTMLElement).querySelector("p") as HTMLElement;
      expect(note.dataset.hasImage).toBe("false");
      expect((note.parentElement as HTMLElement).className).toContain("py-16");
    });

    it("preserves the line breaks an organiser typed", () => {
      const { container } = render(() => (
        <InviteClosing apiUrl={API} message={"line one\nline two"} />
      ));
      const note = (closing(container) as HTMLElement).querySelector("p") as HTMLElement;
      expect(note.textContent).toBe("line one\nline two");
      // `pre-line` is what makes the stored newline visible rather than collapsed.
      expect(note.className).toContain("whitespace-pre-line");
    });

    it("trims surrounding whitespace off the note", () => {
      const { container } = render(() => <InviteClosing apiUrl={API} message="  padded  " />);
      expect((closing(container) as HTMLElement).querySelector("p")?.textContent).toBe("padded");
    });
  });

  describe("image rendering (the full-bleed closing hero)", () => {
    it("resolves the path against the API origin and names a bounded variant", () => {
      const { container } = render(() => <InviteClosing apiUrl={API} imageUrl={IMG} />);
      const img = (closing(container) as HTMLElement).querySelector("img") as HTMLImageElement;

      expect(img.getAttribute("src")).toBe(`${API}${IMG}&variant=card`);
      // Two candidates, so `sizes` has a real choice and a wide desktop band
      // isn't stuck with an 800w render — this spans the viewport now.
      expect(img.getAttribute("srcset")).toContain("variant=card 800w");
      expect(img.getAttribute("srcset")).toContain("variant=hero 1600w");
      expect(img.getAttribute("sizes")).toBe("100vw");
      // Guaranteed off-screen at mount — must not race the in-viewport cards.
      expect(img.getAttribute("loading")).toBe("lazy");
      expect(img.getAttribute("decoding")).toBe("async");
      // Decorative: the couple's words carry the meaning.
      expect(img.getAttribute("alt")).toBe("");
    });

    it("spans the full width and keeps an uncropped image's own proportions", () => {
      const { container } = render(() => <InviteClosing apiUrl={API} imageUrl={IMG} />);
      const img = (closing(container) as HTMLElement).querySelector("img") as HTMLImageElement;

      // Edge to edge: full width, no centred max-width box, no rounding.
      expect(img.className).toContain("w-full");
      expect(img.className).not.toContain("rounded");
      // Nothing was cropped, so nothing is cut: `h-auto` keeps the source's own
      // proportions, and only the screen-height cap can ever clip it.
      expect(img.className).toContain("h-auto");
      expect(img.className).toContain("max-h-[85dvh]");
      expect(img.className).toContain("object-cover");
      // `auto <ratio>`, the FALLBACK form — a reserved box before the bytes
      // arrive, the image's own ratio after. A bare `16 / 9` here would impose a
      // shape on an image nobody framed; nothing at all would leave this box 0px
      // tall until a lazy image decodes and shift the page by a screen height.
      expect(img.style.getPropertyValue("aspect-ratio")).toBe(`auto ${16 / 9}`);
    });

    it("publishes the crop the organiser framed — exact region, exact shape", () => {
      const { container } = render(() => (
        <InviteClosing
          apiUrl={API}
          imageUrl={IMG}
          // 2:1 pixel aspect — (0.5·1000) / (0.5·500) = 2.
          imageCrop={{ x: 0.1, y: 0.1, w: 0.5, h: 0.5, natW: 1000, natH: 500 }}
        />
      ));
      const section = closing(container) as HTMLElement;

      // The crop path replaces the <img> entirely — one node, not both.
      expect(section.querySelector("img")).toBeNull();
      const layer = section.querySelector("[aria-hidden='true']") as HTMLElement;
      expect(layer).toBeTruthy();
      expect(layer.style.getPropertyValue("background-image")).toContain(`${API}${IMG}`);
      // The EXACT framed region, not a focal-point cover: single-value
      // background-size (uniform scale, 100/0.5 = 200%) with the box at the
      // crop's own pixel aspect. A cover fit here would show more than what the
      // organiser framed, and the crop editor would be lying to them.
      expect(layer.style.getPropertyValue("background-size")).toBe("200%");
      expect(layer.style.getPropertyValue("aspect-ratio")).toBe("2 / 1");
      // Full-bleed, bounded by the screen height as a max-WIDTH (see below).
      expect(layer.className).toContain("w-full");
      expect(layer.style.getPropertyValue("max-height")).toBe("");
    });

    it("asks for the hero width, the one a full-bleed band actually needs", () => {
      const { container } = render(() => (
        <InviteClosing
          apiUrl={API}
          imageUrl={IMG}
          imageCrop={{ x: 0, y: 0, w: 0.9, h: 0.9, natW: 1000, natH: 1000 }}
        />
      ));
      const layer = (closing(container) as HTMLElement).querySelector(
        "[aria-hidden='true']",
      ) as HTMLElement;
      // A background can't carry a srcset, so it names one bounded variant —
      // and at viewport width the 320w thumb the small box used is far too soft.
      expect(layer.style.getPropertyValue("background-image")).toContain("variant=hero");
    });

    it("bounds a tall crop by WIDTH, so the framing is never clipped", () => {
      const { container } = render(() => (
        <InviteClosing
          apiUrl={API}
          imageUrl={IMG}
          // 0.8 — a portrait crop, the case the bound exists for.
          imageCrop={{ x: 0, y: 0, w: 0.4, h: 0.5, natW: 1000, natH: 1000 }}
        />
      ));
      const layer = (closing(container) as HTMLElement).querySelector(
        "[aria-hidden='true']",
      ) as HTMLElement;

      // `width: 100%` + a max-width of cap × aspect IS `min(100%, cap × aspect)`
      // — full-bleed at any ordinary landscape shape, a centred column only when
      // the band would otherwise outgrow the screen. A `max-height` clip here
      // would instead show a top-anchored crop's TOP STRIP ONLY (measured in
      // Chromium), silently cutting the framing this path exists to honour.
      expect(bandMaxWidth(0.8)).toBe(`calc(${BAND_MAX_HEIGHT} * 0.8)`);
      // jsdom folds the multiplication (`calc(68dvh)`), so pin the shape, not
      // the arithmetic — the exact string is pinned on the helper above.
      expect(layer.style.getPropertyValue("max-width")).toMatch(/^calc\(.*dvh.*\)$/);
      expect(layer.style.getPropertyValue("max-height")).toBe("");
      expect(layer.className).toContain("mx-auto");
    });

    it("keeps the screen-height bound and its class literal in step", () => {
      // The bound lives twice: as a Tailwind literal on the uncropped path (the
      // scanner reads source text, so it cannot be computed) and as a value in
      // the cropped path's width calc. Nothing but this guard couples them.
      expect(BAND_IMG_CLASS).toContain(`max-h-[${BAND_MAX_HEIGHT}]`);
    });

    it("falls back to the plain image when a crop is present but unusable", () => {
      const { container } = render(() => (
        // A whole-image rectangle is the identity — `isRenderableCrop` rejects
        // it, so nothing was really framed.
        <InviteClosing apiUrl={API} imageUrl={IMG} imageCrop={{ x: 0, y: 0, w: 1, h: 1 }} />
      ));
      const section = closing(container) as HTMLElement;
      const img = section.querySelector("img") as HTMLImageElement;

      expect(section.querySelector("[aria-hidden='true']")).toBeNull();
      expect(img).toBeTruthy();
      // No usable crop ⇒ nothing is cut: the `auto` fallback, so the source's
      // own proportions still win once it decodes.
      expect(img.style.getPropertyValue("aspect-ratio")).toBe(`auto ${16 / 9}`);
    });

    it("falls back to the editor's 16:9 frame for a legacy crop with no dims", () => {
      const { container } = render(() => (
        <InviteClosing apiUrl={API} imageUrl={IMG} imageCrop={{ x: 0, y: 0, w: 0.5, h: 0.5 }} />
      ));
      const layer = (closing(container) as HTMLElement).querySelector(
        "[aria-hidden='true']",
      ) as HTMLElement;
      // True aspect needs the captured source dims; without them the box takes
      // the shape the closing slot's crop editor opens on (`CROP_ASPECT.footer`),
      // so the fallback matches what the organiser was shown.
      // The CSSOM normalises a bare ratio to `<w> / <h>`; compare against the
      // computed 16∶9 rather than retyping its decimal expansion.
      expect(layer.style.getPropertyValue("aspect-ratio")).toBe(`${16 / 9} / 1`);
    });
  });

  describe("surface", () => {
    it("paints the section background from the tone vars it is handed", () => {
      const { container } = render(() => (
        <InviteClosing
          apiUrl={API}
          message="See you there"
          themeVars={{ "--invite-section-bg": "var(--color-surface-raised)" }}
        />
      ));
      const section = closing(container) as HTMLElement;
      expect(section.style.getPropertyValue("--invite-section-bg")).toBe(
        "var(--color-surface-raised)",
      );
      expect(section.style.getPropertyValue("background-color")).toBe("var(--invite-section-bg)");
    });

    it("reserves a size for the band it defers painting", () => {
      const { container } = render(() => <InviteClosing apiUrl={API} imageUrl={IMG} />);
      const section = closing(container) as HTMLElement;

      // `content-visibility: auto` skips this off-screen section entirely; with
      // no intrinsic size a now-full-bleed band collapses to zero and the page's
      // scroll height jumps as the guest approaches it. Unobservable in the test
      // tier (no layout engine), so the class contract is the pin.
      expect(section.className).toContain("[content-visibility:auto]");
      // Derived from the band's real geometry (100vw at the crop's aspect), not
      // a flat guess: a placeholder 2-3x short of the rendered height moves the
      // scrollbar under the guest at the moment they scroll into the section.
      expect(section.style.getPropertyValue("contain-intrinsic-size")).toBe(
        `auto calc(100vw / ${16 / 9} + 24rem)`,
      );
    });

    it("reserves only the note's own height when there is no band", () => {
      const { container } = render(() => <InviteClosing apiUrl={API} message="See you there" />);
      const section = closing(container) as HTMLElement;
      expect(section.style.getPropertyValue("contain-intrinsic-size")).toBe("auto 24rem");
    });
  });
});
