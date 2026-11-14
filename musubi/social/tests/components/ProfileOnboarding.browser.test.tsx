import { AuthContext } from "@osn/client/solid";
import { Button } from "@shared/ui/ui/button";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../src/App.css";

/**
 * `@osn/auth-ui`'s "Create a new profile" dialog where musubi opens it: the
 * "Add another profile" card over Settings, for an account with one profile.
 * The dialog is `@shared/ui`'s `DialogContent` with `presentation="sheet"`: a
 * bottom sheet as wide as the screen below `md`, a centred 384px card from
 * it. Its Cancel, `CreateProfileForm`'s, is the dialog's dismiss button, so it
 * is painted `secondary` (`osn/auth-ui/DESIGN.md` §4). Placement and paint
 * take a real browser.
 *
 * Each case writes a shot under the gitignored `e2e-artifacts/musubi-settings/`.
 */

vi.mock("../../src/lib/authClients", () => ({
  registrationClient: { checkHandle: () => Promise.resolve({ available: true }) },
}));

import { SettingsPage } from "../../src/pages/SettingsPage";

/** Relative to this file: the repository's `e2e-artifacts/`. */
const SHOTS = "../../../../e2e-artifacts/musubi-settings";

/** `ProfileOnboarding`'s own key: set, the card stays away. */
const DISMISSED_KEY = "@osn/ui:profile_onboarding_dismissed";

/** An unsigned access token carrying the `sub` claim the page reads. */
const ACCESS_TOKEN = `header.${btoa(JSON.stringify({ sub: "prof_1" }))}.signature`;

/** Signed in, with the one profile that makes the card show. */
function authValue() {
  const session = { accessToken: ACCESS_TOKEN, idToken: null, expiresAt: 0, scopes: [] };
  const resource = <T,>(value: T) =>
    Object.assign(() => value, {
      state: "ready",
      loading: false,
      error: undefined,
      latest: value,
      refetch: () => {},
      mutate: () => {},
    });
  return {
    session: resource(session),
    profiles: resource([{ id: "prof_1", handle: "ada", displayName: "Ada" }]),
    activeProfileId: () => "prof_1",
    createProfile: () => new Promise(() => {}),
  };
}

/** Settings, then "Create profile": the dialog. */
async function openCreate(width: number, theme: string) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  await page.viewport(width, 900);
  const history = createMemoryHistory();
  history.set({ value: "/settings" });
  render(() => (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext
    <AuthContext.Provider value={authValue() as any}>
      <MemoryRouter history={history}>
        <Route path="/settings" component={SettingsPage} />
      </MemoryRouter>
    </AuthContext.Provider>
  ));
  await userEvent.click(
    await waitFor(() => screen.getByRole("button", { name: "Create profile" })),
  );
  return waitFor(() => screen.getByRole("dialog", { name: "Create a new profile" }));
}

/** A computed colour as sRGB bytes, whatever space the browser wrote it in. */
function rgb(color: string): number[] {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  return [...context.getImageData(0, 0, 1, 1).data];
}

/** The dialog's Cancel against a `secondary` Button drawn beside it. */
function expectSecondaryCancel(sheet: HTMLElement) {
  render(() => (
    <Button variant="secondary" data-testid="secondary-probe">
      Cancel
    </Button>
  ));
  const probe = getComputedStyle(screen.getByTestId("secondary-probe"));
  const cancel = getComputedStyle(within(sheet).getByRole("button", { name: "Cancel" }));
  expect([rgb(cancel.backgroundColor), rgb(cancel.color)]).toEqual([
    rgb(probe.backgroundColor),
    rgb(probe.color),
  ]);
}

/** Every animation on the page that ends: the sheet's entry fade and its scrim's. */
async function settle() {
  const ending = document
    .getAnimations()
    .filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime ?? 0));
  await Promise.all(ending.map((a) => a.finished.catch(() => {})));
}

beforeEach(() => {
  localStorage.removeItem(DISMISSED_KEY);
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

describe("the create-profile dialog over Settings", () => {
  it.each(["light", "dark"])(
    "is a bottom sheet at 390px, dismissed by a secondary Cancel (%s)",
    async (theme) => {
      const sheet = await openCreate(390, theme);
      await settle();
      const box = sheet.getBoundingClientRect();
      expect(box.left).toBeCloseTo(0, 1);
      expect(box.width).toBeCloseTo(390, 1);
      expect(box.bottom).toBeCloseTo(window.innerHeight, 0);
      expect(getComputedStyle(sheet).borderBottomLeftRadius).toBe("0px");
      expectSecondaryCancel(sheet);
      await page.screenshot({ path: `${SHOTS}/create-profile-390-${theme}.png` });
    },
  );

  it.each(["light", "dark"])(
    "is a centred 384px card at 1440px, dismissed by a secondary Cancel (%s)",
    async (theme) => {
      const sheet = await openCreate(1440, theme);
      await settle();
      const box = sheet.getBoundingClientRect();
      expect(box.width).toBeCloseTo(384, 1);
      expect(box.left).toBeCloseTo((1440 - 384) / 2, 0);
      expectSecondaryCancel(sheet);
      await page.screenshot({ path: `${SHOTS}/create-profile-1440-${theme}.png` });
    },
  );
});
