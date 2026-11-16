import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/App.css";

/**
 * Settings → Account in the shell, in a real Chromium: "Your data" and the
 * danger zone. Holds that the data buttons and "Delete account…" are 40px
 * tall below `md` and `sm`'s 32px from it, that nothing scrolls sideways on
 * a 320px phone, where the data buttons wrap, and writes the tab's
 * screenshots, light and dark, at 390px and 1280px, to `__screenshots__/`.
 */

vi.mock("@osn/client/solid", async () => {
  const actual = await vi.importActual<typeof import("@osn/client/solid")>("@osn/client/solid");
  const resource = <T,>(value: T) =>
    Object.assign(() => value, {
      state: "ready",
      loading: false,
      error: undefined,
      latest: value,
      refetch: () => {},
      mutate: () => {},
    });
  const token = `h.${btoa(JSON.stringify({ sub: "usr_alice", handle: "alice", email: "alice@example.com" }))}.s`;
  const signedIn = {
    session: resource({ accessToken: token, expiresAt: Date.now() + 300_000 }),
    profiles: resource([
      { id: "usr_alice", handle: "alice", displayName: "Alice", avatarUrl: null },
    ]),
    profilesError: () => undefined,
    refetchProfiles: () => Promise.resolve(),
    activeProfileId: () => "usr_alice",
    pendingDeletion: () => false,
    logout: () => Promise.resolve(),
  };
  return {
    ...actual,
    AuthProvider: (props: { children?: unknown }) => (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext
      <actual.AuthContext.Provider value={signedIn as any}>
        {props.children as never}
      </actual.AuthContext.Provider>
    ),
  };
});
vi.mock("../../src/components/AccountBanners", () => ({ AccountBanners: () => null }));
vi.mock("@osn/auth-ui/ProfileOnboarding", () => ({ ProfileOnboarding: () => null }));
vi.mock("../../src/lib/authClients", () => ({
  loginClient: {},
  recoveryClient: {},
  registrationClient: { checkHandle: () => Promise.resolve(true) },
  passkeysClient: {},
  stepUpClient: {},
  totpClient: {},
  accountClient: {},
}));

import { Layout } from "../../src/App";
import { SettingsPage } from "../../src/pages/SettingsPage";
import { railChunks, topBarChunks } from "../test-support/shell-chunks";

const SHOTS = "__screenshots__/SettingsPage.account.browser.test.tsx";

async function atViewport(width: number, height: number) {
  const resized =
    innerWidth === width && innerHeight === height
      ? Promise.resolve()
      : new Promise<void>((resolve) =>
          window.addEventListener("resize", () => resolve(), { once: true }),
        );
  await page.viewport(width, height);
  await resized;
}

async function painted() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await document.fonts.ready;
}

async function open(width: number, height: number) {
  await atViewport(width, height);
  const history = createMemoryHistory();
  history.set({ value: "/settings#account" });
  render(() => (
    <MemoryRouter history={history} root={Layout}>
      <Route path="/settings" component={SettingsPage} />
    </MemoryRouter>
  ));
  await (width < 768 ? topBarChunks() : railChunks());
  await screen.findByRole("heading", { name: "Danger zone" });
  await painted();
}

const height = (element: Element) => element.getBoundingClientRect().height;

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

describe("Settings → Account", () => {
  it("draws the data buttons and Delete account… at the touch height below md, sm's from md", async () => {
    await open(320, 700);
    expect(document.documentElement.scrollWidth).toBe(320);
    const download = screen.getByRole("button", { name: "Download my data" });
    const link = screen.getByRole("button", { name: "Send me a link" });
    expect(height(download)).toBe(40);
    expect(height(link)).toBe(40);
    // They wrap onto two rows at 320px rather than squeeze.
    expect(download.getBoundingClientRect().right).toBeLessThanOrEqual(320);
    expect(link.getBoundingClientRect().right).toBeLessThanOrEqual(320);
    const remove = screen.getByRole("link", { name: "Delete account…" });
    expect(height(remove)).toBe(40);
    expect(remove.getAttribute("href")).toBe("/settings/delete-account");
    cleanup();

    await open(1280, 800);
    expect(height(screen.getByRole("button", { name: "Download my data" }))).toBe(32);
    expect(height(screen.getByRole("link", { name: "Delete account…" }))).toBe(32);
  }, 30_000);

  for (const [width, viewportHeight] of [
    [390, 900],
    [1280, 800],
  ] as const) {
    for (const theme of ["light", "dark"] as const) {
      it(`draws the tab at ${width}px in ${theme}`, async () => {
        if (theme === "dark") document.documentElement.classList.add("dark");
        await open(width, viewportHeight);
        expect(screen.getByRole("heading", { name: "Your data" })).toBeTruthy();
        await page.screenshot({ path: `${SHOTS}/account-${width}-${theme}.png` });
      }, 30_000);
    }
  }
});
