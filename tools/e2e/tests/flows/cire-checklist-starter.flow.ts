/**
 * Cire organiser portal: an owner signs in through osn-api, opens a Gold
 * wedding's empty checklist, previews the starter checklist and adds every task
 * it ticks. Each lands in cire-api's `tasks` table, seeded from the template and
 * due a set time before the wedding date.
 *
 * The wedding (`CIRE_ORGANISER.checklist`) is dated 2099-06-20, far past the
 * suite clock, so no item's due date has passed and the dialog ticks them all.
 * How many the starter holds is read off the dialog rather than written here,
 * so a starter edit changes the count without breaking the flow.
 *
 * Then, on the same page, the owner collapses the module rail to its icons,
 * reads a module's label from the keyboard, reloads to find the rail still
 * collapsed, opens the locked Vendors card from the narrow rail and expands
 * the rail again.
 */

import type { Page } from "@playwright/test";

import { CIRE_ORGANISER, DB_FILES, ORIGINS, REALTIME_KEEPALIVE } from "../../src/config";
import { expect, onSuiteClock, queryOne, signInToCireHost, test } from "../support/fixtures";

const { weddingId, firstItem } = CIRE_ORGANISER.checklist;

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

test("cire-checklist-starter", async ({ page, flow }) => {
  await countPushPongs(page);
  await signInToCireHost(flow, page);

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

  // After the checklist, so the page clock's jump moves nothing a step above
  // reads, and before the rail, whose reload starts a new document with a
  // pong count of its own. Over one ping interval the checklist page runs only
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
    // From the toggle at the rail's foot, back up to the last module.
    await page.keyboard.press("Shift+Tab");
    await expect(nav.getByRole("button", { name: "Settings", exact: true })).toBeFocused();
    const label = page.locator("[data-rail-tip]", { hasText: "Settings" });
    await expect(label).toBeVisible();
    return (await label.locator("span").allTextContents()).join(" / ");
  });
  flow.check(
    "rail: a focused row shows its label and its hint",
    "Settings / Profile, budget, and co-hosts",
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

  const card = await flow.step("open a locked module's card from the collapsed rail", async () => {
    await vendors.click();
    const offer = page.getByRole("dialog", { name: "Vendors & directory" });
    const upgrade = offer.getByRole("button", { name: "Upgrade to Crimson" });
    await expect(upgrade).toBeFocused();
    const eyebrow = (await offer.getByText(/^Included with /).textContent()) ?? "";
    await page.keyboard.press("Escape");
    await expect(offer).toBeHidden();
    await expect(vendors).toBeFocused();
    return { eyebrow, returned: await vendors.evaluate((row) => row === document.activeElement) };
  });
  flow.check(
    "rail: a press on a locked icon opens its card",
    "Included with Crimson",
    card.eyebrow,
  );
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
