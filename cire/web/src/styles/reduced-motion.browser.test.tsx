import { render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";

import "./global.css";

/**
 * The invite's reduced-motion promise, checked against the engine rather than
 * against the text of `global.css`.
 *
 * Every existing assertion about that block is a regex over the stylesheet as a
 * string (`components/rsvp-saved.test.ts`, and the pattern
 * `styles/root-type-scale.test.ts` established). Those prove the rule was
 * *written*. They cannot prove it *applies* — a selector the cascade never
 * reaches, a specificity loss, or a Tailwind layer that outranks it would leave
 * every one of them green while a guest who asked for no motion got the full
 * choreography.
 *
 * This file emulates the preference for real and reads the computed durations
 * back, which is only meaningful in a browser: jsdom parses no stylesheet and
 * `matchMedia` there is a stub that never matches anything.
 */

/** Typed accessor for the command registered in `vitest.config.ts`. */
const emulate = (options: { reducedMotion?: "reduce" | "no-preference" }) =>
  (commands as unknown as { emulateMedia: (o: typeof options) => Promise<void> }).emulateMedia(
    options,
  );

afterEach(async () => {
  // The browser context is shared across tests in this file, so a leaked
  // preference would silently rewrite every later assertion about motion.
  await emulate({ reducedMotion: "no-preference" });
});

describe("prefers-reduced-motion", () => {
  it("leaves animation at full length by default", async () => {
    const { container } = render(() => <div class="transition-transform duration-500 ease-out" />);
    const cs = getComputedStyle(container.firstElementChild as HTMLElement);
    expect(cs.transitionDuration).toBe("0.5s");
  });

  it("clamps transitions to effectively zero when the guest asks for less motion", async () => {
    // The half that matters for the RSVP sweep and the modal's fades: these are
    // `transition`s, and a block that only clamped `animation-*` would leave
    // them running at full length.
    await emulate({ reducedMotion: "reduce" });
    const { container } = render(() => <div class="transition-transform duration-500 ease-out" />);
    const cs = getComputedStyle(container.firstElementChild as HTMLElement);
    expect(Number.parseFloat(cs.transitionDuration)).toBeLessThan(0.001);
    expect(cs.transitionDelay).toBe("0s");
  });

  it("clamps keyframe animations too", async () => {
    // Deliberately NOT `animate-spin` — that class is the block's one documented
    // exemption (covered below), and its `!important` duration would beat the
    // inline style here, making this assert the opposite of what it means to.
    // Any ordinary animated element stands in for a future keyframe.
    await emulate({ reducedMotion: "reduce" });
    const { container } = render(() => <div />);
    const el = container.firstElementChild as HTMLElement;
    el.style.animation = "fade 2s linear";

    const cs = getComputedStyle(el);
    expect(Number.parseFloat(cs.animationDuration)).toBeLessThan(0.001);
    expect(cs.animationIterationCount).toBe("1");
  });

  it("keeps the spinner turning, because a frozen spinner reads as 'nothing is happening'", async () => {
    // The one documented exemption. Losing it would be an accessibility
    // regression dressed as compliance, and no text assertion covers it.
    await emulate({ reducedMotion: "reduce" });
    const { container } = render(() => <div class="animate-spin" />);
    const cs = getComputedStyle(container.firstElementChild as HTMLElement);
    expect(Number.parseFloat(cs.animationDuration)).toBeGreaterThan(0.5);
    expect(cs.animationIterationCount).toBe("infinite");
  });

  it("lands a transition on its END state rather than skipping it", async () => {
    // Why the clamp is 0.01ms and not `none`: `transitionend` must still fire,
    // or any state machine awaiting it stalls forever. This is the behaviour
    // the comment in global.css claims, asserted.
    await emulate({ reducedMotion: "reduce" });
    const { container } = render(() => (
      <div class="origin-left scale-x-0 transition-transform duration-500" />
    ));
    const el = container.firstElementChild as HTMLElement;

    const ended = new Promise<boolean>((resolve) => {
      el.addEventListener("transitionend", () => resolve(true), { once: true });
      setTimeout(() => resolve(false), 1000);
    });
    // Force a frame so the starting style is committed before the class flips.
    el.getBoundingClientRect();
    el.classList.remove("scale-x-0");
    el.classList.add("scale-x-100");

    expect(await ended).toBe(true);
    expect(getComputedStyle(el).scale).toBe("1");
  });
});
