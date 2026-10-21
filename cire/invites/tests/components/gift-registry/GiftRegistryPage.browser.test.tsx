import { resetToasts } from "@shared/toast";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../../src/styles/global.css";
import { GiftRegistryPage } from "../../../src/components/gift-registry/GiftRegistryPage";
import type { GiftRegistry } from "../../../src/lib/gift-registry";
import { Z_LAYER } from "../../../src/lib/z-index";

/**
 * The closed-fund toast on the gift page, in a real browser.
 *
 * jsdom lays nothing out and applies no stylesheet, so it can say the toast was
 * raised but not that a guest can see it: that its container carries the
 * page's toast layer (over the sticky rail, under consent), that nothing
 * around it traps a `position: fixed` box, and that the Refresh button and the
 * words beside it both fit inside the toast on a phone.
 */

const API = "https://api.test";
const SLUG = "anita-and-ben";
const MESSAGE = "This fund is no longer available.";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const LIST: GiftRegistry = {
  headline: null,
  message: null,
  cashGiftsEnabled: true,
  currency: "AUD",
  items: [],
  funds: [
    {
      id: "fund-honeymoon",
      title: "Honeymoon in Kyoto",
      description: null,
      imageName: null,
      imageCrop: null,
      sortOrder: 0,
    },
  ],
};

afterEach(() => {
  cleanup();
  resetToasts();
  document.cookie = "cire_claimed=; Path=/; Max-Age=0";
  vi.unstubAllGlobals();
});

/** The toast carrying the message, and the `position: fixed` box it sits in. */
function toastFor(message: string) {
  const el = [...document.querySelectorAll<HTMLElement>(".ui-toast")].find(
    (t) => t.querySelector(".ui-toast__message")?.textContent === message,
  );
  if (!el) return null;
  let container: HTMLElement | null = el;
  while (container && getComputedStyle(container).position !== "fixed") {
    container = container.parentElement;
  }
  return { el, container };
}

describe("GiftRegistryPage — the closed-fund toast", () => {
  it("paints over the page at phone width, with its Refresh inside it", async () => {
    await page.viewport(375, 800);
    // The hint that lets the page read the household, which shows the panel.
    document.cookie = "cire_claimed=1; Path=/";
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL) => {
        const url = String(input);
        if (url.endsWith("/contribute")) {
          return Promise.resolve(json({ error: "fund_unavailable" }, 409));
        }
        if (url.endsWith("/registry/mine")) return Promise.resolve(json({ claims: [] }));
        return Promise.resolve(json(LIST));
      }),
    );
    const { container } = render(() => (
      <GiftRegistryPage apiUrl={API} slug={SLUG} inviteHref={`/${SLUG}`} />
    ));

    fireEvent.click(await screen.findByRole("radio", { name: /Honeymoon in Kyoto/ }));
    fireEvent.submit(container.querySelector("[data-gift-money] form") as HTMLFormElement);
    await vi.waitFor(() => expect(toastFor(MESSAGE)).toBeTruthy());
    const found = toastFor(MESSAGE)!;

    // The page's toast layer, applied: over the sticky rail, under consent.
    expect(found.container, "the toast has no fixed container").toBeTruthy();
    const z = Number(getComputedStyle(found.container!).zIndex);
    expect(z).toBe(Z_LAYER.TOAST);
    expect(z).toBeGreaterThan(Z_LAYER.STICKY_RAIL);
    expect(z).toBeLessThan(Z_LAYER.CONSENT);
    // Portalled out of the page section, so nothing in it can trap the box.
    expect(found.container!.closest("[data-gift-registry]")).toBeNull();

    // On screen, and the button the guest needs is inside the toast.
    const box = found.el.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(0);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(window.innerWidth);
    const refresh = screen.getByRole("button", { name: "Refresh" });
    const button = refresh.getBoundingClientRect();
    expect(button.width).toBeGreaterThan(0);
    expect(button.left).toBeGreaterThanOrEqual(box.left);
    expect(button.right).toBeLessThanOrEqual(box.right + 0.5);
    expect(refresh.scrollWidth, "the Refresh label overflows").toBeLessThanOrEqual(
      refresh.clientWidth + 1,
    );
    // The words keep a usable width beside the button. A centred container
    // offset by half the viewport may only use the other half, which on a
    // phone left the message a letter wide.
    const words = found.el.querySelector(".ui-toast__message") as HTMLElement;
    const lineHeight = Number.parseFloat(getComputedStyle(words).lineHeight);
    expect(words.getBoundingClientRect().width, "the message is squeezed").toBeGreaterThanOrEqual(
      button.width,
    );
    expect(
      words.getBoundingClientRect().height,
      "the message wraps a word a line",
    ).toBeLessThanOrEqual(3 * lineHeight + 1);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });
});
