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
 * expands the rail again and scrolls to check it sticks below the top bar.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

import type { Page, Request } from "@playwright/test";

import {
  CIRE_ORGANISER,
  DB_FILES,
  ORIGINS,
  REALTIME_KEEPALIVE,
  SCREENSHOT_DIR,
} from "../../src/config";
import { expect, onSuiteClock, queryOne, signInToCireHost, test } from "../support/fixtures";

const { weddingId, firstItem } = CIRE_ORGANISER.checklist;

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

  // The module rail. Nothing below is timed by the page clock.
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

  const expanded = await flow.step("expand the module rail", async () => {
    await page.getByRole("button", { name: "Expand sidebar" }).click();
    await expect(page.getByRole("button", { name: "Collapse sidebar" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect.poll(railWidth).toBe(RAIL_EXPANDED);
    await expect(nav.getByText("Run sheet", { exact: true })).toBeVisible();
    const labels = await labelsOnFocus("Overview");
    // Off the rail, so the final screenshot shows the rail with no label and
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
});
