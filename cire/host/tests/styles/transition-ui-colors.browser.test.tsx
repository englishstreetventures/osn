import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import "../../src/styles/global.css";

// `transition-ui-colors` fades a control's colours and never its outline, so a
// focus ring lands at once. Only an engine resolves the utility and the
// `--dur-fast` ladder step, so this reads the computed transition back.

afterEach(() => cleanup());

describe("transition-ui-colors", () => {
  it("transitions exactly the four colour properties over the --dur-fast duration", () => {
    const { container } = render(() => (
      <button type="button" class="transition-ui-colors duration-(--dur-fast)">
        Go
      </button>
    ));
    const button = container.querySelector("button")!;
    const style = getComputedStyle(button);

    expect(style.transitionProperty.split(",").map((p) => p.trim())).toEqual([
      "color",
      "background-color",
      "border-color",
      "text-decoration-color",
    ]);

    // The ladder step, resolved by the engine on a probe that holds only it.
    const probe = document.createElement("div");
    probe.style.transitionDuration = "var(--dur-fast)";
    document.body.append(probe);
    const fast = getComputedStyle(probe).transitionDuration;
    probe.remove();

    expect(fast).not.toBe("0s");
    expect(style.transitionDuration).toBe(fast);
  });
});
