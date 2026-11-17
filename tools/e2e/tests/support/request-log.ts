/**
 * What the cire portal reads from cire-api as it moves between views, split at
 * the moment each view first draws its own content.
 *
 * `logApiCalls` wraps `fetch` in every document the page loads from then on, so
 * call it before the first navigation it should see. Each call to cire-api is
 * logged in the page with its method and path, and whether it has answered.
 *
 * `visit` runs an action that opens a view and waits for the view's own
 * content. A `MutationObserver` on `document.body` (the `draw-watch.ts`
 * technique: its callback runs before the page paints) notes how many calls had
 * been sent when that content first entered the document. Calls sent before it
 * are the ones the view waited on, or sent as it mounted; a read a view sends
 * after it has drawn, behind what it shows, falls after. The visit then waits
 * for every logged call to answer, so the next visit starts clean.
 *
 * It waits on the page's own state, never on a clock (`tests/flows.test.ts`
 * forbids timeouts).
 */

import type { Page } from "@playwright/test";

import { expect } from "./fixtures";

/** One logged call: `GET /api/organiser/weddings/…`. */
interface ApiCall {
  readonly method: string;
  readonly path: string;
  settled: boolean;
}

/** Where a view's own content is: an element `selector` matches, holding
 *  `text` when given, outside any loading outline. */
export interface ViewContent {
  readonly selector: string;
  readonly text?: string;
}

/** What one visit sent, as `METHOD /path` lines in the order sent. */
export interface VisitLog {
  readonly visit: string;
  /** Sent before the view's content first entered the document. */
  readonly beforeDraw: string[];
  /** Sent after it, until every call had answered. */
  readonly afterDraw: string[];
}

/** Logs every `fetch` to `apiOrigin` in each document `page` loads from now on. */
export async function logApiCalls(page: Page, apiOrigin: string): Promise<void> {
  await page.addInitScript((origin) => {
    const calls: ApiCall[] = [];
    const send = globalThis.fetch;
    Reflect.set(globalThis, "fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      const url = new URL(request ? request.url : String(input), location.href);
      if (url.origin !== origin) return send(input, init);
      const call: ApiCall = {
        method: (init?.method ?? request?.method ?? "GET").toUpperCase(),
        path: url.pathname,
        settled: false,
      };
      calls.push(call);
      return send(input, init).finally(() => {
        call.settled = true;
      });
    });
    Object.defineProperty(globalThis, "__e2eApiCalls", { get: () => calls });
  }, apiOrigin);
}

const line = (call: ApiCall) => `${call.method} ${call.path}`;

/**
 * Runs `act`, waits for the view's content to be visible, for `after` (armed
 * before `act`, so a response it waits on cannot be missed) and for every call
 * sent to answer, and returns the calls sent before and after the content was
 * first drawn. `content` must match nothing on the page before `act`.
 */
export async function visit(
  page: Page,
  name: string,
  content: ViewContent,
  act: () => Promise<unknown>,
  /** A read the view sends after it draws, awaited before the visit ends. */
  after?: () => Promise<unknown>,
): Promise<VisitLog> {
  await page.evaluate(({ selector, text }) => {
    const w = window as unknown as {
      __e2eApiCalls: ApiCall[];
      __e2eVisit?: { start: number; drawnAt: number | null; observer: MutationObserver };
    };
    w.__e2eVisit?.observer.disconnect();
    const drawn = () =>
      [...document.querySelectorAll(selector)].some(
        (el) =>
          el.closest("[data-skeleton-outline]") === null &&
          (text === undefined || (el.textContent ?? "").includes(text)),
      );
    if (drawn()) throw new Error(`the view's content is already on the page: ${selector}`);
    const state: { start: number; drawnAt: number | null; observer: MutationObserver } = {
      start: w.__e2eApiCalls.length,
      drawnAt: null,
      observer: new MutationObserver(() => {
        if (state.drawnAt === null && drawn()) {
          state.drawnAt = w.__e2eApiCalls.length;
          state.observer.disconnect();
        }
      }),
    };
    state.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    w.__e2eVisit = state;
  }, content);

  const sentAfter = after?.();
  await act();

  const locator = page.locator(content.selector, content.text ? { hasText: content.text } : {});
  await expect(locator.first()).toBeVisible();
  await sentAfter;
  await expect
    .poll(() =>
      page.evaluate(() => {
        const w = window as unknown as {
          __e2eApiCalls: ApiCall[];
          __e2eVisit: { drawnAt: number | null };
        };
        return w.__e2eVisit.drawnAt !== null && w.__e2eApiCalls.every((call) => call.settled);
      }),
    )
    .toBe(true);

  const { calls, start, drawnAt } = await page.evaluate(() => {
    const w = window as unknown as {
      __e2eApiCalls: ApiCall[];
      __e2eVisit: { start: number; drawnAt: number };
    };
    return {
      calls: [...w.__e2eApiCalls],
      start: w.__e2eVisit.start,
      drawnAt: w.__e2eVisit.drawnAt,
    };
  });
  return {
    visit: name,
    beforeDraw: calls.slice(start, drawnAt).map(line),
    afterDraw: calls.slice(drawnAt).map(line),
  };
}

/**
 * The GETs a visit sent before its view drew, under `prefix`, sorted and
 * joined: the value a flow checks. Sorted because reads a view sends together
 * may go in any order; `""` for none.
 */
export function readsBeforeDraw(log: VisitLog, prefix: string): string {
  return log.beforeDraw
    .filter((call) => call.startsWith(`GET ${prefix}`))
    .map((call) => call.slice(`GET ${prefix}`.length))
    .toSorted()
    .join(" · ");
}

/** The GETs a visit sent after its view drew, under `prefix`, as `readsBeforeDraw`. */
export function readsAfterDraw(log: VisitLog, prefix: string): string {
  return readsBeforeDraw({ ...log, beforeDraw: log.afterDraw }, prefix);
}
