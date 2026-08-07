import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import "../styles/global.css";

/**
 * The one thing about this button only a real engine can answer: **does it
 * actually appear?**
 *
 * The regression it exists for was a visibility outcome at a width — the invite
 * preview was wrapped in `hidden @2xl/frame:inline`, so on a phone the control
 * did not exist anywhere in the portal. The fix replaces that with a collapse:
 * the glyph paints on a narrow bar, the label takes over on a wide one.
 *
 * Every assertion available to the fast tier is a class string, and
 * `browser-tests.md` names the exact failure mode that leaves untouched: a class
 * Tailwind never emits compiles to no CSS at all, silently, and the string
 * assertion passes either way. `@2xl/frame:not-sr-only` is the package's only
 * container-scoped `not-sr-only`, so it has no sibling call site to fail loudly
 * on its behalf. `layout-utilities.test.ts` guards that the `frame` container is
 * declared; this guards that querying it produces the two states intended.
 *
 * Both widths are asserted from one mount, because the bug was never "the wrong
 * thing shows" — it was "nothing shows at one of them".
 */

vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch: vi.fn() }) }));
vi.mock("../lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));

import PreviewInviteButton from "./PreviewInviteButton";

/** Mount inside a `frame` container of an explicit width, as `index.astro` does. */
function mountAt(width: number) {
  const result = render(() => (
    <div class="@container/frame" style={{ width: `${width}px` }}>
      <PreviewInviteButton weddingId="wed_bootstrap" />
    </div>
  ));
  const button = result.container.querySelector("button") as HTMLButtonElement;
  return {
    button,
    glyph: button.querySelector("span[aria-hidden='true']") as HTMLElement,
    label: button.querySelector("span:not([aria-hidden])") as HTMLElement,
  };
}

describe("PreviewInviteButton — painted", () => {
  afterEach(() => cleanup());

  it("paints the glyph and clips the label on a phone-width bar", () => {
    const { button, glyph, label } = mountAt(400);

    // The control is genuinely on screen — the whole point of the fix.
    const box = button.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    expect(getComputedStyle(button).display).not.toBe("none");

    // The glyph stands in for the label at this width.
    expect(getComputedStyle(glyph).display).not.toBe("none");
    expect(glyph.getBoundingClientRect().width).toBeGreaterThan(0);

    // The label is CLIPPED, not removed: `sr-only` is the 1×1 absolutely
    // positioned box, so it keeps naming the button for assistive tech while
    // taking no space. `display: none` here would be the accessibility bug.
    const labelStyle = getComputedStyle(label);
    expect(labelStyle.display).not.toBe("none");
    expect(labelStyle.position).toBe("absolute");
    expect(label.getBoundingClientRect().width).toBeLessThanOrEqual(1);
  });

  it("swaps to the written label once the bar is wide enough", () => {
    const { button, glyph, label } = mountAt(900);

    // Above 42rem the container query fires: label laid out for real…
    const labelStyle = getComputedStyle(label);
    expect(labelStyle.position).toBe("static");
    expect(label.getBoundingClientRect().width).toBeGreaterThan(1);
    expect(label.textContent).toContain("Preview invite");

    // …and the glyph, now redundant, is gone.
    expect(getComputedStyle(glyph).display).toBe("none");

    // The button grew to hold the words rather than staying icon-sized.
    expect(button.getBoundingClientRect().width).toBeGreaterThan(60);
  });
});
