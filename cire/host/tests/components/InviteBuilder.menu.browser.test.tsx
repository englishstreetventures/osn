import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The section menu's fade, as the engine runs it.
 *
 * Below `@3xl/builder` the section tablist is a menu under its trigger, and
 * `section-menu` fades it in and out with no script: `@starting-style` gives
 * the opening a from-state, and `transition-behavior: allow-discrete` holds
 * `display` at `grid` until the closing fade has run. jsdom runs no
 * transition, so only a real engine can say the closed menu is still laid out
 * mid-fade, and gone after it. From 48rem the same element is the row, which
 * the menu's closed state must never reach.
 *
 * Its own file because `InviteBuilder.tabs.browser.test.tsx` turns every
 * transition off for its colour readings.
 */

const { authFetchMock } = vi.hoisted(() => ({ authFetchMock: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch: authFetchMock }) }));
vi.mock("@shared/toast", () => ({ toast: { success: () => {}, error: () => {} } }));
vi.mock("../../src/lib/api", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
  return {
    ...actual,
    apiUrl: (path: string) => `https://api.test${path}`,
    isAuthExpired: () => false,
    redirectToLogin: () => {},
  };
});
vi.mock("@cire/invite-designs", () => ({
  DESIGNS: [{ id: "classic", name: "Classic", tier: "free" }],
  DEFAULT_DESIGN_ID: "classic",
}));

import InviteBuilder from "../../src/components/invite/InviteBuilder";

const CUSTOMISATION = {
  designId: "classic",
  hero: { title: null, subtitle: null, imageUrl: null },
  story: { eyebrow: null, heading: null, body: null, imageUrl: null },
  heroDisplay: { blur: 28, titleBackdrop: { opacity: 0, blur: 0 } },
  theme: {
    headingFont: null,
    bodyFont: null,
    palettePreset: null,
    palette: { ground: null, card: null, ink: null, gilt: null, bloom: null },
    tones: { hero: null, story: null, details: null, welcome: null },
  },
};

/** Let a change reach the page: two frames. */
const settle = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

const tablist = () => document.getElementById("invite-section-tablist")!;
const trigger = () => screen.getByRole("button", { name: /Choose a section/ });

/** Every running transition on `el`, by the property it moves. */
const fading = (el: Element, property: string) =>
  el
    .getAnimations()
    .filter(
      (a) => a.playState === "running" && (a as CSSTransition).transitionProperty === property,
    );

async function mountAt(width: number) {
  authFetchMock.mockResolvedValueOnce(
    new Response(JSON.stringify(CUSTOMISATION), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
  render(() => (
    <div style={{ width: `${width}px` }}>
      <InviteBuilder
        weddingId="wed_1"
        weddingSlug="anita-ben"
        weddingName="Anita & Ben"
        canEdit
        entitlements={[]}
      />
    </div>
  ));
  await waitFor(() => screen.getByText("Save invite"));
  await settle();
}

afterEach(() => cleanup());

describe("the invite builder's section menu, narrow", () => {
  it("fades in, is still laid out while it fades out, and is gone after", async () => {
    await page.viewport(1280, 800);
    await mountAt(560);
    expect(getComputedStyle(tablist()).display).toBe("none");

    fireEvent.click(trigger());
    expect(tablist().hasAttribute("data-open")).toBe(true);
    expect(getComputedStyle(tablist()).display).toBe("grid");
    expect(fading(tablist(), "opacity")).toHaveLength(1);
    await Promise.all(
      tablist()
        .getAnimations()
        .map((a) => a.finished),
    );
    expect(getComputedStyle(tablist()).opacity).toBe("1");
    await page.screenshot({
      path: "__screenshots__/InviteBuilder.menu.browser.test.tsx/section-menu-open.png",
    });

    fireEvent.click(trigger());
    expect(tablist().hasAttribute("data-open")).toBe(false);
    // `allow-discrete` holds `display` until the fade has run; without it the
    // menu is `none` here and there is nothing left to fade.
    expect(getComputedStyle(tablist()).display).toBe("grid");
    expect(fading(tablist(), "opacity")).toHaveLength(1);
    expect(getComputedStyle(tablist()).pointerEvents).toBe("none");
    await Promise.all(
      tablist()
        .getAnimations()
        .map((a) => a.finished),
    );
    await settle();
    expect(getComputedStyle(tablist()).display).toBe("none");
  });
});

describe("the invite builder's section row, wide", () => {
  it("is laid out and opaque with the menu closed", async () => {
    await page.viewport(1280, 800);
    await mountAt(1100);
    expect(tablist().hasAttribute("data-open")).toBe(false);
    const style = getComputedStyle(tablist());
    expect(style.display).toBe("flex");
    expect(style.opacity).toBe("1");
    expect(style.pointerEvents).toBe("auto");
  });
});
