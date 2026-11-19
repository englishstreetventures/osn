/**
 * Cire organiser portal: an owner arrives signed out at the address the
 * marketing site's "Your names" field sends a couple to, `/?name=Amara & Sam`,
 * signs in through osn-api from the login page that address leads to, and
 * finds the create form open with the names in it and the names gone from the
 * address. Nothing is sent until the owner presses "Create wedding"; the owner
 * cancels instead, so no wedding is made.
 *
 * Then the owner opens a Gold wedding's empty checklist, previews the starter
 * checklist and adds every task it ticks. Each lands in cire-api's `tasks` table, seeded from the template and
 * due a set time before the wedding date.
 *
 * The wedding (`CIRE_ORGANISER.checklist`) is dated 2099-06-20, far past the
 * suite clock, so no item's due date has passed and the dialog ticks them all.
 * How many the starter holds is read off the dialog rather than written here,
 * so a starter edit changes the count without breaking the flow.
 *
 * It then hides the tab until its push socket closes and shows it again: the
 * return reads the wedding list once, though the socket also reopens.
 *
 * Then, on the same page, the owner collapses the module rail to its icons,
 * reads a module's label from the keyboard, reloads to find the rail still
 * collapsed, opens and closes the locked Vendors card from the narrow rail,
 * presses its Upgrade to find Crimson not for sale on this stack, which prices
 * Gold alone, expands the rail again and scrolls to check it sticks below the
 * top bar. At a phone's width the rail gives way to the bottom bar: the owner
 * opens Guests from it, opens More, opens the locked Vendors tile's offer,
 * goes back to the checklist from its tile, and returns to the desk's width.
 *
 * Last, the owner deletes three of the starter's tasks with their ✕, each of
 * which offers Undo on a toast and sends nothing until that toast has gone.
 * The first is taken back with Undo, and its row never leaves cire-api. The
 * second's toast runs out, and its `DELETE` removes the row. The third is
 * deleted as the owner leaves the page, and its `DELETE`, sent across origins
 * on `pagehide`, still removes the row. That the request carries `keepalive`
 * is held by the three lists' browser tests: on this local stack a request
 * already sent as the page goes lands with or without it.
 *
 * Then, on the same signed-in page, the owner moves between the views of a
 * second Gold wedding (`CIRE_ORGANISER.cache`) and the flow logs, per view,
 * what the portal asked cire-api before the view first drew
 * (`tests/support/request-log.ts`): the checklist, the starter checklist and
 * the budget; the Overview; the guest list, its editor and the RSVPs, each
 * twice; Settings › Profile and Co-hosts and the invite builder, twice; the
 * events editor. The page's time holds still meanwhile, so no cached value
 * ages. A second visit inside a minute asks for nothing before it draws,
 * except Settings › Profile and the invite builder, which read on every visit;
 * an editor checks its change head only after drawing. The
 * RSVP table reads its replies again with their badges after the Overview read
 * them without, marks Ada's reply New and seen, and the Overview's changes
 * card reads again. A rename in the events editor shows on the Overview's next
 * visit, which reads the replies again; a reply recorded on the RSVP table
 * shows there with no read. Each visit's log is a check in `results.json`, and
 * the whole log, after-draw reads too, is `request-logs/cire-checklist-starter.json`.
 *
 * Last of all, on the same signed-in page, the owner opens a Gold checkout for an
 * Ivory wedding that is then deleted while the checkout is open, so its
 * payment is refunded and its owner mailed, and buys Gold for another Ivory
 * wedding through the Stripe stand-in and is granted it
 * (`tests/support/cire-upgrade.ts`).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import type { Page, Request } from "@playwright/test";

import {
  ARTIFACT_DIR,
  CIRE_ORGANISER,
  DB_FILES,
  LOG_DIR,
  ORIGINS,
  REALTIME_KEEPALIVE,
  SCREENSHOT_DIR,
} from "../../src/config";
import { buyGold, refundGold } from "../support/cire-upgrade";
import {
  expect,
  onSuiteClock,
  queryOne,
  signInToCireHost,
  suiteNow,
  test,
} from "../support/fixtures";
import {
  logApiCalls,
  readsAfterDraw,
  readsBeforeDraw,
  type ViewContent,
  visit,
  type VisitLog,
} from "../support/request-log";

const { weddingId, firstItem } = CIRE_ORGANISER.checklist;

/** How long a deleted row's toast offers Undo: `UNDO_MS` in cire/host's `lib/undo-delete.ts`. */
const UNDO_WINDOW_MS = 5_000;

/** The starter items the flow deletes at its end, by their template keys. */
const DELETED = {
  takenBack: "draft-guest-list",
  runOut: "book-venues",
  leftWith: "book-key-suppliers",
} as const;

/** Where the marketing site's claim link sends a couple who typed "Amara & Sam". */
const CLAIM_ARRIVAL = "/?name=Amara%20%26%20Sam";

/** The request that would create a wedding. */
const CREATE_WEDDING = `${ORIGINS.cireApi}/api/organiser/weddings`;

/**
 * Counts, in each document `page` loads, the frames its push sockets (path
 * `/realtime/…`) receive that are the keepalive's answer, and exposes the
 * count as `__e2ePushPongs`. The hub stand-in counts the pings it receives;
 * this shows its answer reached the page.
 */
