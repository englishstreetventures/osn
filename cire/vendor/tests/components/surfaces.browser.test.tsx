import { eyebrowClass } from "@cire/ui/eyebrow";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The vendor portal's cards, read from a real engine and pictured: an enquiry
 * in the inbox, the quote form in its thread, and the sign-in card. Each takes
 * its box from `@cire/ui`'s card — the inbox row and the sign-in card a
 * padding step, the quote form the small corner a box inside a card takes
 * (`cire/vendor/DESIGN.md`, Corners here) — which only a browser resolves from
 * the role map to pixels.
 *
 * The vendor portal is not in the end-to-end stack, so this tier draws it.
 * Each case writes its picture to `e2e-artifacts/cire-surfaces/vendor/` at the
 * repository root (gitignored): a phone's width and a desktop's, light and dark.
 */

vi.mock("@shared/rp-auth/solid", async () => {
  const { SESSION, surfacesFetch } = await import("../test-support/dashboard");
  return {
    AuthProvider: (props: { children: unknown }) => props.children,
    useAuth: () => ({
      session: () => SESSION,
      activeProfileId: () => SESSION.osnProfileId,
      authFetch: surfacesFetch,
      logout: async () => {},
    }),
  };
});
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  redirectToLogin: () => {},
}));

import SignInPanel from "../../src/components/SignInPanel";
import VendorApp from "../../src/components/VendorApp";
import { LOGIN_CARD_CLASS } from "../../src/lib/login-card";
import { setThemePreference } from "../../src/lib/theme";
import { ENQUIRY } from "../test-support/dashboard";

const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1440", width: 1440, height: 900 },
] as const;
const THEMES = ["light", "dark"] as const;

/** `path` resolves from this file's directory: four levels up is the repo root. */
const shot = (name: string) => `../../../../e2e-artifacts/cire-surfaces/vendor/${name}.png`;

const box = (el: Element) => {
  const style = getComputedStyle(el);
  return {
    corner: style.borderTopLeftRadius,
    padding: style.paddingTop,
    border: style.borderTopColor,
    fill: style.backgroundColor,
  };
};

/** A `--ui-*` colour as the engine paints it, read off a probe. */
function painted(token: string, property: "color" | "backgroundColor" = "color"): string {
  const probe = document.createElement("span");
  probe.style[property] = `var(${token})`;
  document.body.append(probe);
  const value = getComputedStyle(probe)[property];
  probe.remove();
  return value;
}

function useFonts() {
  const root = document.documentElement;
  root.style.setProperty("--font-ui", 'system-ui, -apple-system, "Segoe UI", sans-serif');
  root.style.setProperty("--font-flair", "Georgia, serif");
}

async function settle() {
  await document.fonts.ready;
  await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
}

async function pictureWholePage(name: string, width: number) {
  await page.viewport(width, document.documentElement.scrollHeight);
  await page.screenshot({ path: shot(name) });
}

afterEach(() => {
  cleanup();
  setThemePreference("system");
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  history.replaceState(null, "", "/");
});

describe("the vendor portal's cards", () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      it(`draws the inbox row and the quote form from the card, ${viewport.name}px ${theme}`, async () => {
        await page.viewport(viewport.width, viewport.height);
        setThemePreference(theme);
        useFonts();
        history.replaceState(null, "", "/#/enquiries");
        render(() => (
          <div class="@container/frame">
            <VendorApp />
          </div>
        ));

        const row = await screen.findByRole(
          "button",
          { name: new RegExp(ENQUIRY.weddingName) },
          { timeout: 5_000 },
        );
        await settle();
        // The inbox row: the card's small padding step and its corner, and
        // the whole row is the control.
        expect(box(row)).toMatchObject({ corner: "16px", padding: "16px" });
        await pictureWholePage(`inbox-${viewport.name}-${theme}`, viewport.width);

        await page.viewport(viewport.width, viewport.height);
        // The whole row is the control: a hover turns its border gold.
        await userEvent.hover(row);
        await settle();
        expect(getComputedStyle(row).borderTopColor).toBe(painted("--ui-accent-soft"));
        await userEvent.unhover(row);
        row.click();
        const quote = await screen.findByText("Send a quote", {}, { timeout: 5_000 });
        await settle();
        const form = quote.parentElement!;
        // A box inside the thread's card: the 6px step, the hairline, no fill.
        expect(box(form)).toEqual({
          corner: "6px",
          padding: "16px",
          border: painted("--ui-hairline"),
          fill: "rgba(0, 0, 0, 0)",
        });
        // The label is the eyebrow: readable gold, the widest tracking.
        const label = getComputedStyle(quote);
        expect(label.color).toBe(painted("--ui-accent-ink"));
        expect(Number.parseFloat(label.letterSpacing)).toBeCloseTo(
          Number.parseFloat(label.fontSize) * 0.16,
          2,
        );
        await pictureWholePage(`thread-${viewport.name}-${theme}`, viewport.width);
      });

      it(`draws the sign-in card at the largest step, ${viewport.name}px ${theme}`, async () => {
        await page.viewport(viewport.width, viewport.height);
        setThemePreference(theme);
        useFonts();
        // `login.astro`'s page, as it composes it: the same card class round
        // the same panel, under the same header.
        render(() => (
          <div class="@container/frame">
            <main class="page-frame flex min-h-dvh flex-col justify-center py-16 [--page-max:26rem]">
              <header class="mb-8 flex flex-col gap-1.5 text-center">
                <p class={eyebrowClass()}>Vendor Portal</p>
                <h1 class="font-display text-text leading-ui-none text-[clamp(1.9rem,5cqi,2.6rem)] font-light">
                  Sign in
                </h1>
              </header>
              <div data-testid="login-card" class={LOGIN_CARD_CLASS}>
                <SignInPanel />
              </div>
            </main>
          </div>
        ));
        await settle();
        const card = screen.getByTestId("login-card");
        expect(box(card)).toMatchObject({ corner: "16px", padding: "32px" });
        // The lip lights the card's top edge.
        expect(getComputedStyle(card).boxShadow).toContain("inset");
        await page.screenshot({ path: shot(`login-${viewport.name}-${theme}`) });
      });
    }
  }
});
