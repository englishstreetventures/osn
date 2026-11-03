import { contrastRatio, WCAG_TEXT_MIN } from "@cire/theme";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * Every word in the top bar, as painted over whatever scrolls beneath it.
 *
 * The bar is sticky and lays the page's colour, a little short of opaque, over
 * the content passing under it, blurred. The blur only averages what is
 * beneath, so the extremes are pure black and pure white: a word that reads
 * 4.5:1 over both reads it over anything the portal can scroll under the bar,
 * a couple's photo included. Each word is composited bottom-up — the content,
 * the bar's ground, every ground between the bar and the word, then the
 * word's ink — in both themes, and held to its ink's floor: 4.5:1, or 3:1 for
 * ornament in `--text-faint` (the switcher's ▾), as `DESIGN.md` §2 sets it.
 * Same canvas method as `ModuleSidebar.contrast.browser.test.tsx`.
 */

vi.mock("../../src/lib/haptics", () => ({ haptic: () => {}, hapticsAvailable: () => false }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch: vi.fn() }) }));

import type { WeddingSummary } from "../../src/components/CreateWeddingForm";
import TopBar from "../../src/components/TopBar";

const SESSION = {
  osnProfileId: "usr_1",
  email: "alex@example.com",
  handle: "alex",
  displayName: "Alex Host",
  avatarUrl: null,
  expiresAt: "2099-01-01T00:00:00Z",
};

const RUTH: WeddingSummary = {
  id: "wed_1",
  slug: "ruth-and-vik",
  displayName: "Ruth & Vik",
  role: "owner",
  entitlements: [],
  guestCap: 100,
};

const CONTENT = { black: "rgb(0, 0, 0)", white: "rgb(255, 255, 255)" } as const;

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

/** Every element in `bar` that paints words of its own and is on screen. */
function wordsIn(bar: Element): Element[] {
  return [...bar.querySelectorAll("*")].filter((el) => {
    const own = [...el.childNodes].some(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent!.trim() !== "",
    );
    const box = el.getBoundingClientRect();
    return own && el.checkVisibility() && box.width > 1 && box.height > 1;
  });
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
  return stack
    .slice(from)
    .filter((node) => bar.contains(node))
    .map((node) => getComputedStyle(node).backgroundColor)
    .toReversed();
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

interface Reading {
  line: string;
  ratio: number;
  floor: number;
}

/** Each word's ratio over `content`, under the bar and everything between. */
function readings(bar: Element, content: string): Reading[] {
  const faint = painted("--text-faint");
  return wordsIn(bar).map((el) => {
    const grounds = groundsUnder(el, bar);
    const under = composite([content, ...grounds]);
    const ink = getComputedStyle(el).color;
    const ratio = contrastRatio(composite([under, ink]), under)!;
    const floor = ink === faint ? ORNAMENT_MIN : WCAG_TEXT_MIN;
    return { line: `${el.textContent!.trim()}: ${ratio.toFixed(2)} (${floor}:1)`, ratio, floor };
  });
}

/** `--text-faint`'s floor: large text, ornament and disabled, `DESIGN.md` §2. */
const ORNAMENT_MIN = 3;

function mount(wedding: WeddingSummary | null) {
  return render(() => (
    <div class="@container/frame">
      <TopBar
        session={SESSION}
        wedding={wedding}
        weddings={[RUTH]}
        sectionLabel="All weddings"
        onWedding={() => {}}
        onAll={() => {}}
        onSecurity={() => {}}
        onSignOut={() => {}}
        onOpenPalette={() => {}}
      />
    </div>
  ));
}

afterEach(async () => {
  cleanup();
  await commands.emulateMedia({ colorScheme: "no-preference" });
});

describe("the host top bar's words, over what scrolls beneath it", () => {
  for (const scheme of ["light", "dark"] as const) {
    for (const [content, colour] of Object.entries(CONTENT)) {
      for (const wedding of [RUTH, null]) {
        const where = wedding ? "in a wedding" : "on the wedding list";
        it(`read 4.5:1 or more over ${content} in the ${scheme} theme, ${where}`, async () => {
          await page.viewport(1280, 800);
          await commands.emulateMedia({ colorScheme: scheme });
          const { container } = mount(wedding);
          const bar = container.querySelector("header")!;
          const measured = readings(bar, colour);
          expect(measured.length, "no words found in the bar").toBeGreaterThan(2);
          const all = measured.map((r) => r.line).join(" · ");
          const below = measured.filter((r) => r.ratio < r.floor).map((r) => r.line);
          expect(below, `measured ${all}`).toEqual([]);
        });
      }
    }
  }
});
