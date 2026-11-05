import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

import "../../src/styles/global.css";

/**
 * No small-caps line repeats the heading under it (host `DESIGN.md` §3, "An
 * eyebrow over a heading says what the screen does not"): the top bar's tabs already say "Listings" and
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

// The host's readers, shared so the two portals are held to one detector.
import { eyebrowOver } from "../../../host/tests/test-support/eyebrow-over";
import * as pictures from "../../../host/tests/test-support/picture-each";
import VendorApp from "../../src/components/VendorApp";
import { setThemePreference } from "../../src/lib/preferences";
import { ENQUIRY, ORGS } from "../test-support/dashboard";
import { useFallbackFonts } from "../test-support/fonts";

/** Pictures the page at each width and theme into `e2e-artifacts/cire-eyebrows/vendor/`. */
const pictureEach = (name: string) =>
  pictures.pictureEach(name, {
    // From this file's directory, four levels up is the repository root.
    dir: "../../../../e2e-artifacts/cire-eyebrows/vendor",
    setTheme: setThemePreference,
  });

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
