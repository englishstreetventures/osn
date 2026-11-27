import { StepUpError } from "@osn/client";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/App.css";

/**
 * An app's step-up request as people see it: `/confirm/:requestId` inside the
 * real shell, rail on desktop and top bar and tab bar on a phone, Musubi's own
 * stylesheet, in a real Chromium. The request client, the step-up sheet, the
 * way back to the app and the session are stand-ins.
 *
 * Holds what the fast tier cannot see:
 *
 * - nothing scrolls sideways on a 390px phone, the return host included;
 * - Confirm is 40px tall below `md` and `sm`'s 32px from it (DESIGN.md
 *   §Responsive layout);
 * - the placeholder stands at the ready card's height, so nothing moves when
 *   the card lands (DESIGN.md §Empty states and failed loads).
 *
 * Each case writes screenshots to `__screenshots__/` beside this file
 * (gitignored): every state in light and dark, at 390px and 1280px.
 */

const mocks = vi.hoisted(() => ({
  signedIn: true,
  read: vi.fn(),
  confirm: vi.fn(),
  returnTo: vi.fn(),
}));

vi.mock("@osn/client/solid", async () => {
  const actual = await vi.importActual<typeof import("@osn/client/solid")>("@osn/client/solid");
  const resource = <T,>(value: () => T) =>
    Object.assign(value, {
      state: "ready",
      loading: false,
      error: undefined,
      get latest() {
        return value();
      },
      refetch: () => {},
      mutate: () => {},
    });
  const token = `h.${btoa(JSON.stringify({ sub: "usr_alice", handle: "alice" }))}.s`;
  const context = {
    session: resource(() =>
      mocks.signedIn ? { accessToken: token, expiresAt: Date.now() + 300_000 } : null,
    ),
    profiles: resource(() =>
      mocks.signedIn
        ? [{ id: "usr_alice", handle: "alice", displayName: "Alice", avatarUrl: null }]
        : null,
    ),
    profilesError: () => undefined,
    refetchProfiles: () => Promise.resolve(),
    activeProfileId: () => (mocks.signedIn ? "usr_alice" : null),
    pendingDeletion: () => false,
    renewSession: () => Promise.resolve(),
    logout: () => Promise.resolve(),
    adoptSession: () => Promise.resolve(),
    switchProfile: () => new Promise(() => {}),
    createProfile: () => Promise.reject(new Error("not in this test")),
    deleteProfile: () => Promise.resolve(),
  };
  return {
    ...actual,
    AuthProvider: (props: { children?: unknown }) => (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext
      <actual.AuthContext.Provider value={context as any}>
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
  totpClient: {},
  accountClient: {},
}));
vi.mock("../../src/lib/app-step-up-client", () => ({
  appStepUpClient: { read: mocks.read, confirm: mocks.confirm },
}));
vi.mock("../../src/components/StepUpSheet", () => ({
  default: (props: { onToken: (token: { token: string }) => void }) => {
    queueMicrotask(() => props.onToken({ token: "tok" }));
    return null;
  },
}));
vi.mock("../../src/lib/return-to", () => ({ returnTo: mocks.returnTo }));

import { Layout } from "../../src/App";
import { ConfirmRequestPage } from "../../src/pages/ConfirmRequestPage";
import { railChunks, topBarChunks } from "../test-support/shell-chunks";

const SHOTS = "__screenshots__/ConfirmRequestPage.browser.test.tsx";
const PHONE = { width: 390, height: 900 };
const DESKTOP = { width: 1280, height: 900 };
type Viewport = typeof PHONE;

const REQUEST = { purpose: "cire_app_delete", returnHost: "host.cireweddings.com" } as const;
const never = () => new Promise<never>(() => {});

async function atViewport({ width, height }: Viewport) {
  const resized =
    innerWidth === width && innerHeight === height
      ? Promise.resolve()
      : new Promise<void>((resolve) =>
          window.addEventListener("resize", () => resolve(), { once: true }),
        );
  await page.viewport(width, height);
  await resized;
}

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function painted() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await nextFrame();
  await nextFrame();
  await document.fonts.ready;
}

async function open(viewport: Viewport) {
  await atViewport(viewport);
  const history = createMemoryHistory();
  history.set({ value: "/confirm/req_1" });
  render(() => (
    <MemoryRouter history={history} root={Layout}>
      <Route path="/confirm/:requestId" component={ConfirmRequestPage} />
    </MemoryRouter>
  ));
  await (viewport.width < 768 ? topBarChunks() : railChunks());
  expect(await screen.findByRole("heading", { name: "Confirm a request" })).toBeTruthy();
}

function expectNoSideScroll(viewport: Viewport) {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(viewport.width);
  const main = document.querySelector("main")!;
  expect(main.scrollWidth - main.clientWidth).toBeLessThanOrEqual(1);
}

async function shot(name: string, viewport: Viewport, theme: "light" | "dark") {
  await painted();
  expectNoSideScroll(viewport);
  await page.screenshot({ path: `${SHOTS}/${name}-${viewport.width}-${theme}.png` });
}

