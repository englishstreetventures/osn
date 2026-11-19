import { AuthorizeError, type AuthorizeClientInfo } from "@osn/client";
import { resetToasts } from "@shared/toast";
import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/App.css";
// `?no-inline`: Vite would inline a file this small as a `data:` address,
// which the client card refuses; a logo is drawn only from an http(s) one.
import appLogo from "../test-support/app-logo.svg?no-inline";

/**
 * The deletion screen on Musubi's `/authorize`, for an app's sign-in by an
 * account whose deletion is pending: the app's `Layout` at `/authorize`, the
 * real page, the real island and the real window, Musubi's stylesheet, a real
 * Chromium. Only the clients, the session and the step-up sheet are stand-ins.
 *
 * Holds the look `DESIGN.md` §Layout gives it: the app's name the page's one
 * `h1` and the card's heading an `h2`; the line naming the app last above the
 * buttons; the four buttons in their order, each as wide as the card, on one
 * line, 44px tall below `md` and 40px from it, and an app's long name cut
 * short in its button while the line breaks it; nothing scrolls sideways at
 * 320px. And that nothing moves as it loads: the placeholder the page draws
 * while the screen's code loads is the screen's own shape, so neither the
 * app's card above it nor the card itself moves when the screen lands, nor
 * again when the date does.
 *
 * Screenshots of each state go to `__screenshots__/` beside this file
 * (gitignored), named `<state>-<width>-<theme>.png`, in light and dark at
 * 390px and 1280px.
 */

const mocks = vi.hoisted(() => {
  let open = () => {};
  const gate = new Promise<void>((resolve) => (open = resolve));
  return {
    getContext: vi.fn(),
    decline: vi.fn(),
    submitDecision: vi.fn(),
    status: vi.fn(),
    cancel: vi.fn(),
    renewSession: vi.fn(),
    /** Holds the screen's chunk until `open()`, so the page draws its placeholder. */
    chunk: { gate, open: () => open() },
  };
});

vi.mock("../../src/lib/authorize", () => ({
  authorizeClient: {
    getContext: mocks.getContext,
    decline: mocks.decline,
    submitDecision: mocks.submitDecision,
  },
}));
vi.mock("../../src/components/AuthorizeDeletionWindow", async (importOriginal) => {
  await mocks.chunk.gate;
  return importOriginal();
});
// The island's provider bootstraps a session over the network; this one hands
// the window a pending session at once.
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
  const pending = {
    session: resource({ accessToken: "not-a-jwt", expiresAt: Date.now() + 300_000 }),
    profiles: resource(null),
    profilesError: () => undefined,
    activeProfileId: () => "usr_alice",
    pendingDeletion: () => true,
    renewSession: () => mocks.renewSession(),
    logout: () => Promise.resolve(),
  };
  return {
    ...actual,
    AuthProvider: (props: { children?: unknown }) => (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext
      <actual.AuthContext.Provider value={pending as any}>
        {props.children as never}
      </actual.AuthContext.Provider>
    ),
  };
});
vi.mock("../../src/lib/authClients", () => ({
  stepUpClient: {},
  totpClient: {},
  accountClient: {
    getAccountDeletionStatus: mocks.status,
    cancelAccountDeletion: mocks.cancel,
    exportAccount: () => new Promise(() => {}),
  },
}));
vi.mock("../../src/components/StepUpSheet", () => ({
  default: (props: { onToken: (token: { token: string }) => void }) => {
    queueMicrotask(() => props.onToken({ token: "tok" }));
    return null;
  },
}));

import { Layout } from "../../src/App";
import { WINDOW_HEADING } from "../../src/components/DeletionWindowFrame";
import { AuthorizePage } from "../../src/pages/AuthorizePage";

const REQUEST_ID = "oar_0123456789ab";

/** 23 November 2026, 09:00 UTC. */
const SCHEDULED_FOR = 1_795_424_400;

/**
 * Wednesday 30 September 2026, 12:00 in the reader's zone: the year's longest
 * day in en-US, "Wednesday, September 30, 2026".
 */
const LONGEST = new Date(2026, 8, 30, 12, 0).getTime() / 1_000;

const LOGO = new URL(appLogo, location.origin).href;

const CIRE: AuthorizeClientInfo = {
  clientId: "cli_cire",
  name: "Cire",
  logoUrl: LOGO,
  firstParty: false,
  redirectDomain: "host.cireweddings.com",
};
const PULSE: AuthorizeClientInfo = {
  clientId: "cli_pulse",
  name: "Pulse",
  logoUrl: LOGO,
  firstParty: true,
  redirectDomain: "pulse.musubi.social",
};
/** A name with no space in it, longer than a button holds at any width. */
const LONG: AuthorizeClientInfo = {
  ...CIRE,
  name: "Weddingplanningstudioforeveryorganiserandeveryguesttheyinvite",
};

