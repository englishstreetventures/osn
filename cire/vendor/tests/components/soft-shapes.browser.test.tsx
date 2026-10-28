import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The signed-in dashboard's corners, read from a real engine: an action button
 * is a pill, a text field is the 14px `field` corner and never a pill, the
 * editor is a 16px card, a status chip is a pill and a checkbox is the 6px
 * small step.
 *
 * All five come from the vendor stylesheet's role map (`--ui-radius-control`,
 * `--ui-radius-field`, `--ui-radius-lg`, `--ui-radius-pill`, `--ui-radius-sm`),
 * which no unit test resolves: happy-dom computes no `var()`, so only a browser
 * can say that `rounded-ui-field` on an input paints 14px rather than falling
 * back to the control's pill.
 *
 * Each case writes the whole page, the listing editor open, to
 * `e2e-artifacts/cire-soft-shapes/vendor/` at the repository root (gitignored):
 * a phone's width and a desktop's, light and dark.
 */

vi.mock("@shared/rp-auth/solid", async () => {
  const { SESSION, dashboardFetch } = await import("../test-support/dashboard");
  return {
    AuthProvider: (props: { children: unknown }) => props.children,
    useAuth: () => ({
      session: () => SESSION,
      activeProfileId: () => SESSION.osnProfileId,
      authFetch: dashboardFetch,
      logout: async () => {},
    }),
  };
});
// Signed in throughout, so this never fires; mocked so a slip cannot navigate
// the test frame away.
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  redirectToLogin: () => {},
}));

import VendorApp from "../../src/components/VendorApp";
import { setThemePreference } from "../../src/lib/theme";
import { LISTING, ORGS } from "../test-support/dashboard";

const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1440", width: 1440, height: 900 },
] as const;
const THEMES = ["light", "dark"] as const;

/** `path` resolves from this file's directory: four levels up is the repo root. */
const shot = (name: string) => `../../../../e2e-artifacts/cire-soft-shapes/vendor/${name}.png`;

const corner = (el: Element) => getComputedStyle(el).borderTopLeftRadius;

/**
 * A pill: the corner reaches half the box's height, so the ends are round, and
 * it is over 16px. The second check tells a pill from a step on a short box:
 * the 16px card step reaches half of the 31px back button, and the 14px field
 * step half of the 20px status chip.
 */
function expectPill(el: Element) {
  const radius = Number.parseFloat(corner(el));
  expect(radius).toBeGreaterThanOrEqual(el.getBoundingClientRect().height / 2);
  expect(radius).toBeGreaterThan(16);
}

/**
 * The page the portal ships: `index.astro` wraps the island in the
 * `@container/frame` box every gutter and breakpoint measures. The fonts are
 * Astro's self-hosted faces, which only a build emits, so the two variables
 * they set name the fallbacks `astro.config.mjs` lists instead.
 */
async function renderDashboard() {
  const root = document.documentElement;
  root.style.setProperty("--font-ui", 'system-ui, -apple-system, "Segoe UI", sans-serif');
  root.style.setProperty("--font-flair", "Georgia, serif");

  render(() => (
    <div class="@container/frame">
      <VendorApp />
    </div>
  ));

  // The dashboard opens on the organisation picker; the listing is one pick in.
  const org = await screen.findByRole("button", { name: new RegExp(ORGS[0]!.name) });
  org.click();
  const save = await screen.findByRole("button", { name: "Save listing" }, { timeout: 5_000 });
  await document.fonts.ready;
  // The panel grows to the editor and fades it up; read it once it has landed.
  // A motion the next one replaces rejects `finished` as cancelled, and has
  // landed as far as this reads.
  await Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {})));
  return save.closest("form")!;
}

afterEach(() => {
  cleanup();
  setThemePreference("system");
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  history.replaceState(null, "", "/");
});

describe("the vendor dashboard's corners", () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      it(`draws buttons and chips as pills, fields at 14px, ${viewport.name}px ${theme}`, async () => {
        await page.viewport(viewport.width, viewport.height);
        setThemePreference(theme);
        const form = await renderDashboard();
        expect(document.documentElement.dataset.theme).toBe(theme);

        // An action is a pill.
        expectPill(within(form).getByRole("button", { name: "Save listing" }));
        expectPill(screen.getByRole("button", { name: "← All organisations" }));

        // A text field takes the field corner, and at its height that leaves a
        // straight side: not a pill.
        const name = within(form).getByDisplayValue(LISTING.name);
        expect(corner(name)).toBe("14px");
        expect(14).toBeLessThan(name.getBoundingClientRect().height / 2);
        expect(corner(within(form).getByDisplayValue(LISTING.description!))).toBe("14px");

        // The editor is a card on the page.
        expect(corner(form.parentElement!)).toBe("16px");

        // A status chip is a pill; a checkbox is the small step.
        expectPill(screen.getByText(LISTING.listed));
        // The box drawn is the control after Kobalte's hidden input.
        const venue = within(form).getByRole("checkbox", { name: "Venue" });
        expect(corner(venue.nextElementSibling!)).toBe("6px");

        // The whole page in one picture: as tall as the document, at the
        // viewport's width, which is what decides the layout.
        await page.viewport(viewport.width, document.documentElement.scrollHeight);
        await page.screenshot({ path: shot(`dashboard-${viewport.name}-${theme}`) });
      });
    }
  }
});
