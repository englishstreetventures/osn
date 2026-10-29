// @vitest-environment happy-dom
import { Notice, type NoticeSize } from "@shared/ui/ui/notice";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import Note from "../src/note";

/**
 * `Note` is `Notice`'s accent tone with cire's ✦ in its mark slot and "Note"
 * read in its place (englishstreetventures/osn#1868). What a call site relies
 * on: the star is there and hidden from assistive technology, the word is read,
 * the box is the accent tone at the size asked for — `sm` unless told — and
 * nothing a caller spreads turns it into another tone or swaps its mark.
 */

afterEach(cleanup);

const SIZES = ["inline", "sm", "md"] as const satisfies readonly NoticeSize[];

describe("Note", () => {
  it("leads with a star hidden from assistive technology", () => {
    const { container } = render(() => <Note>Preview: nothing you send is saved.</Note>);
    expect(container.querySelector("[aria-hidden='true'] svg path")).not.toBeNull();
  });

  it.each(SIZES)("draws the %s note's star in the text's colour and at its size", (size) => {
    const { container } = render(() => <Note size={size}>words</Note>);
    const star = container.querySelector("[aria-hidden='true'] svg");
    expect(star).not.toBeNull();
    expect(star!.getAttribute("fill")).toBe("currentColor");
    expect(star!.getAttribute("width")).toMatch(/em$/);
    expect(star!.getAttribute("height")).toMatch(/em$/);
  });

  it("reads the word Note in the star's place", () => {
    const { container } = render(() => <Note>Preview: nothing you send is saved.</Note>);
    expect(container.querySelector(".base\\:sr-only")?.textContent).toBe("Note: ");
  });

  it.each(SIZES)("is Notice's accent box at the %s size", (size) => {
    const note = render(() => <Note size={size}>words</Note>);
    const noteClass = note.container.firstElementChild?.getAttribute("class");
    note.unmount();
    const notice = render(() => (
      <Notice tone="accent" size={size}>
        words
      </Notice>
    ));
    expect(noteClass).toBe(notice.container.firstElementChild?.getAttribute("class"));
  });

  it("is the small box when no size is asked for", () => {
    const note = render(() => <Note>words</Note>);
    const noteClass = note.container.firstElementChild?.getAttribute("class");
    note.unmount();
    const notice = render(() => (
      <Notice tone="accent" size="sm">
        words
      </Notice>
    ));
    expect(noteClass).toBe(notice.container.firstElementChild?.getAttribute("class"));
  });

  it("stays the accent tone and keeps its star whatever a caller spreads", () => {
    const spread: Record<string, unknown> = {
      tone: "danger",
      mark: { icon: <i data-testid="other" />, word: "Error" },
    };
    const { container } = render(() => <Note {...spread}>words</Note>);
    expect(container.firstElementChild?.getAttribute("class")).toContain("base:text-ui-accent-ink");
    expect(container.querySelector("[data-testid='other']")).toBeNull();
    expect(container.textContent).not.toContain("Error");
    expect(container.textContent).toContain("Note:");
  });

  it("lets no markup, handler or hiding attribute through to the element", () => {
    const spread: Record<string, unknown> = {
      innerHTML: "<img src=x>",
      "prop:innerHTML": "<img src=x>",
      onClick: () => undefined,
      inert: true,
      "aria-hidden": "true",
      "aria-label": "Fine",
      title: "Note",
    };
    const { container } = render(() => <Note {...spread}>words</Note>);
    const box = container.firstElementChild!;
    expect(box.querySelector("img")).toBeNull();
    for (const name of ["onclick", "inert", "aria-hidden", "aria-label", "title"]) {
      expect(box.hasAttribute(name)).toBe(false);
    }
    expect(container.textContent).toContain("Note:");
  });

  it("announces itself only when asked", () => {
    const quiet = render(() => <Note>standing</Note>);
    expect(quiet.container.firstElementChild?.getAttribute("role")).toBeNull();
    quiet.unmount();
    const loud = render(() => <Note alert>just changed</Note>);
    expect(loud.container.firstElementChild?.getAttribute("role")).toBe("alert");
  });

  it("draws a star in every note on the page, not one shared between them", () => {
    const { container } = render(() => (
      <>
        <Note>first</Note>
        <Note>second</Note>
      </>
    ));
    const stars = [...container.children].map((note) =>
      note.querySelector("[aria-hidden='true'] svg"),
    );
    expect(stars.every((star) => star !== null)).toBe(true);
  });
});
