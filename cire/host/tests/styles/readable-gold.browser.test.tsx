import { contrastRatio, WCAG_TEXT_MIN } from "@cire/theme";
import { cleanup, render, screen, within } from "@solidjs/testing-library";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * The words the 2026-11-04 consistency audit found drawn in an ink with no
 * contrast contract, as painted, in both themes: each must read 4.5:1 on what
 * it sits on (`DESIGN.md` §2, "Gold is metal; gold-ink is ink", and the
 * token table's `--text-faint`: large text, ornament and the disabled only).
 *
 * - the RSVP tally's "Attending";
 * - the chosen design card's "Current" (no design is premium today, so
 *   "Locked" draws nowhere; `readable-ink.test.ts` holds its class);
 * - the overview's "Today!", its attending count, its open-task and vendor
 *   counts;
 * - the getting-started guide's "0 / 4 done" and a step's number;
 * - the command palette's group label and its Esc key;
 * - a locked module's name in the rail and in the phone's sheet.
 *
 * `readable-ink.test.ts` keeps every other word in the portals off those inks.
 */

const { authFetch, routes } = vi.hoisted(() => ({
  authFetch: vi.fn(),
  routes: { value: {} as Record<string, unknown> },
}));
vi.mock("@shared/rp-auth/solid", () => ({
  useAuth: () => ({ authFetch, activeProfileId: () => null }),
}));
vi.mock("@shared/toast", () => ({ toast: { success: () => {}, error: () => {}, info: () => {} } }));
vi.mock("../../src/lib/touch-feedback", () => ({
  haptic: () => {},
  hapticsAvailable: () => false,
}));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
}));
vi.mock("../../src/lib/rsvp-changes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/rsvp-changes")>()),
  fetchRsvpChangeRows: async () => null,
  markRsvpChangesSeen: async () => {},
}));
vi.mock("../../src/lib/osn", () => ({
  CIRE_API_URL: "https://api.test",
  CIRE_WEB_URL: "https://guests.test",
  CIRE_MARKETING_URL: "https://cire.test",
}));

import CommandPalette from "../../src/components/CommandPalette";
import type { WeddingSummary } from "../../src/components/CreateWeddingForm";
import GettingStarted from "../../src/components/GettingStarted";
import DesignPicker from "../../src/components/invite/DesignPicker";
import ModuleSidebar from "../../src/components/ModuleSidebar";
import Overview from "../../src/components/Overview";
import { __resetBudgetCache } from "../../src/lib/budget-store";
import { __resetEventsCache, setCachedEvents } from "../../src/lib/events-store";
import { __resetGuestsCache, setCachedGuests } from "../../src/lib/guests-store";
import { __resetHouseholdsCache } from "../../src/lib/households-store";
import { __resetTasksCache } from "../../src/lib/tasks-store";
import { __resetVendorsCache } from "../../src/lib/vendors-store";
import { EVENTS_300, GUESTS_300, HOUSEHOLDS_300, RSVPS_300 } from "../test-support/guests-300";
import { renderOrganiserPage, routeFetch } from "../test-support/organiser-page";
import { backdrop, over } from "../test-support/painted";

const THEMES = ["light", "dark"] as const;

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** Answer by the path's last segment from `routes.value`; anything else `{}`. */
function routeByPath() {
  authFetch.mockImplementation(async (input: unknown) => {
    const path = String(input).split("?")[0]!;
    const key = Object.keys(routes.value).find((k) => path.endsWith(`/${k}`));
    return json(key === undefined ? {} : routes.value[key]);
  });
}

beforeAll(() => {
  const style = document.createElement("style");
  style.textContent = "*, *::before, *::after { transition: none !important; }";
  document.head.append(style);
});

