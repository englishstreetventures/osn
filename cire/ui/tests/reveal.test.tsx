// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";

import Reveal from "../src/reveal";

/*
 * The structural half of `Reveal`. The animation itself is a real transition on
 * `grid-template-rows` and belongs to the browser tier — happy-dom computes no
 * layout and runs no transitions, so a height assertion here would pass against
 * a component that animates nothing.
 *
 * What is checkable here is the part the animation is built on: the wrapper
 * outlives the content, and the content is genuinely out of the document when
 * closed rather than merely invisible. That second one is the accessibility
 * claim — a collapsed box holding a focusable field is something a keyboard can
 * reach and an eye cannot.
 */

afterEach(cleanup);

describe("Reveal", () => {
  it("keeps the content out of the document while closed", () => {
    render(() => (
      <Reveal when={false}>
        <input aria-label="Anything else" />
      </Reveal>
    ));
    expect(screen.queryByLabelText("Anything else")).toBeNull();
  });

  it("puts the content in the document when open", () => {
    render(() => (
      <Reveal when={true}>
        <input aria-label="Anything else" />
      </Reveal>
    ));
    expect(screen.getByLabelText("Anything else")).toBeTruthy();
  });

  it("keeps the same wrapper element across a toggle", () => {
    // The whole reason the wrapper is unconditional: a transition needs two
    // states on ONE element, and an element inserted at the moment it opens has
    // only the state it was inserted with.
    const [open, setOpen] = createSignal(false);
    const { container } = render(() => (
      <Reveal when={open()}>
        <input aria-label="Anything else" />
      </Reveal>
    ));
    const before = container.firstElementChild;
    setOpen(true);
    expect(container.firstElementChild).toBe(before);
  });

  it("only opens the track when it is open", () => {
    const [open, setOpen] = createSignal(false);
    const { container } = render(() => (
      <Reveal when={open()}>
        <input aria-label="Anything else" />
      </Reveal>
    ));
    // Both halves, because two conflicting utilities on one element resolve by
    // stylesheet order rather than by attribute order — so "the open class is
    // present" is satisfied by an element carrying both, which would render at
    // whichever height Tailwind's output happens to put last.
    const wrapper = container.firstElementChild as HTMLElement;
    expect(wrapper.className).toContain("grid-rows-[0fr]");
    expect(wrapper.className).not.toContain("grid-rows-[1fr]");
    setOpen(true);
    expect(wrapper.className).toContain("grid-rows-[1fr]");
    expect(wrapper.className).not.toContain("grid-rows-[0fr]");
  });
});
