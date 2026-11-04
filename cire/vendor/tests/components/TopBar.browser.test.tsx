/**
 * The vendor top bar at a phone's width, in Chromium with the portal's own
 * stylesheet. The wordmark's box pulls 4px left and none right, so everything
 * after it sits 4px further right than the bars drew it before; the row holds
 * the wordmark, the two view tabs and the account trigger, all of which keep
 * their width. These hold that the row still fits, measured in the portal's
 * fallback faces (`useFallbackFonts`), which a browser draws until the web
 * faces load and when they never do, so no word is measured in a face the
 * portal never shows.
 *
 * And every word in the bar, as painted over whatever scrolls beneath it. The
 * bar lays the page's colour, a little short of opaque, over that content,
 * blurred; the blur only averages it, so the extremes are pure black and pure
 * white. Each word is composited bottom-up — the content, the bar's ground,
 * every ground between the bar and the word, then its ink — in both themes,
 * and held to 4.5:1, or 3:1 for ornament in `--text-faint` (`DESIGN.md`).
 */

import { contrastRatio, WCAG_TEXT_MIN } from "@cire/theme";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";

import TopBar from "../../src/components/TopBar";
import { useFallbackFonts } from "../test-support/fonts";

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
  document.documentElement.removeAttribute("style");
  document.documentElement.removeAttribute("data-theme");
});

function mountBar() {
  return render(() => (
    <div class="@container/frame">
      <TopBar
        session={SESSION}
        view="listings"
        onView={() => {}}
        onHome={() => {}}
        onSignOut={() => {}}
      />
    </div>
  ));
}

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

/**
 * The grounds painted under `el`'s centre inside `bar`, bottom-up: its
 * ancestors' and any layer laid beside it, such as a glass track's sliding
 * highlight, which is a sibling of the words it sits under. Hit testing finds
 * that stack only for elements that take the pointer, so every element in the
 * bar takes it while this reads.
 */
function groundsUnder(el: Element, bar: Element): string[] {
  const probe = document.createElement("style");
  probe.textContent = "header, header * { pointer-events: auto !important; }";
  document.head.append(probe);
  const box = el.getBoundingClientRect();
  const stack = document.elementsFromPoint(box.left + box.width / 2, box.top + box.height / 2);
  probe.remove();
  const from = stack.findIndex((node) => node === el || el.contains(node));
  const grounds: string[] = [];
  for (const node of stack.slice(from)) {
    if (bar.contains(node)) grounds.unshift(getComputedStyle(node).backgroundColor);
  }
  return grounds;
}

/** A colour token as the engine paints it, read off a probe. */
function painted(token: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${token})`;
  document.body.append(probe);
  const value = getComputedStyle(probe).color;
  probe.remove();
  return value;
}

/** `--text-faint`'s floor: large text, ornament and disabled. */
const ORNAMENT_MIN = 3;

/** Each word in `bar` that is on screen, with its ratio over `content`. */
function readings(bar: Element, content: string) {
  const faint = painted("--text-faint");
  return [...bar.querySelectorAll("*")]
    .filter((el) => {
      const own = [...el.childNodes].some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim() !== "",
      );
      const box = el.getBoundingClientRect();
      return own && el.checkVisibility() && box.width > 1 && box.height > 1;
    })
    .map((el) => {
      const grounds = groundsUnder(el, bar);
      const under = composite([content, ...grounds]);
      const ink = getComputedStyle(el).color;
      const ratio = contrastRatio(composite([under, ink]), under)!;
      const floor = ink === faint ? ORNAMENT_MIN : WCAG_TEXT_MIN;
      return { line: `${el.textContent!.trim()}: ${ratio.toFixed(2)} (${floor}:1)`, ratio, floor };
    });
}

describe("the vendor top bar", () => {
  for (const width of [320, 390]) {
    it(`keeps its row inside a ${width}px screen`, async () => {
      await page.viewport(width, 700);
      useFallbackFonts();
      render(() => (
        <div class="@container/frame">
          <TopBar
            session={SESSION}
            view="listings"
            onView={() => {}}
            onHome={() => {}}
            onSignOut={() => {}}
          />
        </div>
      ));
      await document.fonts.ready;
      const row = screen.getByRole("button", { name: "Cire — your listings" }).parentElement!;
      expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth);
      const trigger = screen.getByRole("button", { name: "Account menu" });
      expect(trigger.getBoundingClientRect().right).toBeLessThanOrEqual(width);
    });
  }
});

describe("the vendor top bar's words, over what scrolls beneath it", () => {
  const CONTENT = { black: "rgb(0, 0, 0)", white: "rgb(255, 255, 255)" } as const;
  for (const theme of ["light", "dark"] as const) {
    for (const [content, colour] of Object.entries(CONTENT)) {
      it(`read 4.5:1 or more over ${content} in the ${theme} theme`, async () => {
        await page.viewport(1280, 800);
        document.documentElement.setAttribute("data-theme", theme);
        const { container } = mountBar();
        const measured = readings(container.querySelector("header")!, colour);
        expect(measured.length, "no words found in the bar").toBeGreaterThan(2);
        const all = measured.map((r) => r.line).join(" · ");
        const below = measured.filter((r) => r.ratio < r.floor).map((r) => r.line);
        expect(below, `measured ${all}`).toEqual([]);
      });
    }
  }
});
