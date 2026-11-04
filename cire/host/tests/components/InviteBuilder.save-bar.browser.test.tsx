import { contrastRatio, WCAG_TEXT_MIN } from "@cire/theme";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The sticky save bar against a focused control, in a real engine.
 *
 * The fast tier (`InviteBuilder.save-bar.test.tsx`) proves the builder writes
 * the bar's height as `--save-bar-h`. Whether that keeps a focused control
 * visible is layout: the browser scrolls a focused control into view, stopping
 * at its `scroll-margin-bottom`, and only a real engine does that. This checks,
 * as the organiser sees it, that
 *
 * - the last section control, once focused, ends above the bar and its computed
 *   `scroll-margin-bottom` is the bar's height plus 8px;
 * - the same holds after a failed save grows the bar with an error row;
 * - a control reached backwards (Shift+Tab) stops below the stuck stack (top
 *   bar, view bar, section tabs), by its computed `scroll-margin-top`;
 * - "Unsaved changes" in the bar is text, so it clears the 4.5:1 WCAG asks;
 * - the bar's own Save button carries no such margin, so focusing it does not
 *   move the page.
 *
 * Screenshots go to `e2e-artifacts/cire-host/invite-builder-save-bar/`.
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
  DESIGNS: [
    { id: "classic", name: "Classic", tier: "free" },
    { id: "gala", name: "Gala", tier: "free" },
    { id: "garden", name: "Garden", tier: "free" },
    { id: "modern", name: "Modern", tier: "free" },
    { id: "rustic", name: "Rustic", tier: "free" },
    { id: "coastal", name: "Coastal", tier: "free" },
  ],
  DEFAULT_DESIGN_ID: "classic",
}));

import InviteBuilder from "../../src/components/invite/InviteBuilder";

const SHOTS = "../../../../e2e-artifacts/cire-host/invite-builder-save-bar";

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

const settle = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The bar: the form's sticky child that holds the Save button. */
const bar = () => screen.getByRole("button", { name: /Save invite|Saving/ }).closest(".sticky")!;

/** The last control the Design card offers above the bar. */
const lastControl = () => screen.getAllByRole("link", { name: /^Preview live/ }).at(-1)!;

/** The colour an element is painted ON and IN, composited on a canvas (same
 *  method as `ImportPanel.browser.test.tsx`). */
function paintedRatio(element: Element): number {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  const layers: string[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor;
    if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") layers.push(bg);
  }
  for (const layer of layers.toReversed()) {
    ctx.fillStyle = layer;
    ctx.fillRect(0, 0, 1, 1);
  }
  const [br, bg, bb] = ctx.getImageData(0, 0, 1, 1).data;
  ctx.fillStyle = getComputedStyle(element).color;
  ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return contrastRatio(`rgb(${r}, ${g}, ${b})`, `rgb(${br}, ${bg}, ${bb})`)!;
}

beforeEach(async () => {
  await page.viewport(1000, 520);
  authFetchMock.mockResolvedValueOnce(json(CUSTOMISATION));
});

afterEach(async () => {
  cleanup();
  authFetchMock.mockReset();
  window.scrollTo(0, 0);
  await commands.emulateMedia({ colorScheme: "no-preference" });
});

async function mount() {
  render(() => (
    <InviteBuilder
      weddingId="wed_1"
      weddingSlug="anita-ben"
      weddingName="Anita & Ben"
      canEdit
      entitlements={[]}
    />
  ));
  await waitFor(() => screen.getByText("Save invite"));
  await settle();
}

/** Scrolls to the top, focuses `control`, and checks it ends above the bar with
 *  the margin the bar's measured height asks for. */
async function expectClearOfBar(control: HTMLElement, what: string) {
  window.scrollTo(0, 0);
  await settle();
  // `focus()` on the element that already has it scrolls nowhere.
  (document.activeElement as HTMLElement | null)?.blur();
  control.focus();
  await settle();
  const barBox = bar().getBoundingClientRect();
  const margin = parseFloat(getComputedStyle(control).scrollMarginBottom);
  expect(margin, `${what}: scroll-margin-bottom`).toBeCloseTo(barBox.height + 8, 1);
  expect(control.getBoundingClientRect().bottom, `${what}: control bottom`).toBeLessThanOrEqual(
    barBox.top + 0.5,
  );
}

