import { OrgClientError } from "@osn/client";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/App.css";

/**
 * The organisation page's decline block, from the "you now own" email's link,
 * in the shell and a real Chromium. Holds that Decline is 40px tall below
 * `md` and `sm`'s 32px from it, that nothing scrolls sideways on a 320px
 * phone, a name with no space to break at included, and writes screenshots
 * of the block offered and refused and of Delete's dialog, light and dark,
 * at 390px and 1280px, to `__screenshots__/`.
 */

const mocks = vi.hoisted(() => ({
  declineOwnership: vi.fn(),
  org: { name: "Acme Climbing Club" },
}));
// A fixed day, so every screenshot carries the same sentence.
const DECLINE_UNTIL = "2026-12-16T12:00:00.000Z";

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
  const token = `h.${btoa(JSON.stringify({ sub: "usr_bob", handle: "bobwhite" }))}.s`;
  const signedIn = {
    session: resource({ accessToken: token, expiresAt: Date.now() + 300_000 }),
    profiles: resource([
      { id: "usr_bob", handle: "bobwhite", displayName: "Bob White", avatarUrl: null },
    ]),
    profilesError: () => undefined,
    refetchProfiles: () => Promise.resolve(),
    activeProfileId: () => "usr_bob",
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
vi.mock("../../src/lib/authClients", () => ({
  loginClient: {},
  recoveryClient: {},
  registrationClient: {},
  passkeysClient: {},
  stepUpClient: {},
  connectionsClient: {},
  securityEventsClient: {},
  totpClient: {},
  emailLinkClient: {},
  accountClient: {},
}));
vi.mock("../../src/lib/api", () => ({
  graphClient: {},
  recommendationClient: {},
  orgClient: {
    getOrg: () =>
      Promise.resolve({
        organisation: {
          handle: "acmeclimbing",
          name: mocks.org.name,
          description: "Weekend climbs around the city.",
          avatarUrl: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
        // The owner, who sees Delete: the block is theirs to decline.
        caller: { role: "admin", owner: true },
      }),
    listMembers: () =>
      Promise.resolve({
        members: [
          {
            handle: "bobwhite",
            displayName: "Bob White",
            role: "admin",
            joinedAt: "2026-01-02T00:00:00Z",
          },
          { handle: "carol", displayName: null, role: "member", joinedAt: "2026-02-02T00:00:00Z" },
        ],
      }),
    declineOwnership: mocks.declineOwnership,
    declineOwnershipStatus: () => Promise.resolve({ declineUntil: DECLINE_UNTIL }),
  },
}));

import { Layout } from "../../src/App";
import { OrgDetailPage } from "../../src/pages/OrgDetailPage";
import { railChunks, topBarChunks } from "../test-support/shell-chunks";

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
  history.set({ value: "/organisations/acmeclimbing?decline=1" });
  render(() => (
    <MemoryRouter history={history} root={Layout}>
      <Route path="/organisations/:handle" component={OrgDetailPage} />
    </MemoryRouter>
  ));
  await (width < 768 ? topBarChunks() : railChunks());
  await screen.findByRole("heading", { name: "This organisation passed to you" });
  await screen.findByText("@carol");
  await painted();
}

const SHOTS = "__screenshots__/OrgDetailPage.decline.browser.test.tsx";

async function shot(name: string, width: number, theme: "light" | "dark") {
  await painted();
  expect(document.documentElement.scrollWidth).toBe(width);
  await page.screenshot({ path: `${SHOTS}/${name}-${width}-${theme}.png` });
}

beforeEach(() => {
  mocks.org.name = "Acme Climbing Club";
  mocks.declineOwnership
    .mockReset()
    .mockRejectedValue(new OrgClientError("refused", 409, "not_declinable"));
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

describe("the decline block", () => {
  it("draws Decline at the touch height below md and sm's from md, with nothing scrolling sideways", async () => {
    await open(320, 800);
    expect(document.documentElement.scrollWidth).toBe(320);
    expect(screen.getByRole("button", { name: "Decline" }).getBoundingClientRect().height).toBe(40);
    cleanup();
    await open(1280, 800);
    expect(screen.getByRole("button", { name: "Decline" }).getBoundingClientRect().height).toBe(32);
  }, 30_000);

  it("keeps a name with no space to break at inside a 320px column", async () => {
    mocks.org.name = "AcmeClimbingClubOfTheGreaterMetropolitan";
    await open(320, 800);
    expect(document.documentElement.scrollWidth).toBe(320);
    const main = document.querySelector("main")!;
    expect(main.scrollWidth).toBe(main.clientWidth);
    await page.screenshot({ path: `${SHOTS}/long-name-320.png` });
  }, 30_000);

  for (const width of [390, 1280]) {
    for (const theme of ["light", "dark"] as const) {
      it(`draws the block, its refusal and Delete's dialog at ${width}px in ${theme}`, async () => {
        if (theme === "dark") document.documentElement.classList.add("dark");
        await open(width, 900);
        await shot("decline", width, theme);
        fireEvent.click(screen.getByRole("button", { name: "Decline" }));
        await screen.findByText(/You can no longer decline this organisation here\./);
        expect(
          screen.queryByRole("heading", { name: "This organisation passed to you" }),
        ).toBeNull();
        await shot("decline-refused", width, theme);
        fireEvent.click(screen.getByRole("button", { name: "Delete" }));
        await screen.findByRole("dialog", { name: "Delete this organisation?" });
        // The sheet's slide and the card's fade run their course first.
        await new Promise((resolve) => setTimeout(resolve, 400));
        await shot("delete-dialog", width, theme);
      }, 30_000);
    }
  }
});