async function countPushPongs(page: Page): Promise<void> {
  await page.addInitScript(
    ({ pong, path }) => {
      let received = 0;
      const dispatch = EventTarget.prototype.dispatchEvent;
      EventTarget.prototype.dispatchEvent = function (this: EventTarget, event: Event): boolean {
        if (
          event instanceof MessageEvent &&
          event.data === pong &&
          this instanceof WebSocket &&
          new URL(this.url).pathname.startsWith(path)
        ) {
          received += 1;
        }
        return dispatch.call(this, event);
      };
      Object.defineProperty(globalThis, "__e2ePushPongs", { get: () => received });
    },
    { pong: REALTIME_KEEPALIVE.pong, path: "/realtime/" },
  );
}

/** The current document's count from `countPushPongs`. */
const pushPongs = (page: Page): Promise<number> =>
  page.evaluate(() => Number(Reflect.get(globalThis, "__e2ePushPongs") ?? 0));

/**
 * Counts, in each document `page` loads from now on, the width transitions
 * the module rail starts, as `__e2eRailSlides`. A rail that reads its stored
 * state late would paint expanded and then slide shut, and a read of its width
 * after the page settles could not tell that from a rail painted collapsed.
 */
async function countRailSlides(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let runs = 0;
    document.addEventListener(
      "transitionrun",
      (event) => {
        if (
          event.propertyName === "width" &&
          event.target instanceof Element &&
          event.target.matches("[data-rail]")
        ) {
          runs += 1;
        }
      },
      true,
    );
    Object.defineProperty(globalThis, "__e2eRailSlides", { get: () => runs });
  });
}

const railSlides = (page: Page): Promise<number> =>
  page.evaluate(() => Number(Reflect.get(globalThis, "__e2eRailSlides") ?? -1));

/** Every module's row on the rail, by its accessible name, for a Gold wedding:
 *  Vendors is the one locked row, and its name says so. */
const RAIL_ROWS = [
  "Overview",
  "Events",
  "Checklist",
  "Run sheet",
  "Budget",
  "Vendors — locked. Included with Crimson.",
  "Registry",
  "Guests",
  "Seating",
  "Invite",
  "Settings",
] as const;

/** The rail's widths at this viewport: 14rem, and the row's own padding around
 *  its 1.125rem icon. */
const RAIL_EXPANDED = 224;
const RAIL_COLLAPSED = 42;

/** What `countReturnTraffic` has counted in the current document. */
interface ReturnTraffic {
  /** Push sockets (path `/realtime/…`) that have opened. */
  readonly opens: number;
  /** `GET` requests sent to `listUrl`. */
  readonly listReads: number;
  /** Those of them the page has finished with: a failure or an error status
   *  once it arrives, a success once its body has been read. */
  readonly listSettled: number;
}

/**
 * Counts, in each document `page` loads, the push sockets that open and the
 * `GET` requests sent to `listUrl`, and how many of those the page has
 * finished with, and exposes them as `__e2eReturnTraffic`. All are counted as
 * the page acts, so an `evaluate` that reads them runs after a socket's `open`
 * handlers, and after whatever the page did once a read settled, any further
 * request included.
 */
async function countReturnTraffic(page: Page, listUrl: string): Promise<void> {
  await page.addInitScript(
    ({ path, url }) => {
      let opens = 0;
      let listReads = 0;
      let listSettled = 0;
      const settled = (): void => {
        listSettled += 1;
      };
      const dispatch = EventTarget.prototype.dispatchEvent;
      EventTarget.prototype.dispatchEvent = function (this: EventTarget, event: Event): boolean {
        if (
          event.type === "open" &&
          this instanceof WebSocket &&
          new URL(this.url).pathname.startsWith(path)
        ) {
          opens += 1;
        }
        return dispatch.call(this, event);
      };
      const send = globalThis.fetch;
      Reflect.set(
        globalThis,
        "fetch",
        (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const request = input instanceof Request ? input : null;
          const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
          if ((request ? request.url : String(input)) !== url || method !== "GET") {
            return send(input, init);
          }
          listReads += 1;
          return send(input, init).then(
            (response) => {
              if (!response.ok) {
                settled();
                return response;
              }
              const body = response.json.bind(response);
              response.json = () => body().finally(settled);
              return response;
            },
            (error: unknown) => {
              settled();
              throw error;
            },
          );
        },
      );
      Object.defineProperty(globalThis, "__e2eReturnTraffic", {
        get: (): ReturnTraffic => ({ opens, listReads, listSettled }),
      });
    },
    { path: "/realtime/", url: listUrl },
  );
}

/** The current document's counts from `countReturnTraffic`. */
const returnTraffic = (page: Page): Promise<ReturnTraffic> =>
  page.evaluate(() => Reflect.get(globalThis, "__e2eReturnTraffic") as ReturnTraffic);

