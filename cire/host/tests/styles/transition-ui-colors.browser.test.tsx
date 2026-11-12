import { Switch } from "@shared/ui/ui/switch";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import "../../src/styles/global.css";

// `transition-ui-colors` fades a control's colours and never its outline, so a
// focus ring lands at once. Only an engine resolves the utility and the
// `--dur-fast` ladder step, so this reads the computed transition back.

afterEach(() => cleanup());

/** What `value` computes to as a transition timing function, on a probe that holds only it. */
function timing(value: string): string {
  const probe = document.createElement("div");
  probe.style.transitionTimingFunction = value;
  document.body.append(probe);
  const computed = getComputedStyle(probe).transitionTimingFunction;
  probe.remove();
  return computed;
}

describe("a transition that names no easing", () => {
  // Tailwind reads `--default-transition-timing-function` through `var()`, and
  // each cire stylesheet sets it to `--ease-out`. Only an engine shows that a
  // utility and a shared part painted by this stylesheet pick it up.
  it("runs --ease-out, not Tailwind's own curve", () => {
    const { container } = render(() => (
      <div>
        <button type="button" class="transition-ui-colors">
          Go
        </button>
        <Switch checked={false} label="Remind guests" />
      </div>
    ));
    const easeOut = timing("var(--ease-out)");
    expect(easeOut).toBe("cubic-bezier(0.23, 1, 0.32, 1)");
    const button = container.querySelector("button")!;
    // The shared `Switch`'s thumb: `transition-transform`, no easing class.
    const thumb = container.querySelector("[aria-hidden] > span")!;
    expect([button, thumb].map((el) => getComputedStyle(el).transitionTimingFunction)).toEqual([
      easeOut,
      easeOut,
    ]);
  });
});

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
