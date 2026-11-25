import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * Whose account money gifts are paid into, painted: the Money gifts panel an
 * owner sees when the account's holder is no owner of the wedding now, the
 * holder's own panel with the hand-over dialog open, and the holder's seat in
 * the hosts panel, at 390 and 1280px in both ramps. Only a real engine can say
 * the new sentences, the extra pills and a long name in the dialog stay inside
 * the panel and the screen, and only a real `<dialog>` hands focus back, so the
 * focus after a hand-over is here too.
 *
 * Every case leaves a screenshot under `__screenshots__/` beside this file
 * (gitignored).
 *
 * The factories below are written literally: the shared-factory idiom in
 * `test-support/mocks.ts` does not resolve in the browser project.
 */

const ME = "usr_me";
const { authFetch } = vi.hoisted(() => ({ authFetch: vi.fn() }));
vi.mock("@shared/rp-auth/solid", () => ({
  useAuth: () => ({ authFetch, activeProfileId: () => ME }),
}));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));

import HostsPanel from "../../src/components/HostsPanel";
import RegistrySettingsView from "../../src/components/RegistrySettingsView";
import { __resetHostsCache } from "../../src/lib/hosts-store";
import {
  __resetRegistryCache,
  type RegistrySettings,
  type RegistrySnapshot,
  setCachedRegistry,
} from "../../src/lib/registry-store";

const SHOTS = "__screenshots__/RegistrySettingsView.money.browser.test.tsx";
const VIEWPORTS = [
  { name: "390", width: 390, height: 1800 },
  { name: "1280", width: 1280, height: 1400 },
] as const;
const THEMES = ["light", "dark"] as const;

/** A host's own handle, with nowhere to break. */
const LONG = "maximiliana_featherstone_wolfeschlegelsteinhausenberger";
const SEATS = [
  { hostId: "h_me", osnProfileId: ME, handle: "me", role: "owner", createdAt: 0 },
  { hostId: "h_long", osnProfileId: "usr_long", handle: LONG, role: "owner", createdAt: 1 },
  { hostId: "h_kit", osnProfileId: "usr_kit", handle: "kit", role: "owner", createdAt: 2 },
];

const settingsOf = (over: Partial<RegistrySettings>): RegistrySettings => ({
  weddingId: "wed_1",
  published: false,
  headline: null,
  message: null,
  cashGiftsEnabled: true,
  shippingAddress: null,
  shippingVisibleFrom: null,
  stripeConnected: true,
  stripeConnectedByOsnProfileId: ME,
  stripeAccountType: "express",
  stripeChargesEnabled: true,
  moneyGiftsBlockedBy: null,
  payoutHolderAbsent: false,
  updatedAt: null,
  ...over,
});