const alice = {
  id: "usr_alice",
  handle: "alice",
  email: "alice@example.com",
  displayName: "Alice",
  avatarUrl: null,
};

function context(client: AuthorizeClientInfo, pendingDeletion = true) {
  return {
    client,
    scopes: ["openid", "profile", "email"],
    signedIn: true,
    pendingDeletion,
    profiles: pendingDeletion ? [] : [alice],
    linkedProfileId: null,
  };
}

const SHOTS = "__screenshots__/AuthorizeDeletion.browser.test.tsx";

const NARROW = { width: 320, height: 640 };
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

type Viewport = typeof PHONE;
type Theme = "light" | "dark";

const BUTTONS = ["Keep my account", "Download my data", "Back to Cire", "Sign out"];

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

/** Laid out, painted, its fonts and images in, and every animation that ends ended. */
async function painted() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await nextFrame();
  await nextFrame();
  await document.fonts.ready;
  await Promise.all([...document.images].map((image) => image.decode().catch(() => undefined)));
  await Promise.all(
    document
      .getAnimations()
      .filter((animation) => animation.effect?.getComputedTiming().endTime !== Infinity)
      .map((animation) => animation.finished.catch(() => undefined)),
  );
}

function setTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

async function shot(state: string, viewport: Viewport, theme: Theme) {
  await painted();
  expect(document.documentElement.scrollWidth).toBe(viewport.width);
  await page.screenshot({ path: `${SHOTS}/${state}-${viewport.width}-${theme}.png` });
}

function openPage() {
  const history = createMemoryHistory();
  history.set({ value: `/authorize?request=${REQUEST_ID}` });
  render(() => (
    <MemoryRouter history={history} root={Layout}>
      <Route path="/authorize" component={AuthorizePage} />
    </MemoryRouter>
  ));
}

/** The page at `viewport`, once `ready` holds: by default, the date is in. */
async function openScreen(
  viewport: Viewport,
  ready: () => unknown = () => document.querySelector("time"),
) {
  await atViewport(viewport);
  openPage();
  await waitFor(() => expect(ready()).toBeTruthy(), { timeout: 5_000 });
  await painted();
}

/** The window card's place under the app's card: the card, or its placeholder. */
function region(): HTMLElement {
  return screen.getByRole("heading", { level: 2 }).closest("main > *") as HTMLElement;
}

/** The card inside `region()`, and the width its contents get. */
function card() {
  const box = region().firstElementChild as HTMLElement;
  const style = getComputedStyle(box);
  const side = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.borderLeftWidth);
  const rect = box.getBoundingClientRect();
  return { box, inner: rect.width - 2 * side, left: rect.left + side, right: rect.right - side };
}

/** Where the app's name sits and how tall the window's card is: what must not move. */
function measure() {
  return {
    name: screen.getByRole("heading", { level: 1 }).getBoundingClientRect().top,
    height: region().getBoundingClientRect().height,
  };
}

/**
 * The line naming the app, inside `element`. Its name is a span of its own
 * (`translate="no"`), so the line is found by its whole text.
 */
function appLine(element: Element): HTMLElement {
  const lines = [...element.querySelectorAll<HTMLElement>("p")].filter((p) =>
    p.textContent?.startsWith("You're not signed in to "),
  );
  expect(lines).toHaveLength(1);
  return lines[0]!;
}

/** The blocks a reader sees inside `element`: a block hidden at this width takes no box. */
function shownBlocks(element: Element): HTMLElement[] {
  return [...element.querySelectorAll<HTMLElement>('[aria-hidden="true"]')].filter(
    (block) => block.getClientRects().length > 0,
  );
}

function scheduled(at = SCHEDULED_FOR) {
  return { scheduled: true, scheduledFor: at, softDeletedAt: at - 7 * 86_400 };
}

beforeEach(() => {
  mocks.getContext.mockReset().mockResolvedValue(context(CIRE));
  mocks.decline.mockReset().mockReturnValue(new Promise(() => {}));
  mocks.submitDecision.mockReset().mockReturnValue(new Promise(() => {}));
  mocks.status.mockReset().mockResolvedValue(scheduled());
  mocks.cancel.mockReset();
  mocks.renewSession.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  resetToasts();
  setTheme("light");
});