const height = (el: Element) => el.getBoundingClientRect().height;
const confirmButton = () =>
  screen.getByRole("button", { name: /Confirm it's you|Confirming…|Taking you back…/ });

beforeEach(() => {
  mocks.signedIn = true;
  mocks.read.mockReset().mockResolvedValue(REQUEST);
  mocks.confirm.mockReset().mockImplementation(never);
  mocks.returnTo.mockReset().mockReturnValue(true);
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

describe("an app's step-up request, in the shell", () => {
  for (const viewport of [PHONE, DESKTOP]) {
    it(`holds the ready card's height while it loads at ${viewport.width}px`, async () => {
      let answer: (value: typeof REQUEST) => void = () => {};
      mocks.read.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
      await open(viewport);
      await painted();
      const busy = document.querySelector<HTMLElement>('main [aria-busy="true"]')!;
      const held = height(busy);
      answer(REQUEST);
      const heading = await screen.findByRole("heading", { name: "Remove your Cire data" });
      await painted();
      expect(Math.abs(height(heading.closest("[data-request-card]")!) - held)).toBeLessThanOrEqual(
        2,
      );
      expect(height(confirmButton())).toBe(viewport.width < 768 ? 40 : 32);
    });

    for (const theme of ["light", "dark"] as const) {
      const at = `${viewport.width}px, ${theme}`;
      const dark = () => {
        if (theme === "dark") document.documentElement.classList.add("dark");
      };

      it(`signed out — ${at}`, async () => {
        dark();
        mocks.signedIn = false;
        await open(viewport);
        expect(await screen.findByText("Sign in to confirm this request.")).toBeTruthy();
        expect(mocks.read).not.toHaveBeenCalled();
        await shot("1-signed-out", viewport, theme);
      });

      it(`loading — ${at}`, async () => {
        dark();
        mocks.read.mockImplementation(never);
        await open(viewport);
        expect(document.querySelector('main [aria-busy="true"]')).not.toBeNull();
        await shot("2-loading", viewport, theme);
      });

      it(`what the app asks, and where it sends you back — ${at}`, async () => {
        dark();
        await open(viewport);
        expect(await screen.findByText("host.cireweddings.com")).toBeTruthy();
        await shot("3-ready", viewport, theme);
      });

      it(`confirming — ${at}`, async () => {
        dark();
        await open(viewport);
        expect(await screen.findByText("host.cireweddings.com")).toBeTruthy();
        fireEvent.click(confirmButton());
        expect(await screen.findByRole("button", { name: "Confirming…" })).toBeTruthy();
        await shot("4-confirming", viewport, theme);
      });

      it(`taking you back — ${at}`, async () => {
        dark();
        mocks.confirm.mockResolvedValue({
          status: "confirmed",
          returnTo: "https://host.cireweddings.com/#/remove-data?code=abc",
        });
        await open(viewport);
        expect(await screen.findByText("host.cireweddings.com")).toBeTruthy();
        fireEvent.click(confirmButton());
        expect(await screen.findByRole("button", { name: "Taking you back…" })).toBeTruthy();
        expect(mocks.returnTo).toHaveBeenCalledWith(
          "https://host.cireweddings.com/#/remove-data?code=abc",
        );
        await shot("5-taking-you-back", viewport, theme);
      });

      it(`the step-up refused — ${at}`, async () => {
        dark();
        mocks.confirm.mockRejectedValue(new StepUpError("Request failed: 403", 403));
        await open(viewport);
        expect(await screen.findByText("host.cireweddings.com")).toBeTruthy();
        fireEvent.click(confirmButton());
        expect(
          await screen.findByText("Musubi couldn't use that confirmation. Confirm it's you again."),
        ).toBeTruthy();
        await shot("6-refused", viewport, theme);
      });

      it(`a passkey still inside its hold — ${at}`, async () => {
        // The longest line the card draws: a day and a clock time, which must
        // wrap inside the card on a phone.
        dark();
        mocks.confirm.mockResolvedValue({ status: "held", holdEndsAt: 1_900_000_000 });
        await open(viewport);
        expect(await screen.findByText("host.cireweddings.com")).toBeTruthy();
        fireEvent.click(confirmButton());
        expect(await screen.findByText(/That passkey is less than 3 days old\./)).toBeTruthy();
        await shot("6b-held", viewport, theme);
      });

      it(`the request gone, or another account's — ${at}`, async () => {
        dark();
        mocks.read.mockResolvedValue(null);
        await open(viewport);
        expect(await screen.findByRole("heading", { name: "This request has ended" })).toBeTruthy();
        await shot("7-gone", viewport, theme);
      });

      it(`gone at the confirm — ${at}`, async () => {
        dark();
        mocks.confirm.mockResolvedValue({ status: "gone" });
        await open(viewport);
        expect(await screen.findByText("host.cireweddings.com")).toBeTruthy();
        fireEvent.click(confirmButton());
        expect(await screen.findByRole("heading", { name: "This request has ended" })).toBeTruthy();
        await shot("8-gone-at-confirm", viewport, theme);
      });

      it(`no connection — ${at}`, async () => {
        dark();
        mocks.read.mockRejectedValue(new StepUpError("No answer", 0));
        await open(viewport);
        expect(await screen.findByText(/This request didn't load\./)).toBeTruthy();
        await shot("9-network-failure", viewport, theme);
      });
    }
  }
});
