import { contrastRatio, WCAG_TEXT_MIN } from "@cire/theme";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";

import "../../../src/styles/global.css";

/**
 * The design picker's small gold words, as painted.
 *
 * "Current", "Preview live" and the note under the cards are text, so they owe
 * the 4.5:1 WCAG 1.4.3 asks. `--gold` has no such contract (DESIGN.md §2); the
 * words use `--gold-ink`, and only a stylesheet and a compositor can say that
 * the class emitted CSS and what it contrasts with in each ramp. "Locked" is
 * left out: DESIGN.md allows half opacity on a card that cannot be used.
 * Same method as `ImportPanel.browser.test.tsx`.
 */

vi.mock("@cire/invite-designs", () => ({
  DESIGNS: [
    { id: "classic", name: "Classic", tier: "free" },
    { id: "gala", name: "Gala", tier: "free" },
  ],
}));

import DesignPicker from "../../../src/components/invite/DesignPicker";

function paintedBackdrop(element: Element): string {
  const layers: string[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") layers.push(bg);
  }
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  for (const layer of layers.toReversed()) {
    ctx.fillStyle = layer;
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

function paintedInk(element: Element): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = paintedBackdrop(element);
  ctx.fillRect(0, 0, 1, 1);
  ctx.fillStyle = getComputedStyle(element).color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

const ratioOn = (element: Element) => contrastRatio(paintedInk(element), paintedBackdrop(element))!;

afterEach(async () => {
  cleanup();
  await commands.emulateMedia({ colorScheme: "no-preference" });
});

describe("DesignPicker small text, as painted", () => {
  for (const scheme of ["dark", "light"] as const) {
    it(`keeps Current, Preview live and the note at 4.5:1 or more, ${scheme}`, async () => {
      await commands.emulateMedia({ colorScheme: scheme });
      render(() => (
        <DesignPicker
          entitlements={[]}
          currentId="classic"
          saving={false}
          onSelect={() => {}}
          // A link pill draws only an absolute http(s) address.
          previewHref={(id) => `https://invites.example/preview?design=${id}`}
        />
      ));
      const targets: [string, Element][] = [
        ["Current", screen.getByText("Current")],
        ["Preview live", screen.getAllByText("Preview live")[0]!],
        ["note", screen.getByText(/Saved instantly/)],
      ];
      for (const [what, el] of targets) {
        const ratio = ratioOn(el);
        expect(ratio, `${what} measured ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
          WCAG_TEXT_MIN,
        );
      }
    });
  }
});