// First in the file: the screen's chunk is held only until its first import.
describe("while the screen's code loads", () => {
  it("draws the screen's shape, and nothing moves as the screen and then its date land", async () => {
    let land!: (value: unknown) => void;
    mocks.status.mockReset().mockReturnValue(new Promise((resolve) => (land = resolve)));
    await openScreen(PHONE, () => document.querySelector("[aria-busy='true']"));

    // The placeholder: the heading as the screen draws it, the line naming the
    // app, and a block for the date and for each of the four buttons.
    expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([
      "Cire",
    ]);
    expect(appLine(region()).textContent).toMatch(/^You're not signed in to Cire\./);
    expect(within(region()).queryAllByRole("button")).toHaveLength(0);

    const held = new Map<number, ReturnType<typeof measure>>();
    for (const viewport of [NARROW, PHONE, DESKTOP]) {
      await atViewport(viewport);
      await painted();
      expect(shownBlocks(region())).toHaveLength(5);
      held.set(viewport.width, measure());
      if (viewport === NARROW) continue;
      for (const theme of ["light", "dark"] as const) {
        setTheme(theme);
        await shot("loading", viewport, theme);
      }
      setTheme("light");
    }

    mocks.chunk.open();
    await screen.findByRole("button", { name: "Keep my account" }, { timeout: 5_000 });
    for (const viewport of [NARROW, PHONE, DESKTOP]) {
      await atViewport(viewport);
      await painted();
      const now = measure();
      expect(now.name).toBeCloseTo(held.get(viewport.width)!.name, 0);
      expect(now.height).toBeCloseTo(held.get(viewport.width)!.height, 0);
    }

    land(scheduled(LONGEST));
    await waitFor(() => expect(document.querySelector("time")?.textContent).toContain("Wednesday"));
    for (const viewport of [NARROW, PHONE, DESKTOP]) {
      await atViewport(viewport);
      await painted();
      const now = measure();
      expect(now.name).toBeCloseTo(held.get(viewport.width)!.name, 0);
      expect(now.height).toBeCloseTo(held.get(viewport.width)!.height, 0);
    }
  }, 30_000);
});

describe("the deletion screen on /authorize", () => {
  // Run alone, this describe must not wait on the held chunk.
  beforeAll(() => mocks.chunk.open());

  for (const viewport of [NARROW, PHONE, DESKTOP]) {
    it(`stacks four one-line buttons the card's width at ${viewport.width}px, under the line naming the app`, async () => {
      await openScreen(viewport);
      expect(document.documentElement.scrollWidth).toBe(viewport.width);
      // The app's card as every screen on the page draws it, logo included.
      expect(document.querySelector<HTMLImageElement>("main img")?.naturalWidth).toBeGreaterThan(0);
      // One `h1`, the app's name; the card's heading under it.
      expect(screen.getAllByRole("heading", { level: 1 }).map((h) => h.textContent)).toEqual([
        "Cire",
      ]);
      expect(screen.getByRole("heading", { level: 2, name: WINDOW_HEADING })).toBeTruthy();

      const { box, inner } = card();
      const buttons = within(box).getAllByRole("button");
      expect(buttons.map((button) => button.textContent)).toEqual(BUTTONS);
      for (const button of buttons) {
        const rect = button.getBoundingClientRect();
        expect(rect.height).toBe(viewport.width < 768 ? 44 : 40);
        expect(rect.width).toBe(inner);
        // Whole on one line: the label is not cut short.
        const label = button.querySelector("span.truncate") ?? button;
        expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth);
      }

      // The line naming the app comes after the keep offer, just above the buttons.
      const offer = within(box).getByText(/^Before that day, you can keep it\./);
      const line = appLine(box);
      expect(line.textContent).toBe(
        "You're not signed in to Cire. Keep your account to carry on signing in.",
      );
      expect(line.getBoundingClientRect().top).toBeGreaterThanOrEqual(
        offer.getBoundingClientRect().bottom,
      );
      expect(buttons[0]!.getBoundingClientRect().top).toBeGreaterThan(
        line.getBoundingClientRect().bottom,
      );
    }, 30_000);

    it(`keeps an app's long name inside the card at ${viewport.width}px`, async () => {
      mocks.getContext.mockResolvedValue(context(LONG));
      await openScreen(viewport);
      expect(document.documentElement.scrollWidth).toBe(viewport.width);
      const { box, inner, left, right } = card();

      // The button cuts the name short, on one line; a screen reader hears it whole.
      const back = within(box).getByRole("button", { name: `Back to ${LONG.name}` });
      const rect = back.getBoundingClientRect();
      expect(rect.width).toBe(inner);
      expect(rect.height).toBe(viewport.width < 768 ? 44 : 40);
      const label = back.querySelector("span.truncate")!;
      expect(label.scrollWidth).toBeGreaterThan(label.clientWidth);
      expect(label.getBoundingClientRect().right).toBeLessThanOrEqual(rect.right);

      // The line breaks it, inside the card.
      const line = appLine(box);
      const lineRect = line.getBoundingClientRect();
      expect(lineRect.left).toBeGreaterThanOrEqual(left - 0.5);
      expect(lineRect.right).toBeLessThanOrEqual(right + 0.5);
      expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth);

      // A Back that fails says so naming the app, and breaks the name too.
      mocks.decline.mockRejectedValueOnce(
        new AuthorizeError("unknown", 0, "Could not reach the server."),
      );
      back.click();
      const failed = await within(box).findByRole("alert");
      expect(failed.textContent).toContain(`Couldn't go back to ${LONG.name}. `);
      const failedRect = failed.getBoundingClientRect();
      expect(failedRect.left).toBeGreaterThanOrEqual(left - 0.5);
      expect(failedRect.right).toBeLessThanOrEqual(right + 0.5);
      expect(failed.scrollWidth).toBeLessThanOrEqual(failed.clientWidth);
      expect(document.documentElement.scrollWidth).toBe(viewport.width);
    }, 30_000);
  }

  for (const viewport of [PHONE, DESKTOP]) {
    for (const theme of ["light", "dark"] as const) {
      it(`draws each state at ${viewport.width}px in ${theme}`, async () => {
        setTheme(theme);

        await openScreen(viewport);
        expect(screen.getByRole("button", { name: "Back to Cire" })).toBeTruthy();
        await shot("arrived", viewport, theme);
        cleanup();

        mocks.getContext.mockResolvedValue(context(PULSE));
        await openScreen(viewport);
        expect(screen.getByText("Verified by Musubi")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Back to Pulse" })).toBeTruthy();
        await shot("arrived-first-party", viewport, theme);
        cleanup();
        mocks.getContext.mockResolvedValue(context(CIRE));

        mocks.status.mockReset().mockRejectedValue(new Error("offline"));
        await openScreen(viewport, () => screen.queryByText(/didn't load/));
        expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
        await shot("date-failed", viewport, theme);
        cleanup();
        mocks.status.mockReset().mockResolvedValue(scheduled());

        await openScreen(viewport);
        screen.getByRole("button", { name: "Back to Cire" }).click();
        const leaving = await screen.findByRole("button", { name: "Taking you back…" });
        expect(leaving.getAttribute("aria-busy")).toBe("true");
        await waitFor(() => expect(leaving.querySelector("canvas")).not.toBeNull());
        await shot("leaving", viewport, theme);
        cleanup();

        mocks.decline
          .mockReset()
          .mockRejectedValue(
            new AuthorizeError("unknown", 0, "Could not reach the server. Check your connection."),
          );
        await openScreen(viewport);
        screen.getByRole("button", { name: "Back to Cire" }).click();
        await screen.findByText(
          (_, element) =>
            element?.getAttribute("role") === "alert" &&
            (element.textContent ?? "").includes("Couldn't go back to Cire. "),
        );
        expect(screen.getByRole("button", { name: "Back to Cire" })).toBeTruthy();
        await shot("back-failed", viewport, theme);
        cleanup();
        mocks.decline.mockReset().mockReturnValue(new Promise(() => {}));

        mocks.cancel.mockResolvedValue({ cancelled: false });
        await openScreen(viewport);
        screen.getByRole("button", { name: "Keep my account" }).click();
        await screen.findByRole("heading", {
          level: 2,
          name: "It's too late to keep this account",
        });
        expect(
          within(card().box)
            .getAllByRole("button")
            .map((button) => button.textContent),
        ).toEqual(["Back to Cire", "Sign out"]);
        await shot("too-late", viewport, theme);
        cleanup();
        resetToasts();

        mocks.cancel.mockResolvedValue({ cancelled: true });
        mocks.getContext
          .mockReset()
          .mockResolvedValueOnce(context(CIRE))
          .mockResolvedValueOnce(context(CIRE, false));
        await openScreen(viewport);
        screen.getByRole("button", { name: "Keep my account" }).click();
        await screen.findByRole("button", { name: "Allow" });
        await screen.findByText("Your account is back");
        await shot("kept-continuing", viewport, theme);
        cleanup();
        resetToasts();

        mocks.getContext
          .mockReset()
          .mockResolvedValueOnce(context(CIRE))
          .mockRejectedValueOnce(
            new AuthorizeError("invalid_request", 404, "Unknown or expired request"),
          );
        await openScreen(viewport);
        screen.getByRole("button", { name: "Keep my account" }).click();
        await screen.findByText("Your account is back, but this sign-in has expired.");
        expect(
          screen.getByText(
            (_: string, element: Element | null) =>
              element?.tagName === "P" &&
              element.textContent === "Go back to Cire and start again.",
          ),
        ).toBeTruthy();
        await shot("kept-expired", viewport, theme);
      }, 60_000);
    }
  }
});
