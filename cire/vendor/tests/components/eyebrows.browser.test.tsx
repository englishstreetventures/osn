import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * No small-caps line repeats the heading under it (host `DESIGN.md` §3, "A
 * line earns its place"): the top bar's tabs already say "Listings" and
 * "Enquiries", so the listing editor's heading (the organisation's name) and
 * the inbox's stand alone.
 *
 * The vendor portal is not in the end-to-end stack, so this tier draws it.
 * Each view is pictured at a phone's width and a desktop's, light and dark, in
 * `e2e-artifacts/cire-eyebrows/vendor/` at the repository root (gitignored).
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
// Signed in throughout, so this never fires; mocked so a slip cannot navigate
// the test frame away.
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  redirectToLogin: () => {},
  signOutToLogin: async () => {},
}));

import Eyebrow from "@cire/ui/eyebrow";

import VendorApp from "../../src/components/VendorApp";
import { setThemePreference } from "../../src/lib/preferences";
import { ENQUIRY, ORGS } from "../test-support/dashboard";
import { useFallbackFonts } from "../test-support/fonts";

/** The text of the small-caps line straight above `heading`, or "" when there is none. */
function eyebrowOver(heading: HTMLElement): string {
  const above = heading.previousElementSibling;
  if (!above) return "";
  const style = getComputedStyle(above);
  // `normal` parses to NaN, which is not small caps.
  const ratio = Number.parseFloat(style.letterSpacing) / Number.parseFloat(style.fontSize);
  return style.textTransform === "uppercase" && ratio >= 0.09
    ? (above.textContent ?? "").trim()
    : "";
}

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 1280, height: 800 },
] as const;
const THEMES = ["light", "dark"] as const;

/** `path` resolves from this file's directory: four levels up is the repository root. */
const shot = (name: string) => `../../../../e2e-artifacts/cire-eyebrows/vendor/${name}.png`;

/** Waits out every finite animation, so a picture is of a page at rest. */
async function settle() {
  await document.fonts.ready;
  await Promise.all(
    document
      .getAnimations()
      .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
      .map((a) => a.finished.catch(() => {})),
  );
}

/** Pictures the page as it stands at each width, in each theme. */
async function pictureEach(name: string) {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      await page.viewport(viewport.width, viewport.height);
      setThemePreference(theme);
      await settle();
      await page.screenshot({ path: shot(`${name}-${viewport.width}-${theme}`) });
    }
  }
}

function renderPortal(hash: string) {
  useFallbackFonts();
  history.replaceState(null, "", `/${hash}`);
  render(() => (
    <div class="@container/frame">
      <VendorApp />
    </div>
  ));
}

afterEach(() => {
  cleanup();
  setThemePreference("system");
  localStorage.clear();
  document.documentElement.removeAttribute("style");
  history.replaceState(null, "", "/");
});

describe("a vendor view's heading stands without an eyebrow", () => {
  it("is read by a reader that sees a kept one", () => {
    render(() => (
      <div>
        <Eyebrow>Kept</Eyebrow>
        <h2>Heading</h2>
      </div>
    ));
    expect(eyebrowOver(screen.getByRole("heading", { name: "Heading" }))).toBe("Kept");
  });

  it("in the enquiries inbox", async () => {
    renderPortal("#/enquiries");
    await screen.findByRole(
      "button",
      { name: new RegExp(ENQUIRY.weddingName) },
      { timeout: 5_000 },
    );
    expect(eyebrowOver(screen.getByRole("heading", { name: "Your inbox" }))).toBe("");
    await pictureEach("inbox");
  });

  it("in the listing editor", async () => {
    renderPortal("");
    // The dashboard opens on the organisation picker; the listing is one pick in.
    (await screen.findByRole("button", { name: new RegExp(ORGS[0]!.name) })).click();
    await screen.findByRole("button", { name: "Save listing" }, { timeout: 5_000 });
    expect(eyebrowOver(screen.getByRole("heading", { name: ORGS[0]!.name }))).toBe("");
    await pictureEach("listing");
  });
});
