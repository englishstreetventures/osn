import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { InviteClosing } from "./InviteClosing";

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
    it("puts the image above the note and opens the gap between them", () => {
      const { container } = render(() => (
        <InviteClosing apiUrl={API} imageUrl={IMG} message="See you there" />
      ));
      const section = closing(container) as HTMLElement;
      const img = section.querySelector("img") as HTMLElement;
      const note = section.querySelector("p") as HTMLElement;

      // The motif opens the sign-off; the couple's words read last.
      expect(img.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      // The spacing hook only applies when there IS an image above the note —
      // a note-only section must not carry a phantom top gap.
      expect(note.dataset.hasImage).toBe("true");
    });

    it("marks a note with no image so it carries no top gap", () => {
      const { container } = render(() => <InviteClosing apiUrl={API} message="See you there" />);
      const note = (closing(container) as HTMLElement).querySelector("p") as HTMLElement;
      expect(note.dataset.hasImage).toBe("false");
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

  describe("image rendering", () => {
    it("resolves the path against the API origin and names a bounded variant", () => {
      const { container } = render(() => <InviteClosing apiUrl={API} imageUrl={IMG} />);
      const img = (closing(container) as HTMLElement).querySelector("img") as HTMLImageElement;

      expect(img.getAttribute("src")).toBe(`${API}${IMG}&variant=thumb`);
      // Two candidates, so `sizes` has a real choice and a 3× phone isn't
      // stuck with a 320w render of a 200px box.
      expect(img.getAttribute("srcset")).toContain("variant=thumb 320w");
      expect(img.getAttribute("srcset")).toContain("variant=card 800w");
      expect(img.getAttribute("sizes")).toBe("200px");
      // Guaranteed off-screen at mount — must not race the in-viewport cards.
      expect(img.getAttribute("loading")).toBe("lazy");
      expect(img.getAttribute("decoding")).toBe("async");
      // Decorative: the couple's words carry the meaning.
      expect(img.getAttribute("alt")).toBe("");
    });

    it("falls back to the square default aspect with no crop", () => {
      const { container } = render(() => <InviteClosing apiUrl={API} imageUrl={IMG} />);
      const img = (closing(container) as HTMLElement).querySelector("img") as HTMLImageElement;
      // The CSSOM normalises a bare ratio to `<w> / <h>`.
      expect(img.style.getPropertyValue("aspect-ratio")).toBe("1 / 1");
    });

    it("renders a cropped image as a background layer at the crop's true aspect", () => {
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
      expect(layer.style.getPropertyValue("aspect-ratio")).toBe("2 / 1");
    });

    it("asks for a bigger source only when the crop is tight", () => {
      const wide = render(() => (
        <InviteClosing
          apiUrl={API}
          imageUrl={IMG}
          imageCrop={{ x: 0, y: 0, w: 0.9, h: 0.9, natW: 1000, natH: 1000 }}
        />
      ));
      const wideLayer = (closing(wide.container) as HTMLElement).querySelector(
        "[aria-hidden='true']",
      ) as HTMLElement;
      // A gentle crop of a 200px box does not need 800w.
      expect(wideLayer.style.getPropertyValue("background-image")).toContain("variant=thumb");
      cleanup();

      const tight = render(() => (
        <InviteClosing
          apiUrl={API}
          imageUrl={IMG}
          imageCrop={{ x: 0, y: 0, w: 0.2, h: 0.2, natW: 1000, natH: 1000 }}
        />
      ));
      const tightLayer = (closing(tight.container) as HTMLElement).querySelector(
        "[aria-hidden='true']",
      ) as HTMLElement;
      // At w = 0.2 the visible region is a fifth of the source — needs the pixels.
      expect(tightLayer.style.getPropertyValue("background-image")).toContain("variant=card");
    });

    it("falls back to the square default for a legacy crop with no source dims", () => {
      const { container } = render(() => (
        <InviteClosing apiUrl={API} imageUrl={IMG} imageCrop={{ x: 0, y: 0, w: 0.5, h: 0.5 }} />
      ));
      const layer = (closing(container) as HTMLElement).querySelector(
        "[aria-hidden='true']",
      ) as HTMLElement;
      expect(layer.style.getPropertyValue("aspect-ratio")).toBe("1 / 1");
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
  });
});
