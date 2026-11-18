/**
 * The vendor's account menu in Chromium with the portal's own stylesheet: the
 * build's version, the menu's last line, read at 4.5:1 on the menu in both
 * themes, composited over every ground beneath it.
 */

import { contrastRatio, WCAG_TEXT_MIN } from "@cire/theme";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import "../../src/styles/global.css";

import ProfileMenu from "../../src/components/ProfileMenu";

const SESSION = {
  osnProfileId: "usr_fixture",
  displayName: "Acme Florals",
  handle: "acme",
  email: "hello@acme.test",
  avatarUrl: null,
  expiresAt: "2099-01-01T00:00:00.000Z",
} as const;

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
});

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

/** The grounds under `el`, the page's first, then each ancestor's down to its own. */
function groundsUnder(el: Element): string[] {
  const layers: string[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) {
    layers.unshift(getComputedStyle(node).backgroundColor);
  }
  return layers;
}

describe("the vendor's account menu", () => {
  for (const theme of ["light", "dark"] as const) {
    it(`reads the build's version at ${WCAG_TEXT_MIN}:1 on the menu, ${theme}`, async () => {
      document.documentElement.setAttribute("data-theme", theme);
      render(() => <ProfileMenu session={SESSION} onSignOut={() => {}} />);
      // Waited for, not read at once: the menu the light test left open can
      // still hold `aria-hidden` on `<body>` for a frame after it unmounts
      // (wiki/conventions/browser-tests.md, A slow runner's frames).
      const trigger = await screen.findByRole("button", { name: /account menu/i });
      fireEvent.pointerDown(trigger, { button: 0 });
      const open = await waitFor(() => screen.getByRole("menu"));
      await Promise.all(open.getAnimations().map((a) => a.finished));
      const line = screen.getByText(/^Version /);
      const under = composite(["#fff", ...groundsUnder(line)]);
      const ratio = contrastRatio(composite([under, getComputedStyle(line).color]), under)!;
      expect(ratio).toBeGreaterThanOrEqual(WCAG_TEXT_MIN);
    });
  }
});