describe("InviteBuilder save bar, as laid out", () => {
  for (const scheme of ["dark", "light"] as const) {
    it(`keeps the last control above the bar, before and after an error row, ${scheme}`, async () => {
      await commands.emulateMedia({ colorScheme: scheme });
      await mount();
      expect(document.documentElement.scrollHeight).toBeGreaterThan(window.innerHeight);

      await expectClearOfBar(lastControl(), "idle bar");
      await page.screenshot({ path: `${SHOTS}/idle-${scheme}.png` });

      // An edit, then a save the server refuses: the error row joins the bar.
      const idleHeight = bar().getBoundingClientRect().height;
      fireEvent.input(screen.getByLabelText("Couple title"), { target: { value: "Anita & Ben" } });
      const ratio = paintedRatio(screen.getByText("Unsaved changes"));
      expect(ratio, `Unsaved changes measured ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(
        WCAG_TEXT_MIN,
      );
      authFetchMock.mockResolvedValueOnce(json({ error: "Could not save the invite." }, 500));
      fireEvent.click(screen.getByRole("button", { name: "Save invite" }));
      await waitFor(() => screen.getByText("Could not save the invite."));
      await settle();
      expect(bar().getBoundingClientRect().height).toBeGreaterThan(idleHeight);

      await expectClearOfBar(lastControl(), "bar with error row");
      await page.screenshot({ path: `${SHOTS}/error-${scheme}.png` });
    });
  }

  it("lets the Save button take focus without moving the page", async () => {
    await mount();
    fireEvent.input(screen.getByLabelText("Couple title"), { target: { value: "Anita & Ben" } });
    await settle();
    window.scrollTo(0, 120);
    await settle();
    const before = window.scrollY;
    const save = screen.getByRole("button", { name: "Save invite" });
    expect(parseFloat(getComputedStyle(save).scrollMarginBottom)).toBe(0);
    save.focus();
    await settle();
    expect(window.scrollY).toBe(before);
  });
});

describe("InviteBuilder stuck stack, as laid out", () => {
  it("stops a control reached backwards below the top bar, view bar and section tabs", async () => {
    // The page's own wrapper defines these (`.chrome-scope`, `ModuleShell`);
    // stand-in bars of the same heights stick above the real section tabs.
    render(() => (
      <div style={{ "--chrome-h": "3.5rem", "--bar-h": "2.5rem" }}>
        <div
          class="bg-bg sticky top-0 z-30"
          style={{ height: "var(--chrome-h)" }}
          data-testid="top-bar"
        />
        <div
          class="bg-bg sticky z-20"
          style={{ top: "var(--chrome-h)", height: "var(--bar-h)" }}
          data-testid="view-bar"
        />
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
    const tabs = screen.getAllByRole("tablist")[0]!.closest(".sticky")!;
    const stackBottom = () => tabs.getBoundingClientRect().bottom;
    const control = screen.getAllByRole("radio")[0]!;

    // Scrolled to the foot, the first card is under the stack; Shift+Tab lands on it.
    window.scrollTo(0, document.documentElement.scrollHeight);
    await settle();
    expect(control.getBoundingClientRect().top, "control starts out of view").toBeLessThan(
      stackBottom(),
    );
    (document.activeElement as HTMLElement | null)?.blur();
    control.focus();
    await settle();

    // 3.5rem top bar + 2.5rem view bar + 3.5rem tabs and half a rem of air.
    expect(parseFloat(getComputedStyle(control).scrollMarginTop)).toBeCloseTo(152, 1);
    expect(control.getBoundingClientRect().top).toBeGreaterThanOrEqual(stackBottom() - 0.5);
  });
});
