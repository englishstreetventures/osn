import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { commands } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * A `<details>` body fading in as it opens, and not for a reader who asked for
 * no motion. The global reduced-motion block selects `*`, which no
 * pseudo-element matches, so it cannot reach `::details-content`: the fade is
 * gated by its own `no-preference` query, and only a real engine computes a
 * pseudo-element's animation to show which one won.
 */

const body = (el: Element) => getComputedStyle(el, "::details-content");

afterEach(async () => {
  cleanup();
  await commands.emulateMedia({ reducedMotion: "no-preference" });
});

describe("a disclosure opening", () => {
  it("fades its body in, and simply opens under reduced motion", async () => {
    const { container } = render(() => (
      <details>
        <summary>More</summary>
        <p>Inside</p>
      </details>
    ));
    const details = container.querySelector("details")!;
    details.open = true;
    expect(body(details).animationName).toBe("details-in");

    details.open = false;
    await commands.emulateMedia({ reducedMotion: "reduce" });
    details.open = true;
    expect(body(details).animationName).toBe("none");
  });
});
