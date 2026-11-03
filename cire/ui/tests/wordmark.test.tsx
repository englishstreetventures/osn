// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buttonClass } from "../src/button";
import Wordmark, { WordmarkPlaceholder } from "../src/wordmark";

/**
 * The top bar's "✦ Cire": a button home in both portals, and a still copy in
 * each boot bar that the button replaces. What the two bars rely on: the
 * button is named by `label` alone, answers a click and never submits a form;
 * the copy is no control at all; and the two draw the same box, so the swap
 * moves nothing.
 *
 * Three classes are read by name because they are the owner's choices, not a
 * refactor's: the star in readable gold ("gold text is always readable gold"),
 * and `Button`'s own focus ring on a box that pulls left only, so the ring
 * clears the divider beside it (Stack 6, question 40, A2).
 */

afterEach(cleanup);

/** A button's own classes: what it adds on top of the box the copy shares. */
const BUTTON_ONLY = /(^|:)(hover|focus-visible|transition|duration|ease|motion-reduce)[:-]/;

function classesOf(el: Element | null): string[] {
  return (el?.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
}

/** The size steps, which share the `text-` prefix with the colours. */
const SIZE = /(^|:)text-ui-(xs|sm|base|md|lg|xl|2xl)$/;

function inks(el: Element | null): string[] {
  return classesOf(el).filter((c) => /(^|:)text-/.test(c) && !SIZE.test(c));
}

function renderButton(onClick = () => {}) {
  render(() => <Wordmark label="Cire — all weddings" onClick={onClick} />);
  return screen.getByRole("button");
}

function renderPlaceholder() {
  const { container } = render(() => <WordmarkPlaceholder />);
  return container.firstElementChild as HTMLElement;
}

describe("Wordmark", () => {
  it("takes its accessible name from the label it is given", () => {
    // Without it the name would be "✦Cire": a way home that does not say so.
    renderButton();
    expect(screen.getByRole("button", { name: "Cire — all weddings" })).toBeTruthy();
  });

  it("calls onClick once per click", () => {
    const onClick = vi.fn();
    fireEvent.click(renderButton(onClick));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("never submits the form it sits in", () => {
    const onSubmit = vi.fn((event: Event) => event.preventDefault());
    render(() => (
      <form onSubmit={onSubmit}>
        <Wordmark label="Cire — your listings" onClick={() => {}} />
      </form>
    ));
    const button = screen.getByRole("button");
    expect(button.getAttribute("type")).toBe("button");
    fireEvent.click(button);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("draws the star in readable gold, at rest and under the pointer", () => {
    // `--ui-accent` is gold as metal, about 2.4:1 on cire's light ground.
    const star = renderButton().firstElementChild;
    expect(inks(star)).toEqual(["base:text-ui-accent-ink"]);
  });

  it("pulls its box left only, so its ring clears what follows it", () => {
    const margins = classesOf(renderButton()).filter((c) => /(^|:)-?m[xlr]?-/.test(c));
    expect(margins).toEqual(["base:-ml-1"]);
  });

  it("draws Button's own focus ring", () => {
    const ring = (classes: string[]) => classes.filter((c) => c.includes("focus-visible:"));
    expect(ring(classesOf(renderButton()))).toEqual(ring(buttonClass().split(/\s+/)));
  });
});

describe("WordmarkPlaceholder", () => {
  it("is hidden from assistive technology and is no control", () => {
    const copy = renderPlaceholder();
    expect(copy.tagName).toBe("SPAN");
    expect(copy.getAttribute("aria-hidden")).toBe("true");
    expect(copy.hasAttribute("role")).toBe(false);
    expect(copy.hasAttribute("tabindex")).toBe(false);
    expect(copy.querySelector("button, a, [tabindex], [role]")).toBeNull();
  });

  it("answers neither the pointer nor focus", () => {
    expect(classesOf(renderPlaceholder()).filter((c) => BUTTON_ONLY.test(c))).toEqual([]);
  });

  it("draws the button's box and glyphs, so the swap moves nothing", () => {
    const copy = renderPlaceholder();
    const copyBox = classesOf(copy);
    const copyGlyphs = copy.innerHTML;
    cleanup();
    const button = renderButton();
    expect(copyBox).toEqual(classesOf(button).filter((c) => !BUTTON_ONLY.test(c)));
    expect(copyGlyphs).toBe(button.innerHTML);
  });
});
