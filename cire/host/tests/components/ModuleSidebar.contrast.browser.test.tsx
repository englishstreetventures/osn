import { contrastRatio, WCAG_TEXT_MIN } from "@cire/theme";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The selected module's label, as painted.
 *
 * The label is the one piece of text that says where the organiser is, and it
 * sits on a gold wash: the sheet row carries `bg-gold/10` itself, and the rail
 * row sits over the sliding pill, a sibling that carries the same wash. The
 * fast tier proves the label's class; only a stylesheet and a compositor can
 * say what the ink measures against the wash over the page, in each theme.
 * Same canvas-compositing method as `ImportPanel.browser.test.tsx`.
 */

vi.mock("../../src/lib/haptics", () => ({ haptic: () => {} }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch: vi.fn() }) }));

import ModuleSidebar from "../../src/components/ModuleSidebar";

/** Composite `layers` bottom-up on a 1px canvas and read back plain `rgb`. */
function composite(layers: readonly string[]): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  for (const layer of layers) {
    ctx.fillStyle = layer;
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

/** Every ancestor background of `element`, outermost first, its own last. */
function ancestorLayers(element: Element): string[] {
  const layers: string[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") layers.push(bg);
  }
  return layers.toReversed();
}

/** The label's ink against its backdrop, both composited as the screen shows them. */
function ratio(label: Element, extraBackdrop: readonly string[] = []): number {
  const backdrop = composite([...ancestorLayers(label), ...extraBackdrop]);
  const ink = composite([backdrop, getComputedStyle(label).color]);
  return contrastRatio(ink, backdrop)!;
}

function mountAt(width: number) {
  return render(() => (
    <div class="@container/shell" style={{ width: `${width}px` }}>
      <ModuleSidebar
        weddingId="wed_test"
        weddingSlug="test-wedding"
        canManage={false}
        active="guests"
        tier="crimson"
        onSelect={() => {}}
      />
    </div>
  ));
}

afterEach(async () => {
  cleanup();
  await commands.emulateMedia({ colorScheme: "no-preference" });
});

describe("ModuleSidebar — the selected label, as painted", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`reads at 4.5:1 or more on the rail's pill in the ${scheme} theme`, async () => {
      await commands.emulateMedia({ colorScheme: scheme });
      const { container } = mountAt(1200);
      const row = container.querySelector("nav button[aria-current='page']")!;
      const label = row.querySelector("span")!;
      // The pill is the nav's first child, under the rows rather than their
      // ancestor, so its wash is added to the label's backdrop by hand.
      const pill = row.parentElement!.querySelector("span[aria-hidden='true']")!;
      const measured = ratio(label, [getComputedStyle(pill).backgroundColor]);
      expect(measured, `rail label measured ${measured.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        WCAG_TEXT_MIN,
      );
    });

    it(`reads at 4.5:1 or more on the sheet's selected row in the ${scheme} theme`, async () => {
      await commands.emulateMedia({ colorScheme: scheme });
      const { container } = mountAt(375);
      container
        .querySelector<HTMLButtonElement>("button[aria-label^='Open wedding navigation']")!
        .click();
      await vi.waitFor(() => {
        if (!document.querySelector("[role='dialog'] button[aria-current='page']")) {
          throw new Error("sheet not open");
        }
      });
      const row = document.querySelector("[role='dialog'] button[aria-current='page']")!;
      // The module name, not the hint under it, which carries its own ink.
      const label = row.querySelector("span.truncate")!;
      const measured = ratio(label);
      expect(measured, `sheet label measured ${measured.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        WCAG_TEXT_MIN,
      );
    });
  }
});
