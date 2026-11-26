import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * "Remove my Cire data", painted: the real top bar and the page measure, as
 * `OrganiserApp` draws them, round the screen in each of its states, and the
 * signed-out page the person lands on when it is done.
 *
 * Only a real engine can say that nothing runs past a phone's width: a
 * wedding's name is the host's own words and can be one 100-letter word, and
 * the rows hold a name, a line, two links and a box.
 *
 * Every case leaves a screenshot under `__screenshots__/` beside this file
 * (gitignored), at 390 and 1280px in both ramps.
 *
 * The factories below are written literally: the shared-factory idiom in
 * `test-support/mocks.ts` does not resolve in the browser project.
 */

const { authFetch, navigateTo } = vi.hoisted(() => ({
  authFetch: vi.fn(),
  navigateTo: vi.fn(),
}));
vi.mock("@shared/rp-auth/solid", () => ({ useAuth: () => ({ authFetch }) }));
vi.mock("../../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/api")>()),
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: () => false,
  redirectToLogin: () => {},
  navigateTo,
}));

import RemovalDone from "../../src/components/RemovalDone";
import RemoveCireData from "../../src/components/RemoveCireData";
import TopBar from "../../src/components/TopBar";
import type { RemovalAction, RemovalPlan, RemovalWedding } from "../../src/lib/account-removal";
import { forgetRemoval, keepAnswers } from "../../src/lib/account-removal";

const SHOTS = "__screenshots__/RemoveCireData.browser.test.tsx";
const VIEWPORTS = [
  { name: "390", width: 390, height: 2200 },
  { name: "1280", width: 1280, height: 1700 },
] as const;
const THEMES = ["light", "dark"] as const;

const SESSION = {
  osnProfileId: "usr_rosa",
  email: "rosa@example.com",
  handle: "rosa",
  displayName: "Rosa Host",
  avatarUrl: null,
  expiresAt: "2099-01-01T00:00:00Z",
};

const wedding = (
  weddingId: string,
  name: string,
  role: RemovalWedding["role"],
  more: Partial<RemovalWedding> = {},
): RemovalWedding => ({ weddingId, name, role, soleOwner: false, deleted: false, ...more });
const actionOf = (weddingId: string): RemovalAction => ({
  id: `cire:wedding:${weddingId}`,
  weddingId,
});

const ROSA = wedding("wed_rosa", "Rosa & Viktor", "owner", { soleOwner: true });
/** A host's own words, with nowhere to break. */
const LONG = wedding(
  "wed_long",
  "AleksandraPetronellaWilhelminaVonHohenzollernSigmaringenAndBartholomewsGardenParty",
  "owner",
  { soleOwner: true },
);
const MIA = wedding("wed_mia", "Mia & Theo", "owner");
const PRIYA = wedding("wed_priya", "Priya & Sam", "editor");
const JO = wedding("wed_jo", "Jo & Lee's day on the farm", "helper");
const ANA = wedding("wed_ana", "Ana & Ben", "owner", { deleted: true });
/** A wedding another profile of the account owns, listed once the person has confirmed. */
const KAI = wedding("wed_kai", "Kai & Noor", "owner", { soleOwner: true });
/** A wedding the person owns with someone else, whose Stripe account they hold. */
const HANA = wedding("wed_hana", "Hana & Leo", "owner", { payoutHolder: true });