afterEach(() => {
  cleanup();
  authFetch.mockReset();
  routes.value = {};
  __resetBudgetCache();
  __resetEventsCache();
  __resetGuestsCache();
  __resetHouseholdsCache();
  __resetTasksCache();
  __resetVendorsCache();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

/** The word's ink over every ground beneath it, against that ground. */
function ratio(el: Element): number {
  const ground = backdrop(el);
  return contrastRatio(over(getComputedStyle(el).color, ground), ground)!;
}

/** The named words under 4.5:1, each with its ratio, so a failure says which. */
function unreadable(words: Record<string, Element>): (readonly [string, number])[] {
  return Object.entries(words)
    .map(([name, el]) => [name, Math.round(ratio(el) * 100) / 100] as const)
    .filter(([, r]) => r < WCAG_TEXT_MIN);
}

/** Today in the wedding date's form, so the countdown reads "Today!". */
function todayIso(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const TASK = {
  id: "t1",
  weddingId: "wed_1",
  title: "Book the florist",
  notes: null,
  timeframeBucket: "6m",
  dueAt: null,
  status: "open",
  sortOrder: 0,
  createdAt: 1,
  completedAt: null,
  assigneeHostIds: [],
};

const RUTH: WeddingSummary = {
  id: "wed_1",
  slug: "ruth-and-vik",
  displayName: "Ruth & Vik",
  role: "owner",
  entitlements: [],
  guestCap: 100,
};

for (const theme of THEMES) {
  describe(`gold and faint words, ${theme}`, () => {
    it("reads the RSVP tally's Attending", async () => {
      document.documentElement.dataset.theme = theme;
      await page.viewport(1280, 800);
      routeFetch(authFetch, {
        rsvps: RSVPS_300,
        guests: GUESTS_300,
        events: EVENTS_300,
        households: HOUSEHOLDS_300,
      });
      renderOrganiserPage({ module: "guests", sub: "rsvps" });
      const attending = await vi.waitFor(() => screen.getByText("Attending", { selector: "dt" }), {
        timeout: 10_000,
      });
      expect([theme, unreadable({ "tally Attending": attending })]).toEqual([theme, []]);
    });

    it("reads the chosen design card's Current", async () => {
      document.documentElement.dataset.theme = theme;
      render(() => (
        <DesignPicker
          entitlements={[]}
          currentId="classic"
          saving={false}
          onSelect={() => {}}
          previewHref={(id) => `https://guests.test/?design=${id}`}
        />
      ));
      expect([theme, unreadable({ Current: screen.getByText("Current") })]).toEqual([theme, []]);
    });

    it("reads the overview's day, attending, open-task and vendor counts", async () => {
      document.documentElement.dataset.theme = theme;
      await page.viewport(1280, 800);
      setCachedEvents("wed_1", [{ id: "e1", name: "Ceremony" } as never]);
      setCachedGuests("wed_1", [{ familyId: "fam_a", firstName: "Al" } as never]);
      routes.value = {
        settings: { wedding: { weddingDate: todayIso(), currency: "AUD", budgetTotalMinor: null } },
        rsvps: {
          events: [
            {
              id: "e1",
              name: "Ceremony",
              invited: 10,
              attending: 6,
              declined: 2,
              maybe: 1,
              responded: 9,
              noResponse: 1,
            },
          ],
        },
        tasks: { tasks: [TASK] },
        vendors: { vendors: [{ id: "v1", name: "Bloom & Co" }] },
        events: [{ id: "e1", name: "Ceremony" }],
        guests: [],
        budget: { items: [], payments: [], budgetTotalMinor: null, currency: "AUD" },
      };
      routeByPath();
      render(() => <Overview weddingId="wed_1" tier="crimson" onNavigate={() => {}} />);
      const today = await vi.waitFor(() => screen.getByText("Today!"));
      const number = (pattern: RegExp) =>
        vi.waitFor(() => {
          const line = screen.getByText(pattern);
          const value = line.querySelector("span") ?? line.previousElementSibling;
          expect(value).not.toBeNull();
          return value!;
        });
      expect([
        theme,
        unreadable({
          "Today!": today,
          attending: await number(/attending across/),
          "open tasks": (await vi.waitFor(() => screen.getByText(/open\s+task/))).querySelector(
            "span",
          )!,
          vendors: (await vi.waitFor(() => screen.getByText(/tracked/))).querySelector("span")!,
        }),
      ]).toEqual([theme, []]);
    });

    it("reads the getting-started count and a step's number", async () => {
      document.documentElement.dataset.theme = theme;
      routes.value = {
        events: [],
        guests: [],
        invite: {
          hero: { title: null, subtitle: null, imageUrl: null },
          story: { heading: null, body: null, imageUrl: null },
        },
      };
      routeByPath();
      render(() => <GettingStarted weddingId="wed_1" onJump={() => {}} />);
      const done = await vi.waitFor(() => screen.getByText(/\d+ \/ \d+ done/));
      const step = screen
        .getAllByRole("button")
        .find((b) => b.hasAttribute("data-complete") && b.dataset.complete === "false")!;
      const marker = [...step.querySelectorAll("span")].find((s) => /^\d+$/.test(s.textContent!))!;
      expect([theme, unreadable({ "n / m done": done, "step number": marker })]).toEqual([
        theme,
        [],
      ]);
    });

    it("reads the command palette's group label and its Esc key", async () => {
      document.documentElement.dataset.theme = theme;
      await page.viewport(1280, 800);
      render(() => (
        <CommandPalette
          open
          onOpenChange={() => {}}
          wedding={RUTH}
          weddings={[RUTH]}
          onModule={() => {}}
          onWedding={() => {}}
          onAll={() => {}}
          onSecurity={() => {}}
          onSignOut={() => {}}
        />
      ));
      const list = await vi.waitFor(() => screen.getByRole("listbox", { name: "Commands" }));
      const label = list.querySelector('li[role="presentation"]')!;
      expect(label).not.toBeNull();
      const esc = [...document.querySelectorAll("kbd")].find(
        (k) => k.textContent?.trim() === "Esc",
      )!;
      const hint = list.querySelector('[role="option"] span + span');
      expect([
        theme,
        unreadable({
          "group label": label,
          Esc: esc,
          ...(hint ? { "option hint": hint } : {}),
        }),
      ]).toEqual([theme, []]);
    });

    for (const [width, where] of [
      [1200, "rail"],
      [375, "sheet"],
    ] as const) {
      it(`reads a locked module's name in the ${where}`, async () => {
        document.documentElement.dataset.theme = theme;
        // On the free tier Vendors is locked: its row opens an offer, not the module.
        render(() => (
          <div class="@container/shell" style={{ width: `${width}px` }}>
            <ModuleSidebar
              active="overview"
              tier="ivory"
              canManage={false}
              weddingId="wed_1"
              weddingSlug="ruth-and-vik"
              onSelect={() => {}}
            />
          </div>
        ));
        if (where === "sheet") {
          screen.getByRole("button", { name: /^Open wedding navigation/ }).click();
        }
        const vendors = await vi.waitFor(() => {
          const scope =
            where === "sheet" ? screen.getByRole("dialog") : document.querySelector("nav")!;
          const name = within(scope as HTMLElement)
            .getAllByText("Vendors")
            .find((el) => el.closest("button"))!;
          expect(name).toBeDefined();
          return name;
        });
        expect([theme, unreadable({ "locked Vendors": vendors })]).toEqual([theme, []]);
      });
    }
  });
}