test("cire-checklist-starter", async ({ page, flow }) => {
  // First, so every document the page loads logs its reads.
  await logApiCalls(page, ORIGINS.cireApi);
  await countPushPongs(page);
  await countReturnTraffic(page, `${ORIGINS.cireApi}/api/organiser/weddings`);
  // From before the sign-in, so a form that sent itself on arrival is seen.
  const creates: string[] = [];
  const watchCreates = (request: Request): void => {
    if (request.method() === "POST" && request.url() === CREATE_WEDDING)
      creates.push(request.url());
  };
  page.on("request", watchCreates);
  await signInToCireHost(flow, page, CLAIM_ARRIVAL);

  const form = page.locator("form").filter({
    has: page.getByRole("textbox", { name: "Wedding name" }),
  });
  const arrived = await flow.step("find the names in the create form", async () => {
    const field = form.getByRole("textbox", { name: "Wedding name" });
    await expect(field).toBeVisible();
    // The form alone, with `astro dev`'s toolbar out of the way of the field.
    mkdirSync(resolve(SCREENSHOT_DIR, "cire-checklist-starter"), { recursive: true });
    const toolbar = await page.addStyleTag({
      content: "astro-dev-toolbar { display: none !important; }",
    });
    await form.screenshot({
      path: resolve(SCREENSHOT_DIR, "cire-checklist-starter", "portal-name-prefill.png"),
      animations: "disabled",
    });
    await toolbar.evaluate((style) => style.parentNode?.removeChild(style));
    return {
      value: await field.inputValue(),
      search: await page.evaluate(() => window.location.search),
    };
  });
  flow.check("portal: the create form opens with the couple's names", "Amara & Sam", arrived.value);
  flow.check("portal: the names leave the address once read", "", arrived.search);

  await flow.step("cancel the create form", async () => {
    await form.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: /Create a wedding/ })).toBeVisible();
    await expect(form).toHaveCount(0);
  });
  page.off("request", watchCreates);
  flow.check("portal: nothing asked cire-api to create a wedding", 0, creates.length);

  await flow.step("open the wedding's checklist", async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/checklist`);
    await expect(page.getByRole("button", { name: "Preview the starter checklist" })).toBeVisible();
  });

  const offered = await flow.step("preview the starter checklist", async () => {
    await page.getByRole("button", { name: "Preview the starter checklist" }).click();
    const dialog = page.getByRole("dialog", { name: "Starter checklist" });
    const add = dialog.getByRole("button", { name: /^Add \d+ tasks$/ });
    await expect(add).toBeEnabled();
    await expect(dialog.getByRole("checkbox", { name: firstItem.title })).toBeChecked();
    return Number((await add.textContent())?.match(/\d+/)?.[0] ?? 0);
  });
  flow.check("the dialog ticks a task to add", true, offered > 0);

  const applied = await flow.step("add the ticked tasks", async () => {
    const response = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        r.url() ===
          `${ORIGINS.cireApi}/api/organiser/weddings/${weddingId}/tasks/templates/starter`,
    );
    await page.getByRole("button", { name: `Add ${offered} tasks` }).click();
    const status = (await response).status();
    await expect(page.getByRole("dialog", { name: "Starter checklist" })).toBeHidden();
    await expect(page.getByText(`Added ${offered} tasks to your checklist.`)).toBeVisible();
    return status;
  });
  flow.check("starter applied", 200, applied);

  await flow.step("see the first task on the checklist", async () => {
    const row = page.getByRole("listitem").filter({ hasText: firstItem.title });
    await expect(row).toContainText(`due ${firstItem.dueAt}`);
  });

  const added = queryOne<{ n: number }>(
    DB_FILES.cire,
    "SELECT count(*) AS n FROM tasks WHERE wedding_id = ? AND template_id = 'starter'",
    weddingId,
  );
  flow.check("tasks rows from the starter, one per ticked item", offered, added?.n ?? -1);
  const first = queryOne<{
    title: string;
    timeframe_bucket: string;
    due_at: string | null;
    due_source: string;
    status: string;
    created_at: number;
  }>(
    DB_FILES.cire,
    "SELECT title, timeframe_bucket, due_at, due_source, status, created_at FROM tasks WHERE wedding_id = ? AND template_id = 'starter' AND template_item = ?",
    weddingId,
    firstItem.key,
  );
  flow.check("first task's title", firstItem.title, first?.title ?? "missing");
  flow.check(
    "first task's bucket",
    firstItem.timeframeBucket,
    first?.timeframe_bucket ?? "missing",
  );
  flow.check("first task due a year before the wedding", firstItem.dueAt, first?.due_at ?? "none");
  flow.check("first task's due date follows the wedding date", "template", first?.due_source ?? "");
  flow.check("first task is open", "open", first?.status ?? "missing");
  flow.check("tasks row written on the suite clock", true, onSuiteClock(first?.created_at));

  // After the checklist, so the page clock's jumps move nothing a step above
  // reads, and before the rail, whose reload starts a new document with
  // counts of its own. Over one ping interval the checklist page runs only
  // toast and layout timers, the command palette's warm-up import and the
  // socket's ping; none calls the API.
  const keepalive = await flow.step("let one push keepalive interval pass", async () => {
    await page.clock.runFor(REALTIME_KEEPALIVE.intervalMs);
    // The ping and its answer cross the test runner a moment after the tick.
    await expect
      .poll(() => pushPongs(page))
      .toBeGreaterThanOrEqual(1)
      .catch(() => undefined);
    return { pings: flow.realtimePings(), pongs: await pushPongs(page) };
  });
  flow.check("portal: the hub stand-in received the socket's ping", true, keepalive.pings >= 1);
  flow.check("portal: the socket received the stand-in's pong", true, keepalive.pongs >= 1);

  // Hidden for two ping intervals, the tab closes its push socket. Shown
  // again, it reads the wedding list, the last read being over a minute old,
  // and reopens the socket, whose `reconnected` relies on that read.
  const hidden = await flow.step("hide the tab until its push socket closes", async () => {
    const before = await returnTraffic(page);
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // A jump fires each due timer once: the socket's ping, then the close the
    // hidden tab scheduled. Running the clock instead could tick the ping
    // twice with the first unanswered, which counts as a lost socket.
    await page.clock.fastForward(2 * REALTIME_KEEPALIVE.intervalMs);
    return { before, after: await returnTraffic(page) };
  });
  flow.check(
    "hidden: the portal reads no wedding list",
    0,
    hidden.after.listReads - hidden.before.listReads,
  );

  const shown = await flow.step("show the tab again", async () => {
    const topics = flow.realtimeTopics().length;
    await page.evaluate(() => {
      Reflect.deleteProperty(document, "visibilityState");
      document.dispatchEvent(new Event("visibilitychange"));
    });
    // The socket has reopened and every list read has settled, so the
    // reconnect's choice, to rely on the return's read or to send its own, is
    // already counted.
    await expect
      .poll(async () => {
        const now = await returnTraffic(page);
        return now.opens === hidden.after.opens + 1 && now.listSettled === now.listReads;
      })
      .toBe(true);
    return { after: await returnTraffic(page), topics: flow.realtimeTopics().length - topics };
  });
  flow.check("shown: the push socket reaches the stand-in again", 1, shown.topics);
  flow.check(
    "shown: the portal reads the wedding list once",
    1,
    shown.after.listReads - hidden.after.listReads,
  );

  // The module rail. None of its steps is timed by the page clock.
  const nav = page.getByRole("navigation", { name: "Wedding modules" });
  const railWidth = async (): Promise<number> => Math.round((await nav.boundingBox())?.width ?? -1);
  const panelHeading = page.getByRole("heading", { level: 2, name: "Checklist", exact: true });
  const panelLeft = async (): Promise<number> => (await panelHeading.boundingBox())?.x ?? -1;
  const vendors = nav.getByRole("button", { name: RAIL_ROWS[5], exact: true });

  const railLabels = page.locator("[data-rail-tip]");
  /** Keyboard focus on a row opens its label at once wherever labels show, so
   *  a count straight after it says whether this rail shows them. */
  const labelsOnFocus = async (name: string): Promise<number> => {
    await nav.getByRole("button", { name, exact: true }).focus();
    return railLabels.count();
  };

  const collapsed = await flow.step("collapse the module rail", async () => {
    const toggle = page.getByRole("button", { name: "Collapse sidebar" });
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(await railWidth()).toBe(RAIL_EXPANDED);
    // Expanded, a row's name is on screen: focus shows no label beside it.
    const expandedLabels = await labelsOnFocus("Overview");
    const before = await panelLeft();
    await toggle.click();
    const expand = page.getByRole("button", { name: "Expand sidebar" });
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    await expect(expand).toBeFocused();
    await expect.poll(railWidth).toBe(RAIL_COLLAPSED);
    let reachable = 0;
    for (const name of RAIL_ROWS) {
      if (await nav.getByRole("button", { name, exact: true }).isVisible()) reachable += 1;
    }
    return {
      expandedLabels,
      width: await railWidth(),
      gave: before - (await panelLeft()),
      reachable,
    };
  });
  flow.check("rail: expanded, a focused row shows no label", 0, collapsed.expandedLabels);
  flow.check("rail: collapsed to its icons, in px", RAIL_COLLAPSED, collapsed.width);
  flow.check("rail: the panel took the width the rail gave up", true, collapsed.gave >= 160);
  flow.check(
    "rail: every module still a button by its name",
    RAIL_ROWS.length,
    collapsed.reachable,
  );

  const named = await flow.step("name a module from the collapsed rail", async () => {
    // From the toggle at the top of the rail, Tab goes to the first module.
    await page.keyboard.press("Tab");
    await expect(nav.getByRole("button", { name: "Overview", exact: true })).toBeFocused();
    const label = page.locator("[data-rail-tip]", { hasText: "Overview" });
    await expect(label).toBeVisible();
    return (await label.locator("span").allTextContents()).join(" / ");
  });
  flow.check(
    "rail: a focused row shows its label and its hint",
    "Overview / Your wedding at a glance",
    named,
  );

  await countRailSlides(page);
  const reloaded = await flow.step("reload with the rail collapsed", async () => {
    await page.reload();
    await expect(panelHeading).toBeVisible();
    await expect(page.getByRole("button", { name: "Expand sidebar" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    return { width: await railWidth(), slides: await railSlides(page) };
  });
  flow.check("rail: still collapsed after a reload, in px", RAIL_COLLAPSED, reloaded.width);
  flow.check("rail: painted collapsed, with no slide on load", 0, reloaded.slides);

  const card = await flow.step(
    "open and close a locked module's card from the collapsed rail",
    async () => {
      const offer = page.getByRole("dialog", { name: "Vendors & directory" });
      const upgrade = offer.getByRole("button", { name: "Upgrade to Crimson" });
      // A click opens the card; a second click on the same icon closes it.
      await vendors.click();
      await expect(upgrade).toBeFocused();
      const eyebrow = (await offer.getByText(/^Included with /).textContent()) ?? "";
      await vendors.click();
      await expect(offer).toBeHidden();
      const closedByClick = !(await offer.isVisible());
      // From the keyboard, Enter opens it and Escape hands focus back to the row.
      await vendors.press("Enter");
      await expect(upgrade).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(offer).toBeHidden();
      await expect(vendors).toBeFocused();
      return {
        eyebrow,
        closedByClick,
        returned: await vendors.evaluate((row) => row === document.activeElement),
      };
    },
  );
  flow.check(
    "rail: a press on a locked icon opens its card",
    "Included with Crimson",
    card.eyebrow,
  );
  flow.check("rail: a second click on the locked icon closes its card", true, card.closedByClick);
  flow.check("rail: Escape hands focus back to the locked row", true, card.returned);

  // This stack's cire-api sells Gold alone: a Gold wedding is offered no
  // Crimson, and the portal reads the empty catalogue as nothing for sale.
  const upgrade = await flow.step("press Upgrade where no tier is priced", async () => {
    const catalogue = page.waitForResponse(
      (res) =>
        res.url() === `${ORIGINS.cireApi}/api/organiser/weddings/${weddingId}/upgrade/catalogue`,
    );
    await vendors.click();
    await page
      .getByRole("dialog", { name: "Vendors & directory" })
      .getByRole("button", { name: "Upgrade to Crimson" })
      .click();
    const dialog = page.getByRole("dialog", { name: "Upgrade: Crimson" });
    await expect(dialog.getByText("Upgrades are not available on this site yet.")).toBeVisible();
    const response = await catalogue;
    const entries = ((await response.json()) as { upgrades?: unknown[] }).upgrades?.length ?? -1;
    const payDisabled = await dialog
      .getByRole("button", { name: "Continue to payment" })
      .isDisabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    return { status: response.status(), entries, payDisabled };
  });
  flow.check("upgrade: cire-api answers the catalogue", 200, upgrade.status);
  flow.check("upgrade: the catalogue prices nothing above Gold", 0, upgrade.entries);
  flow.check("upgrade: the dialog offers no payment", true, upgrade.payDisabled);
  // The stack is the one these labels name: cire-api logs this only when it
  // has a key and a Price but no platform secret, and so sells nothing.
  flow.check(
    "upgrade: cire-api built its upgrade routes, with no warning of a missing platform secret",
    0,
    readFileSync(resolve(LOG_DIR, "cireApi.log"), "utf8").split(
      "upgrades disabled: STRIPE_SECRET_KEY is set without STRIPE_PLATFORM_WEBHOOK_SECRET",
    ).length - 1,
  );

  const expanded = await flow.step("expand the module rail", async () => {
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect(page.getByRole("button", { name: "Collapse sidebar" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect.poll(railWidth).toBe(RAIL_EXPANDED);
    await expect(nav.getByText("Run sheet", { exact: true })).toBeVisible();
    const labels = await labelsOnFocus("Overview");
    // Off the rail, so the rail screenshot shows the rail with no label and
    // no focus ring.
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await panelHeading.hover();
    await expect(railLabels).toHaveCount(0);
    return { width: await railWidth(), slides: await railSlides(page), labels };
  });
  flow.check("rail: expanded again, in px", RAIL_EXPANDED, expanded.width);
  // The same document's count as the reload's check read: the press is the
  // one slide in it, which shows the counter sees a slide when there is one.
  flow.check("rail: the press slides it open, the one slide since the reload", 1, expanded.slides);
  flow.check("rail: expanded again, a focused row shows no label", 0, expanded.labels);

  // Against the real top bar: the rail sticks below it once the page scrolls
  // far enough to take the rail's own place under the bar.
  const stuck = await flow.step("scroll the checklist under the top bar", async () => {
    const railTop = (await nav.boundingBox())?.y ?? 0;
    const want = Math.round(railTop) - 10;
    await page.evaluate((by) => window.scrollBy(0, by), want);
    const scrolled = await page.evaluate(() => window.scrollY);
    const bar = await page.getByRole("banner").boundingBox();
    const rail = await nav.boundingBox();
    await page.evaluate(() => window.scrollTo(0, 0));
    return {
      far: scrolled >= want,
      below: bar !== null && rail !== null && rail.y >= bar.y + bar.height,
    };
  });
  flow.check("rail: the page scrolled past the rail's own place", true, stuck.far);
  flow.check("rail: sticks below the top bar", true, stuck.below);

  // On a phone the rail gives way to a bar at the foot of the screen: four
  // modules and More, which opens every module as a tile.
  const desk = page.viewportSize();
  const phoneBar = page.getByRole("navigation", { name: "Main modules" });
  const menu = page.getByRole("dialog", { name: "Wedding modules" });
  const phone = await flow.step(
    "on a phone, move between modules from the bottom bar",
    async () => {
      await page.setViewportSize({ width: 390, height: 844 });
      // `astro dev`'s own toolbar sits over the middle of the bar; production
      // has none.
      await page.addStyleTag({ content: "astro-dev-toolbar { display: none !important; }" });
      await expect(phoneBar).toBeVisible();
      const box = await phoneBar.boundingBox();
      const more = phoneBar.getByRole("button", { name: "Checklist, open wedding navigation" });
      await expect(more).toBeVisible();
      await phoneBar.getByRole("button", { name: "Guests", exact: true }).click();
      await page.waitForURL(/\/guests/);
      const guestsMarked =
        (await phoneBar
          .getByRole("button", { name: "Guests", exact: true })
          .getAttribute("aria-current")) ?? "";
      await phoneBar.getByRole("button", { name: "More, open wedding navigation" }).click();
      await expect(menu).toBeVisible();
      const tiles = await menu.getByRole("button").count();
      await page.screenshot({
        path: resolve(SCREENSHOT_DIR, "cire-checklist-starter", "phone-menu.png"),
        animations: "disabled",
      });
      await menu.getByRole("button", { name: /^Vendors — locked/ }).click();
      const offer = await page.getByText("Included with Crimson").first().isVisible();
      await page.keyboard.press("Escape");
      await menu.getByRole("button", { name: "Checklist", exact: true }).click();
      await expect(menu).toBeHidden();
      await page.waitForURL(/\/checklist/);
      return {
        atFoot: box !== null && Math.abs(box.y + box.height - 844) <= 1,
        guestsMarked,
        tiles,
        offer,
        back: await more.isVisible(),
      };
    },
  );
  flow.check("phone: the bar sits at the foot of the screen", true, phone.atFoot);
  flow.check("phone: a tab press opens its module, marked current", "page", phone.guestsMarked);
  flow.check("phone: More lists every module and its close button", 12, phone.tiles);
  flow.check("phone: a locked tile opens its offer", true, phone.offer);
  flow.check("phone: a tile press returns to the checklist, named on More", true, phone.back);
  await flow.step("back to the desk's width, the rail again", async () => {
    if (desk) await page.setViewportSize(desk);
    await expect(phoneBar).toHaveCount(0);
    await expect(nav).toBeVisible();
  });

  // Deletes that wait on their undo toast. Each task is found by its template
  // key, and its row on the page by the checkbox its title names, so a toast
  // that quotes the title is not taken for the row.
  const task = (key: string): { id: string; title: string } => {
    const found = queryOne<{ id: string; title: string }>(
      DB_FILES.cire,
      "SELECT id, title FROM tasks WHERE wedding_id = ? AND template_id = 'starter' AND template_item = ?",
      weddingId,
      key,
    );
    if (!found) throw new Error(`no starter task ${key}`);
    return found;
  };
  const taskRows = (id: string): number =>
    queryOne<{ n: number }>(DB_FILES.cire, "SELECT count(*) AS n FROM tasks WHERE id = ?", id)?.n ??
    -1;
  const rowOf = (title: string) =>
    page
      .getByRole("listitem")
      .filter({ has: page.getByRole("checkbox", { name: title, exact: true }) });
  const taskUrl = (id: string): string =>
    `${ORIGINS.cireApi}/api/organiser/weddings/${weddingId}/tasks/${encodeURIComponent(id)}`;
  const deletesSent: string[] = [];
  const watchDeletes = (request: Request): void => {
    if (request.method() === "DELETE") deletesSent.push(request.url());
  };
  page.on("request", watchDeletes);
  const takenBack = task(DELETED.takenBack);
  const runOut = task(DELETED.runOut);
  const leftWith = task(DELETED.leftWith);

  const undone = await flow.step("delete a task and take it back with Undo", async () => {
    await rowOf(takenBack.title).getByRole("button", { name: "Delete task", exact: true }).click();
    await expect(rowOf(takenBack.title)).toHaveCount(0);
    await page.getByRole("button", { name: `Undo deleting “${takenBack.title}”` }).click();
    await expect(page.getByText(`Restored “${takenBack.title}”`)).toBeVisible();
    await expect(rowOf(takenBack.title)).toHaveCount(1);
    // Off the toasts, so no toast below waits on a pointer resting over it.
    await page.mouse.move(0, 0);
    return { onPage: await rowOf(takenBack.title).count() };
  });
  flow.check("undo: the task is back on the checklist", 1, undone.onPage);

  const ranOut = await flow.step("delete a task and let its toast run out", async () => {
    await rowOf(runOut.title).getByRole("button", { name: "Delete task", exact: true }).click();
    await expect(page.getByText(`Deleted “${runOut.title}”`)).toBeVisible();
    // The row is still on cire-api while the toast offers Undo.
    const during = taskRows(runOut.id);
    const answered = page.waitForResponse(
      (res) => res.request().method() === "DELETE" && res.url() === taskUrl(runOut.id),
    );
    await page.clock.runFor(UNDO_WINDOW_MS + 1_000);
    const status = (await answered).status();
    await expect(rowOf(runOut.title)).toHaveCount(0);
    return { during, status };
  });
  flow.check("toast up: the task's row is still in cire-api", 1, ranOut.during);
  flow.check("toast gone: cire-api answered the DELETE", 200, ranOut.status);
  flow.check("toast gone: the task's row has left cire-api", 0, taskRows(runOut.id));

  const left = await flow.step("delete a task and leave the page at once", async () => {
    await rowOf(leftWith.title).getByRole("button", { name: "Delete task", exact: true }).click();
    await expect(page.getByText(`Deleted “${leftWith.title}”`)).toBeVisible();
    const during = taskRows(leftWith.id);
    await page.goto("about:blank");
    // The page is gone; the request it sent as it went outlives it.
    await expect.poll(() => taskRows(leftWith.id)).toBe(0);
    return { during };
  });
  flow.check("leaving: the task's row was in cire-api until the page went", 1, left.during);
  flow.check("leaving: the DELETE sent on pagehide reached cire-api", 0, taskRows(leftWith.id));

  const back = await flow.step("come back to the checklist", async () => {
    await page.goto(`${ORIGINS.cireHost}/#/w/${weddingId}/checklist`);
    await expect(rowOf(takenBack.title)).toHaveCount(1);
    return {
      runOut: await rowOf(runOut.title).count(),
      leftWith: await rowOf(leftWith.title).count(),
    };
  });
  page.off("request", watchDeletes);
  flow.check("back: the task whose toast ran out stays gone", 0, back.runOut);
  flow.check("back: the task deleted on the way out stays gone", 0, back.leftWith);
  // Past a whole window and a page exit, either of which sends a delete still
  // pending: Undo settled it for good.
  flow.check(
    "undo: no DELETE ever sent for the task taken back",
    0,
    deletesSent.filter((url) => url === taskUrl(takenBack.id)).length,
  );
  flow.check("undo: the task's row never left cire-api", 1, taskRows(takenBack.id));

  // The rail as the steps above leave it, before the upgrade steps take the
  // page elsewhere and end on the grant, the flow's final screenshot.
  await page.screenshot({
    path: resolve(SCREENSHOT_DIR, "cire-checklist-starter", "rail-expanded.png"),
    animations: "disabled",
  });
  // The portal's view caches, on a wedding of their own. The page is the one
  // the step above loaded, so it logs its reads; each goto below only changes
  // the hash. Every visit is checked for the reads it sent before it drew.
  const cached = CIRE_ORGANISER.cache;
  const weddingApi = `/api/organiser/weddings/${cached.weddingId}/`;
  // The page's time holds still for the section, timers still running: a
  // value the caches read stays inside its minute however slow the run, so
  // each check depends on what the portal did, not on how long it took.
  await page.clock.setFixedTime(await page.evaluate(() => Date.now()));
  const visits: VisitLog[] = [];
  const logged = async (
    name: string,
    expected: string,
    content: ViewContent,
    act: () => Promise<unknown>,
    after?: { read: string; answered: () => Promise<unknown> },
  ): Promise<VisitLog> => {
    const log = await flow.step(`visit ${name}`, () =>
      visit(page, name, content, act, after?.answered),
    );
    visits.push(log);
    flow.check(
      `request log: ${name}, read before it drew`,
      expected,
      readsBeforeDraw(log, weddingApi),
    );
    flow.check(
      `request log: ${name}, read after it drew`,
      after?.read ?? "",
      readsAfterDraw(log, weddingApi),
    );
    return log;
  };
  const toModule = (name: string) => () => nav.getByRole("button", { name, exact: true }).click();
  const toTab = (name: string) => () => page.getByRole("tab", { name, exact: true }).click();
  const responseTo = (method: string, path: string) => () =>
    page.waitForResponse(
      (r) =>
        r.request().method() === method && r.url() === `${ORIGINS.cireApi}${weddingApi}${path}`,
    );
  const STARTER_BUTTON: ViewContent = { selector: "button", text: "Preview the starter checklist" };
  const STARTER_ITEM: ViewContent = {
    selector: '[aria-labelledby="checklist-starter-title"] input[type="checkbox"]',
  };
  const OVERVIEW: ViewContent = { selector: "span", text: "attending across" };
  const HOUSEHOLDS: ViewContent = { selector: "td", text: cached.code };
  const GUEST_EDITOR: ViewContent = { selector: `[aria-label="Remove ${cached.ada}"]` };
  const RSVPS: ViewContent = { selector: `[aria-label="Edit reply for ${cached.ada} Alpha"]` };
  const EVENTS_EDITOR: ViewContent = { selector: '[data-testid="event-list"]' };
  const starterDialog = page.getByRole("dialog", { name: "Starter checklist" });
  const cancelStarter = () =>
    flow.step("close the starter checklist", async () => {
      await starterDialog.getByRole("button", { name: "Cancel" }).click();
      await expect(starterDialog).toBeHidden();
    });

  // The checklist, the starter checklist, another module, and back.
  await logged("checklist, first visit", "tasks", STARTER_BUTTON, () =>
    page.goto(`${ORIGINS.cireHost}/#/w/${cached.weddingId}/checklist`),
  );
  await logged("starter checklist, first opening", "tasks/templates/starter", STARTER_ITEM, () =>
    page.getByRole("button", { name: "Preview the starter checklist" }).click(),
  );
  await cancelStarter();
  await logged(
    "budget, first visit",
    "budget",
    { selector: "p", text: "No budget items yet" },
    toModule("Budget"),
  );
  await logged("checklist, second visit", "", STARTER_BUTTON, toModule("Checklist"));
  await logged("starter checklist, second opening", "", STARTER_ITEM, () =>
    page.getByRole("button", { name: "Preview the starter checklist" }).click(),
  );
  await cancelStarter();

  // The Overview, then the guest list, its editor and the RSVPs, twice over.
  await logged(
    "overview, first visit",
    "events · guests · rsvp-changes · rsvps · settings",
    OVERVIEW,
    toModule("Overview"),
  );
  flow.check(
    "overview: the changes card counts the household that replied",
    true,
    await page.getByText("1 household changed their RSVP").isVisible(),
  );
  await logged("households, first visit", "invite", HOUSEHOLDS, toModule("Guests"));
  await logged(
    "guest editor, first visit",
    "changes/head · events · guests · households",
    GUEST_EDITOR,
    toTab("Edit"),
  );
  await logged("RSVPs, first visit", "rsvp-changes/rows · rsvps", RSVPS, toTab("RSVPs"), {
    read: "",
    answered: responseTo("POST", "rsvp-changes/seen"),
  });
  const adaRow = page
    .getByRole("row")
    .filter({ has: page.getByRole("button", { name: `Edit reply for ${cached.ada} Alpha` }) });
  flow.check("RSVPs: Ada's reply is marked New", true, await adaRow.getByText("New").isVisible());
  await logged("guest editor, second visit", "", GUEST_EDITOR, toTab("Edit"), {
    read: "changes/head",
    answered: responseTo("GET", "changes/head"),
  });
  // Only the badge rows behind the cached draw: nothing new since, so the
  // replies themselves are not read again.
  await logged("RSVPs, second visit", "", RSVPS, toTab("RSVPs"), {
    read: "rsvp-changes/rows",
    answered: responseTo("GET", "rsvp-changes/rows"),
  });
  await logged("households, second visit", "", HOUSEHOLDS, toTab("Households"));
  await logged(
    "overview, after the RSVPs were seen",
    "rsvp-changes",
    OVERVIEW,
    toModule("Overview"),
  );
  flow.check(
    "overview: the changes card has nothing unseen",
    true,
    await page.getByText("Nothing new since your last visit.", { exact: true }).isVisible(),
  );

  // Settings › Profile and Co-hosts, and the invite builder, each twice. The
  // profile and the builder save whole objects with no version, so each reads
  // on every visit; their answers still keep the Overview's caches fresh.
  const PROFILE: ViewContent = { selector: "label", text: "Wedding name" };
  const COHOSTS: ViewContent = { selector: "div", text: CIRE_ORGANISER.profileId };
  const INVITE: ViewContent = { selector: '[aria-label="Invite design"]' };
  await logged("settings profile, first visit", "settings", PROFILE, toModule("Settings"));
  await logged("co-hosts, first visit", "hosts", COHOSTS, toTab("Co-hosts"));
  await logged("settings profile, second visit", "settings", PROFILE, toTab("Profile"));
  await logged("co-hosts, second visit", "", COHOSTS, toTab("Co-hosts"));
  await logged("invite builder, first visit", "invite", INVITE, toModule("Invite"));
  await logged("overview, between invite builder visits", "", OVERVIEW, toModule("Overview"));
  await logged("invite builder, second visit", "invite", INVITE, toModule("Invite"));

  // The events editor, drawn from the rows the guest editor read after its
  // head, then a rename the Overview shows on its next visit.
  await flow.step("open the events list", async () => {
    await toModule("Events")();
    await expect(page.getByRole("tab", { name: "List", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
  await logged("events editor, first visit", "", EVENTS_EDITOR, toTab("Edit"), {
    read: "changes/head",
    answered: responseTo("GET", "changes/head"),
  });
  const renamed = await flow.step(
    `rename the ${cached.reception} to ${cached.renamed}`,
    async () => {
      const drawer = page.getByRole("dialog", { name: "Edit event" });
      await page
        .getByTestId("event-list")
        .getByRole("listitem")
        .filter({ has: page.getByText(cached.reception, { exact: true }) })
        .getByRole("button", { name: "Edit", exact: true })
        .click();
      await drawer.getByLabel("Event name").fill(cached.renamed);
      await drawer.getByRole("button", { name: "Done" }).click();
      await expect(drawer).toBeHidden();
      const preview = responseTo("POST", "changes/preview")();
      await page.getByRole("button", { name: "Save changes" }).click();
      expect((await preview).status(), "preview").toBe(200);
      const apply = responseTo("POST", "changes/apply")();
      const reload = responseTo("GET", "events")();
      await page
        .getByRole("dialog", { name: "Review changes before applying" })
        .getByRole("button", { name: "Confirm & save" })
        .click();
      const status = (await apply).status();
      await reload;
      await expect(page.getByRole("button", { name: "Save changes" })).toBeHidden();
      return status;
    },
  );
  flow.check("events editor: the rename is saved", 200, renamed);
  await logged(
    "overview, after the rename",
    "guests · rsvps · tasks",
    OVERVIEW,
    toModule("Overview"),
  );
  flow.check(
    "overview: the replies name the renamed event",
    true,
    await page.locator("li").filter({ hasText: cached.renamed }).first().isVisible(),
  );

  // A reply recorded on the RSVP table, which the Overview shows unread.
  await logged("households, after the rename", "", HOUSEHOLDS, toModule("Guests"));
  await logged(
    "RSVPs, after the Overview read them",
    "rsvp-changes/rows · rsvps",
    RSVPS,
    toTab("RSVPs"),
  );
  const recorded = await flow.step(
    `record ${cached.bo} attending the ${cached.ceremony}`,
    async () => {
      await page.getByRole("button", { name: `Record reply for ${cached.bo} Alpha` }).click();
      await page.getByLabel("Status").selectOption("attending");
      const saved = responseTo("PUT", `guests/gst_e2e_cache_bo/rsvps/evt_e2e_cache_ceremony`)();
      await page.getByRole("button", { name: "Save reply" }).click();
      return (await saved).status();
    },
  );
  flow.check("RSVPs: the reply is recorded", 200, recorded);
  await logged("overview, after a reply was recorded", "", OVERVIEW, toModule("Overview"));
  flow.check(
    "overview: the Ceremony counts the recorded reply",
    true,
    await page
      .locator("li")
      .filter({ hasText: cached.ceremony })
      .filter({ hasText: "2 attending" })
      .first()
      .isVisible(),
  );
  // Time moves again, from the suite's clock, for the steps that follow.
  await page.clock.setSystemTime(suiteNow());
  mkdirSync(resolve(ARTIFACT_DIR, "request-logs"), { recursive: true });
  writeFileSync(
    resolve(ARTIFACT_DIR, "request-logs", "cire-checklist-starter.json"),
    `${JSON.stringify(visits, null, 2)}\n`,
  );

  await refundGold(flow, page);
  await buyGold(flow, page);
});