const snapshotOf = (settings: RegistrySettings): RegistrySnapshot => ({
  settings,
  items: [],
  gifts: [],
  giftsHasMore: false,
  giftSummary: null,
  currency: "AUD",
  contributionsPrimaryMinor: 0,
  contributionsOtherCurrencyCount: 0,
  takesPayments: true,
  connectsExistingStripe: true,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function painted() {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await nextFrame();
  await nextFrame();
  await document.fonts.ready;
}

/** Nothing scrolls sideways, nothing inside `box` runs past it, and an open dialog sits on screen. */
function expectLaidOut(width: number, box: HTMLElement) {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const right = box.getBoundingClientRect().right;
  /** Each element's text and whether its right edge stays inside `edge`. */
  const inside = (els: Iterable<HTMLElement>, edge: number) =>
    [...els]
      .filter((el) => el.getBoundingClientRect().right > edge + 0.5)
      .map((el) => el.textContent ?? "");
  expect(
    inside(box.querySelectorAll<HTMLElement>("p, li, a, button, label, select"), right),
  ).toEqual([]);
  for (const dialog of document.querySelectorAll<HTMLDialogElement>("dialog[open]")) {
    const frame = dialog.getBoundingClientRect();
    expect(frame.left).toBeGreaterThanOrEqual(0);
    expect(frame.right).toBeLessThanOrEqual(width + 0.5);
    expect(inside(dialog.querySelectorAll<HTMLElement>("p, label, button"), frame.right)).toEqual(
      [],
    );
  }
}

async function shot(name: string, viewport: (typeof VIEWPORTS)[number], theme: string) {
  await painted();
  // A dialog rises in: shoot it once it has arrived, not part way.
  await Promise.all(document.getAnimations().map((animation) => animation.finished));
  const box = document.querySelector<HTMLElement>("[data-money-shot]");
  expect(box, "the panel").not.toBeNull();
  expectLaidOut(viewport.width, box!);
  await page.screenshot({ path: `${SHOTS}/${name}-${viewport.name}-${theme}.png` });
}

function showPanel() {
  render(() => (
    <div data-money-shot class="bg-bg text-text @container/panel" style={{ padding: "16px" }}>
      <RegistrySettingsView weddingId="wed_1" canEdit canManage />
    </div>
  ));
}

beforeEach(() => {
  __resetRegistryCache();
  __resetHostsCache();
  authFetch.mockReset();
});

afterEach(() => {
  // A `showModal()` dialog sits in the top layer and survives a render
  // cleanup; the next test would mount behind it with its page inert.
  for (const d of document.querySelectorAll("dialog[open]")) (d as HTMLDialogElement).close();
  cleanup();
  delete document.documentElement.dataset.theme;
});

describe("whose account money gifts are paid into, painted", () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      const at = `${viewport.name}px, ${theme}`;
      const open = async () => {
        await page.viewport(viewport.width, viewport.height);
        document.documentElement.dataset.theme = theme;
      };

      it(`an owner, the holder absent — ${at}`, async () => {
        await open();
        setCachedRegistry(
          "wed_1",
          snapshotOf(
            settingsOf({
              stripeConnectedByOsnProfileId: "usr_kit",
              payoutHolderAbsent: true,
              moneyGiftsBlockedBy: "payout_holder_absent",
              cashGiftsEnabled: false,
            }),
          ),
        );
        showPanel();
        expect(await screen.findByRole("button", { name: "Use your own account" })).toBeTruthy();
        await shot("01-holder-absent", viewport, theme);
      });

      it(`the holder, handing money gifts over — ${at}`, async () => {
        await open();
        setCachedRegistry("wed_1", snapshotOf(settingsOf({})));
        authFetch.mockImplementation(async () => json({ hosts: SEATS }));
        showPanel();
        fireEvent.click(
          await screen.findByRole("button", { name: "Hand money gifts to another owner" }),
        );
        expect(await screen.findByRole("radio", { name: `@${LONG}` })).toBeTruthy();
        await shot("02-hand-over-dialog", viewport, theme);
      });

      it(`the holder's seat, read by another owner — ${at}`, async () => {
        await open();
        authFetch.mockImplementation(async () =>
          json({
            hosts: [
              { ...SEATS[0], role: "owner" },
              { ...SEATS[1], payoutHolder: true },
            ],
            total: 2,
            peopleLimit: null,
          }),
        );
        render(() => (
          <div data-money-shot class="bg-bg text-text @container/panel" style={{ padding: "16px" }}>
            <HostsPanel weddingId="wed_1" callerRole="owner" />
          </div>
        ));
        const note = await screen.findByTestId("payout-holder-note");
        const row = note.closest("li")!;
        const box = row.getBoundingClientRect();
        const outside = [...row.querySelectorAll<HTMLElement>("select, button, p, a, span")].filter(
          (part) => {
            const r = part.getBoundingClientRect();
            return r.left < box.left - 0.5 || r.right > box.right + 0.5;
          },
        );
        expect(outside.map((part) => part.textContent ?? "")).toEqual([]);
        // The role select offers owner alone, and names the note.
        const select = screen.getByRole("combobox", { name: `Role for @${LONG}` });
        expect(select.getAttribute("aria-describedby")).toBe(note.id);
        await shot("03-holder-seat", viewport, theme);
      });
    }
  }

  it("puts focus on Connect an account once a hand-over has closed its dialog", async () => {
    await page.viewport(1280, 1400);
    setCachedRegistry("wed_1", snapshotOf(settingsOf({})));
    authFetch.mockImplementation(async (url: string) =>
      String(url).endsWith("/registry/stripe/retire")
        ? json({
            settings: settingsOf({
              stripeConnected: false,
              stripeConnectedByOsnProfileId: null,
              stripeAccountType: null,
              stripeChargesEnabled: false,
              moneyGiftsBlockedBy: "stripe_not_ready",
            }),
          })
        : json({ hosts: SEATS.slice(0, 1).concat(SEATS[2]!) }),
    );
    showPanel();
    fireEvent.click(
      await screen.findByRole("button", { name: "Hand money gifts to another owner" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Hand money gifts to another owner?",
    });
    await waitFor(() => expect(dialog.textContent).toMatch(/@kit/));
    fireEvent.click(screen.getByRole("button", { name: "Hand over" }));
    const connect = await screen.findByRole("button", { name: "Connect an account" });
    await waitFor(() => expect(document.activeElement).toBe(connect));
    expect(document.querySelector("dialog[open]")).toBeNull();
  });
});