const SIGNED_IN: RemovalPlan = {
  weddings: [ANA, PRIYA, JO, LONG, MIA, ROSA],
  more: 0,
  openActions: [actionOf(ROSA.weddingId), actionOf(LONG.weddingId)],
  confirmed: false,
};
const CONFIRMED: RemovalPlan = {
  weddings: [...SIGNED_IN.weddings, KAI],
  more: 0,
  openActions: [...SIGNED_IN.openActions, actionOf(KAI.weddingId)],
  confirmed: true,
};
/** Past 100 weddings the person alone owns: one action stands for them all. */
const MANY: RemovalPlan = {
  weddings: [{ ...ROSA, soleOwner: false }, MIA, PRIYA],
  more: 140,
  openActions: [{ id: "cire:weddings:all", weddingId: null }],
  confirmed: false,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const never = () => new Promise<Response>(() => {});

interface Answers {
  preview?: (body: { code?: string }) => Response | Promise<Response>;
  confirmation?: () => Response | Promise<Response>;
  remove?: () => Response | Promise<Response>;
}

/** Answer the three calls by path. */
function serve(answers: Answers) {
  authFetch.mockImplementation(async (input: unknown, init?: RequestInit) => {
    const path = String(input).replace("https://api.test", "");
    const body = init?.body ? (JSON.parse(String(init.body)) as { code?: string }) : {};
    if (path === "/api/organiser/account/removal/preview") {
      return (answers.preview ?? (() => json(SIGNED_IN)))(body);
    }
    if (path === "/api/organiser/account/removal/confirmation") {
      return (answers.confirmation ?? never)();
    }
    if (path === "/api/organiser/account") return (answers.remove ?? never)();
    return json({});
  });
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

/** The screen in the page as `OrganiserApp` draws it. */
function show(props: { code?: string } = {}) {
  render(() => (
    <div class="@container/frame">
      <div class="chrome-scope contents">
        <TopBar
          session={SESSION}
          wedding={null}
          weddings={[]}
          sectionLabel="Your Cire data"
          onWedding={() => {}}
          onAll={() => {}}
          onSecurity={() => {}}
          onRemoveData={() => {}}
          onSignOut={() => {}}
          onOpenPalette={() => {}}
        />
        <main class="page-frame @container/page flex flex-col gap-8 py-8 @2xl/frame:py-10">
          <RemoveCireData
            code={props.code}
            canOpen={(id) => id !== KAI.weddingId}
            onOpen={() => {}}
            onCancel={() => {}}
            onDone={() => {}}
          />
        </main>
      </div>
    </div>
  ));
}

/** Nothing scrolls sideways, and nothing inside the screen runs past it. */
function expectLaidOut(width: number) {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  const screenBox = document.querySelector<HTMLElement>(
    "[data-remove-cire-data], [data-removal-done]",
  );
  expect(screenBox, "the screen").not.toBeNull();
  const right = screenBox!.getBoundingClientRect().right;
  for (const el of screenBox!.querySelectorAll<HTMLElement>("p, li, a, button, label")) {
    expect(el.getBoundingClientRect().right).toBeLessThanOrEqual(right + 0.5);
  }
}

async function shot(name: string, viewport: (typeof VIEWPORTS)[number], theme: string) {
  await painted();
  expectLaidOut(viewport.width);
  await page.screenshot({ path: `${SHOTS}/${name}-${viewport.name}-${theme}.png` });
}

const button = (name: string | RegExp) => screen.getByRole("button", { name });

beforeEach(() => {
  forgetRemoval();
  authFetch.mockReset();
  navigateTo.mockReset();
});

afterEach(() => {
  cleanup();
  forgetRemoval();
  delete document.documentElement.dataset.theme;
});

describe("Remove my Cire data, painted", () => {
  for (const viewport of VIEWPORTS) {
    for (const theme of THEMES) {
      const at = `${viewport.name}px, ${theme}`;
      const open = async (props?: { code?: string }) => {
        await page.viewport(viewport.width, viewport.height);
        document.documentElement.dataset.theme = theme;
        show(props);
      };

      it(`loading — ${at}`, async () => {
        serve({ preview: never });
        await open();
        expect(await screen.findByText("Checking your weddings…")).toBeTruthy();
        await shot("01-loading", viewport, theme);
      });

      it(`no weddings — ${at}`, async () => {
        serve({
          preview: () => json({ weddings: [], more: 0, openActions: [], confirmed: false }),
        });
        await open();
        expect(await screen.findByText("No weddings")).toBeTruthy();
        await shot("02-no-weddings", viewport, theme);
      });

      it(`co-owned only — ${at}`, async () => {
        serve({
          preview: () =>
            json({ weddings: [MIA, PRIYA], more: 0, openActions: [], confirmed: false }),
        });
        await open();
        expect(await screen.findByText("You leave these")).toBeTruthy();
        expect(screen.queryByRole("checkbox")).toBeNull();
        await shot("03-co-owned-only", viewport, theme);
      });

      it(`sole-owned, needing answers, one already deleted — ${at}`, async () => {
        serve({});
        await open();
        expect(await screen.findByText(ROSA.name)).toBeTruthy();
        expect(screen.getAllByRole("link", { name: "Download wedding" })).toHaveLength(2);
        expect(screen.getAllByRole("link", { name: "Add another owner" })).toHaveLength(2);
        await shot("04-sole-owned", viewport, theme);
      });

      it(`an answer missing — ${at}`, async () => {
        serve({});
        await open();
        expect(await screen.findByText(ROSA.name)).toBeTruthy();
        fireEvent.click(
          screen.getByRole("checkbox", { name: `Delete this wedding: ${ROSA.name}` }),
        );
        fireEvent.click(button("Confirm on Musubi"));
        expect(await screen.findByText("Answer for each wedding marked above.")).toBeTruthy();
        expect(navigateTo).not.toHaveBeenCalled();
        await waitFor(() =>
          expect(document.activeElement).toBe(
            screen.getByRole("checkbox", { name: `Delete this wedding: ${LONG.name}` }),
          ),
        );
        await shot("05-answer-missing", viewport, theme);
      });

      it(`more than 100 — ${at}`, async () => {
        serve({ preview: () => json(MANY) });
        await open();
        expect(
          await screen.findByRole("checkbox", { name: /Delete every wedding only you own/ }),
        ).toBeTruthy();
        expect(await screen.findByText(/more weddings not listed here/)).toBeTruthy();
        await shot("06-more-than-100", viewport, theme);
      });

      it(`going to Musubi — ${at}`, async () => {
        serve({});
        await open();
        expect(await screen.findByText(ROSA.name)).toBeTruthy();
        fireEvent.click(
          screen.getByRole("checkbox", { name: /Delete every wedding only you own/ }),
        );
        fireEvent.click(button("Confirm on Musubi"));
        expect(await screen.findByRole("button", { name: "Going to Musubi…" })).toBeTruthy();
        expect(button("Going to Musubi…").getAttribute("aria-disabled")).toBe("true");
        await shot("07-going-to-musubi", viewport, theme);
      });

      it(`back and confirmed, with every profile's weddings — ${at}`, async () => {
        keepAnswers({ answered: [actionOf(ROSA.weddingId).id], deleteEverything: false });
        serve({ preview: (body) => json(body.code ? CONFIRMED : SIGNED_IN) });
        await open({ code: "code_confirmed" });
        expect(await screen.findByText(KAI.name)).toBeTruthy();
        expect(button("Remove my Cire data")).toBeTruthy();
        expect(
          (
            screen.getByRole("checkbox", {
              name: `Delete this wedding: ${ROSA.name}`,
            }) as HTMLInputElement
          ).checked,
        ).toBe(true);
        await shot("08-confirmed", viewport, theme);
      });

      it(`refused with a fresh list — ${at}`, async () => {
        serve({
          preview: (body) => json(body.code ? { ...CONFIRMED, openActions: [] } : SIGNED_IN),
          remove: () =>
            json(
              {
                error: "open_actions",
                openActions: CONFIRMED.openActions,
                weddings: CONFIRMED.weddings,
                more: 0,
              },
              409,
            ),
        });
        await open({ code: "code_confirmed" });
        expect(await screen.findByText(KAI.name)).toBeTruthy();
        fireEvent.click(button("Remove my Cire data"));
        expect(await screen.findByText(/Your weddings changed since you looked/)).toBeTruthy();
        await shot("09-refused-fresh-list", viewport, theme);
      });

      it(`refused for a payout account the person holds — ${at}`, async () => {
        const message =
          "You connected the Stripe account that money gifts are paid into on the weddings listed. Before you remove your Cire data, hand money gifts to another owner or disconnect the account in each wedding's Money gifts settings, then remove your data again.";
        serve({
          preview: (body) =>
            json(
              body.code
                ? { ...CONFIRMED, weddings: [...CONFIRMED.weddings, HANA] }
                : { ...SIGNED_IN, weddings: [...SIGNED_IN.weddings, HANA] },
            ),
          remove: () =>
            json(
              {
                error: "holds_payout_account",
                message,
                weddings: [{ weddingId: HANA.weddingId, name: HANA.name }],
              },
              409,
            ),
        });
        await open({ code: "code_confirmed" });
        expect(await screen.findByText(HANA.name)).toBeTruthy();
        fireEvent.click(
          screen.getByRole("checkbox", { name: /Delete every wedding only you own/ }),
        );
        fireEvent.click(button("Remove my Cire data"));
        expect(await screen.findByText(message)).toBeTruthy();
        expect(await screen.findByText("Hand this over before you remove your data.")).toBeTruthy();
        const link = screen.getByRole("link", { name: "Money gifts" });
        await waitFor(() => expect(document.activeElement).toBe(link));
        await shot("10a-payout-account-held", viewport, theme);
      });

      it(`removing, past "not finished" — ${at}`, async () => {
        let calls = 0;
        serve({
          preview: (body) => json(body.code ? CONFIRMED : SIGNED_IN),
          remove: () => (++calls === 1 ? json({ status: "not_finished" }, 202) : never()),
        });
        await open({ code: "code_confirmed" });
        expect(await screen.findByText(KAI.name)).toBeTruthy();
        fireEvent.click(
          screen.getByRole("checkbox", { name: /Delete every wedding only you own/ }),
        );
        fireEvent.click(button("Remove my Cire data"));
        expect(
          await screen.findByText("Many weddings take a few rounds. Keep this page open."),
        ).toBeTruthy();
        expect(calls).toBe(2);
        await shot("10-removing", viewport, theme);
      });

      it(`a failure — ${at}`, async () => {
        serve({
          preview: (body) => json(body.code ? CONFIRMED : SIGNED_IN),
          remove: () => json({ error: "Internal error" }, 500),
        });
        await open({ code: "code_confirmed" });
        expect(await screen.findByText(KAI.name)).toBeTruthy();
        fireEvent.click(
          screen.getByRole("checkbox", { name: /Delete every wedding only you own/ }),
        );
        fireEvent.click(button("Remove my Cire data"));
        expect(await screen.findByText("Cire couldn't finish this. Try again.")).toBeTruthy();
        await shot("11-failure", viewport, theme);
      });

      it(`a list that did not load — ${at}`, async () => {
        serve({ preview: () => json({ error: "unavailable" }, 503) });
        await open();
        expect(await screen.findByText(/Cire can't reach Musubi right now/)).toBeTruthy();
        await shot("12-load-failure", viewport, theme);
      });

      it(`confirmation expired or refused — ${at}`, async () => {
        serve({ preview: () => json(SIGNED_IN) });
        await open({ code: "code_stale" });
        expect(await screen.findByText(/Your confirmation from Musubi has run out/)).toBeTruthy();
        expect(button("Confirm on Musubi")).toBeTruthy();
        await shot("13-confirmation-expired", viewport, theme);
      });

      it(`done, signed out — ${at}`, async () => {
        await page.viewport(viewport.width, viewport.height);
        document.documentElement.dataset.theme = theme;
        render(() => (
          <div class="@container/frame">
            <RemovalDone />
          </div>
        ));
        expect(
          await screen.findByRole("heading", { name: "Your Cire data is removed" }),
        ).toBeTruthy();
        expect(document.activeElement).toBe(
          screen.getByRole("heading", { name: "Your Cire data is removed" }),
        );
        await shot("14-done", viewport, theme);
      });
    }
  }
});
