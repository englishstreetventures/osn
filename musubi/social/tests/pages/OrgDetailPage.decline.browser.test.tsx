import { OrgClientError } from "@osn/client";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/App.css";

/**
 * The organisation page's decline block, from the "you now own" email's link,
 * in the shell and a real Chromium. Holds that Decline is 40px tall below
 * `md` and `sm`'s 32px from it, that nothing scrolls sideways on a 320px
 * phone, and writes the block's screenshots, offered and refused, light and
 * dark, at 390px and 1280px, to `__screenshots__/`.
 */

const mocks = vi.hoisted(() => ({ declineOwnership: vi.fn() }));
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
          name: "Acme Climbing Club",
          description: "Weekend climbs around the city.",
          avatarUrl: null,
          createdAt: "2026-01-01T00:00:00Z",
          updatedAt: "2026-01-01T00:00:00Z",
        },
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

beforeEach(() => {
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
});
