import { createMemoryHistory, MemoryRouter, Route } from "@solidjs/router";
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/App.css";

/**
 * The window screen as a pending session sees it: `Layout` with a session
 * whose deletion is pending, Musubi's stylesheet, a real Chromium. Only the
 * session and the account client are stand-ins.
 *
 * Holds that it is drawn as a bare route's card is (DESIGN.md §Layout,
 * §Empty states and failed loads): the product name above one card, centred
 * in the column; its buttons as wide as the card, 44px tall below `md` and
 * 40px from it; nothing of the shell (no rail, no top bar, no tab bar); and
 * nothing scrolls sideways on a 320px phone. And that nothing moves as it
 * loads: the frame `App.tsx` draws while the screen's chunk loads is as tall
 * as the screen while its date loads, and the date's block as tall as the
 * longest date of the year once it lands.
 *
 * Screenshots go to `__screenshots__/` beside this file (gitignored): the
 * screen, its frame, the frame after a failed chunk, the date that did not
 * load and the too-late state, in light and dark at 390px and 1280px.
 */

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  cancel: vi.fn(),
}));

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
    renewSession: () => new Promise(() => {}),
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
import { DeletionWindowFrame } from "../../src/components/DeletionWindowFrame";

/** 23 November 2026, 09:00 UTC. */
const SCHEDULED_FOR = 1_795_424_400;

/**
 * Wednesday 30 September 2026, 12:00 in the reader's zone: the year's longest
 * date in en-US, "Wednesday, September 30, 2026 at 12:00 PM".
 */
const LONGEST = new Date(2026, 8, 30, 12, 0).getTime() / 1_000;

const SHOTS = "__screenshots__/DeletionWindow.browser.test.tsx";

const NARROW = { width: 320, height: 640 };
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

type Viewport = typeof PHONE;

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

/** The app at `/`, for a pending session: the window screen, once its date is in. */
async function open(
  viewport: Viewport,
  wait: () => unknown = () => document.querySelector("time"),
) {
  await atViewport(viewport);
  const history = createMemoryHistory();
  history.set({ value: "/" });
  render(() => (
    <MemoryRouter history={history} root={Layout}>
      <Route path="/" component={() => <p>Connections page</p>} />
    </MemoryRouter>
  ));
  await waitFor(() => expect(wait()).toBeTruthy(), { timeout: 5_000 });
  await painted();
}

/** The frame alone, as `App.tsx` draws it while the screen's chunk loads or after it failed. */
async function openFrame(viewport: Viewport, failed: boolean) {
  await atViewport(viewport);
  render(() => <DeletionWindowFrame failed={failed} />);
  await painted();
}

/** The one block a reader sees inside `region`: a block hidden at this width takes no box. */
function shownBlock(region: Element): HTMLElement {
  const blocks = [...region.querySelectorAll<HTMLElement>('[aria-hidden="true"]')].filter(
    (block) => block.getClientRects().length > 0,
  );
  expect(blocks).toHaveLength(1);
  return blocks[0]!;
}

async function shot(name: string, viewport: Viewport, theme: "light" | "dark") {
  await painted();
  expect(document.documentElement.scrollWidth).toBe(viewport.width);
  await page.screenshot({ path: `${SHOTS}/${name}-${viewport.width}-${theme}.png` });
}

function card() {
  return screen.getByRole("heading", { level: 1 }).closest("main > *") as HTMLElement;
}

beforeEach(() => {
  mocks.status.mockReset().mockResolvedValue({
    scheduled: true,
    scheduledFor: SCHEDULED_FOR,
    softDeletedAt: SCHEDULED_FOR - 7 * 86_400,
  });
  mocks.cancel.mockReset();
});

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

describe("the window screen", () => {
  it("is a bare card with no shell, its buttons the card's width and touch height", async () => {
    for (const viewport of [NARROW, DESKTOP]) {
      await open(viewport);
      expect(screen.queryByText("Connections page")).toBeNull();
      expect(document.querySelector("aside, header, nav")).toBeNull();
      expect(document.documentElement.scrollWidth).toBe(viewport.width);

      const box = card();
      const inner =
        box.getBoundingClientRect().width -
        2 *
          (Number.parseFloat(getComputedStyle(box).paddingLeft) +
            Number.parseFloat(getComputedStyle(box).borderLeftWidth));
      for (const name of ["Keep my account", "Download my data", "Sign out"]) {
        const rect = screen.getByRole("button", { name }).getBoundingClientRect();
        expect(rect.height).toBe(viewport.width < 768 ? 44 : 40);
        expect(rect.width).toBe(inner);
      }
      cleanup();
    }
  }, 30_000);

  for (const viewport of [NARROW, PHONE, { width: 768, height: 800 }, DESKTOP]) {
    it(`holds its place as it loads at ${viewport.width}px`, async () => {
      await openFrame(viewport, false);
      const frame = card().getBoundingClientRect().height;
      cleanup();

      let land!: (value: unknown) => void;
      mocks.status.mockReset().mockReturnValue(new Promise((resolve) => (land = resolve)));
      await open(viewport, () => document.querySelector("[aria-busy='true']"));
      const loading = card().getBoundingClientRect().height;
      expect(loading).toBeCloseTo(frame, 0);
      const block = shownBlock(document.querySelector("[aria-busy='true']")!);
      const held = block.getBoundingClientRect().height;

      land({ scheduled: true, scheduledFor: LONGEST, softDeletedAt: LONGEST - 7 * 86_400 });
      const time = await waitFor(() => {
        const found = document.querySelector("time");
        if (!found) throw new Error("no date yet");
        return found;
      });
      await painted();
      expect(time.textContent).toContain("Wednesday");
      expect(time.closest("p")!.getBoundingClientRect().height).toBeCloseTo(held, 0);
      expect(card().getBoundingClientRect().height).toBeCloseTo(loading, 0);
    }, 30_000);
  }

  for (const viewport of [PHONE, DESKTOP]) {
    for (const theme of ["light", "dark"] as const) {
      it(`draws each state at ${viewport.width}px in ${theme}`, async () => {
        if (theme === "dark") document.documentElement.classList.add("dark");
        await open(viewport);
        expect(
          screen.getByRole("heading", { name: "Your account is set to be deleted" }),
        ).toBeTruthy();
        await shot("window", viewport, theme);
        cleanup();

        await openFrame(viewport, false);
        await shot("window-frame", viewport, theme);
        cleanup();
        await openFrame(viewport, true);
        await shot("window-frame-failed", viewport, theme);
        cleanup();

        mocks.status.mockReset().mockRejectedValue(new Error("offline"));
        await open(viewport, () => screen.queryByText(/didn't load/));
        await shot("window-date-failed", viewport, theme);
        cleanup();

        mocks.status.mockReset().mockResolvedValue({
          scheduled: true,
          scheduledFor: SCHEDULED_FOR,
          softDeletedAt: SCHEDULED_FOR - 7 * 86_400,
        });
        mocks.cancel.mockResolvedValue({ cancelled: false });
        await open(viewport);
        screen.getByRole("button", { name: "Keep my account" }).click();
        await screen.findByRole("heading", { name: "It's too late to keep this account" });
        await shot("window-too-late", viewport, theme);
      }, 30_000);
    }
  }
});
