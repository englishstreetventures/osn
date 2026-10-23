/**
 * The `flow` fixture every E2E flow runs with.
 *
 * It puts each browser page on the suite's clock, records the flow's steps,
 * API requests and assertions, and at the end takes the final-state screenshot
 * and attaches the record the results reporter writes into `results.json`.
 * In each context it records, it stands in for cire's realtime hub, which the
 * stack does not run (`standInForCireHub`). Flows touch the stack only through
 * the browser, the API request context and the read-only helpers here.
 */

import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  test as base,
  expect,
  type APIRequestContext,
  type BrowserContext,
  type CDPSession,
  type Page,
  type Route,
} from "@playwright/test";

import {
  API_LABELS,
  BIRTHDATE,
  CIRE_GIFT_LIST,
  CIRE_ORGANISER,
  CLOCK_T0,
  DB_FILES,
  DEV_LOGIN_SECRET,
  ORGANISER_ADDRESS,
  ORIGINS,
  REALTIME_KEEPALIVE,
  SCREENSHOT_DIR,
} from "../../src/config";
import type { CapturedMail } from "../../src/mail";
import { requestLine, requestSet, type Assertion, type FlowRecord } from "../../src/record";
import { RECORD_ATTACHMENT } from "../../src/reporter";

/** The launcher's real start; the suite's clock reads `CLOCK_T0` at that instant. */
const REAL_START = Number(process.env["E2E_CLOCK_R0"] ?? Date.now());
const suiteNow = (): number => CLOCK_T0 + (Date.now() - REAL_START);

/**
 * Every push socket the organiser portal opens: cire-api's origin over `ws:`,
 * then `/realtime/<topic>`, as `weddingTopicUrl` in
 * `cire/host/src/lib/realtime.ts` builds it. A glob, so Playwright matches it
 * itself and opens every other socket (Vite's) on the network as before.
 */
const CIRE_REALTIME_PATH = "/realtime/";
const CIRE_REALTIME_SOCKETS = `${ORIGINS.cireApi.replace(/^http/, "ws")}${CIRE_REALTIME_PATH}**`;

/**
 * Stands in for cire's realtime hub in `ctx` until englishstreetventures/osn#1653
 * lands. The stack's cire-api has no hub and answers `/realtime/*` with 404, so
 * without this every portal subscription fails, retries on the client's
 * jittered backoff and gives up at a moment that differs from run to run,
 * sending the fallback beacon (`POST /api/realtime/fallback`) into one run's
 * `results.json` and not the next. Here each socket opens, stays open and has
 * its ping answered, as `TopicHub` answers it; no subscription gives up, and no
 * signal is ever sent. Each socket's topic is pushed to `topics` as it arrives.
 */
async function standInForCireHub(ctx: BrowserContext, topics: string[]): Promise<void> {
  await ctx.routeWebSocket(CIRE_REALTIME_SOCKETS, (ws) => {
    const { pathname } = new URL(ws.url());
    topics.push(decodeURIComponent(pathname.slice(CIRE_REALTIME_PATH.length)));
    ws.onMessage((message) => {
      if (message === REALTIME_KEEPALIVE.ping) ws.send(REALTIME_KEEPALIVE.pong);
    });
  });
}

export interface Flow {
  /** A named step: recorded in order and shown in the trace. */
  step<T>(name: string, body: () => Promise<T>): Promise<T>;
  /** Records a named check and fails the flow when `actual !== expected`. */
  check(name: string, expected: string | number | boolean, actual: string | number | boolean): void;
  /** A new page in `context` on the suite clock, with its API requests recorded. */
  newPage(context: BrowserContext): Promise<Page>;
  /** True when an API request recorded so far normalises to `line` (`POST osn-api /token 200`). */
  saw(line: string): boolean;
  /** How many recorded API request lines start with `prefix`, repeats and every status included. */
  count(prefix: string): number;
  /** A request made outside the browser (the API request context), recorded like a browser one. */
  recordRequest(method: string, url: string, status: number): void;
  /** The realtime topics the pages' sockets have reached the hub stand-in with, in order. */
  realtimeTopics(): readonly string[];
  /** The page whose final state is the flow's screenshot. Defaults to `page`. */
  finalPage: Page;
}

export const test = base.extend<{ flow: Flow }>({
  flow: async ({ page, context }, use, testInfo) => {
    const steps: string[] = [];
    const lines: string[] = [];
    const assertions: Assertion[] = [];
    const topics: string[] = [];
    const watched = new WeakSet<BrowserContext>();
    const watch = async (ctx: BrowserContext): Promise<void> => {
      if (watched.has(ctx)) return;
      watched.add(ctx);
      ctx.on("response", (response) => {
        const request = response.request();
        const line = requestLine(request.method(), request.url(), response.status(), API_LABELS);
        if (line) lines.push(line);
      });
      await standInForCireHub(ctx, topics);
    };

    const flow: Flow = {
      finalPage: page,
      async step(name, body) {
        steps.push(name);
        return test.step(name, body);
      },
      check(name, expected, actual) {
        const pass = actual === expected;
        assertions.push({ name, expected: String(expected), actual: String(actual), pass });
        expect(actual, name).toBe(expected);
      },
      async newPage(ctx) {
        await watch(ctx);
        const p = await ctx.newPage();
        await p.clock.install({ time: suiteNow() });
        return p;
      },
      saw(line) {
        return lines.includes(line);
      },
      count(prefix) {
        return lines.filter((recorded) => recorded.startsWith(prefix)).length;
      },
      recordRequest(method, url, status) {
        const line = requestLine(method, url, status, API_LABELS);
        if (line) lines.push(line);
      },
      realtimeTopics() {
        return [...topics];
      },
    };

    await watch(context);
    // Before the first navigation, so the page's scripts never see the real date.
    await page.clock.install({ time: suiteNow() });
    try {
      await use(flow);
    } finally {
      mkdirSync(SCREENSHOT_DIR, { recursive: true });
      await flow.finalPage
        .screenshot({
          path: resolve(SCREENSHOT_DIR, `${testInfo.title}.png`),
          animations: "disabled",
        })
        .catch(() => undefined);
      const record: FlowRecord = {
        flow: testInfo.title,
        status: testInfo.status ?? "unknown",
        steps,
        requests: requestSet(lines),
        assertions,
      };
      await testInfo.attach(RECORD_ATTACHMENT, {
        body: JSON.stringify(record),
        contentType: "application/json",
      });
    }
  },
});

export { expect };

/**
 * Every message sent to `email` so far, oldest first, once one of them matches
 * `until` — by default, once any has landed.
 */
export async function mailFor(
  email: string,
  until: (message: CapturedMail) => boolean = () => true,
): Promise<CapturedMail[]> {
  let messages: CapturedMail[] = [];
  await expect
    .poll(
      async () => {
        const response = await fetch(`${ORIGINS.mail}/__e2e/mail?to=${encodeURIComponent(email)}`);
        messages = (await response.json()) as CapturedMail[];
        return messages.some(until);
      },
      { message: `no matching message reached ${email}`, timeout: 15_000 },
    )
    .toBe(true);
  return messages;
}

/** The newest one-time code sent to `email`, waiting for the mail to land. */
export async function otpFor(email: string, after = 0): Promise<string> {
  let code = "";
  await expect
    .poll(
      async () => {
        const response = await fetch(`${ORIGINS.mail}/__e2e/mail?to=${encodeURIComponent(email)}`);
        const messages = (await response.json()) as Array<{ text: string }>;
        const latest = messages.slice(after).at(-1);
        code = latest?.text.match(/\b(\d{6})\b/)?.[1] ?? "";
        return code;
      },
      { message: `no one-time code reached ${email}`, timeout: 15_000 },
    )
    .not.toBe("");
  return code;
}

/**
 * Registers an OSN account through the API, the way Musubi's dialog does, and
 * leaves its session cookie in `request`'s jar. For flows whose subject is not
 * registration.
 */
export async function registerThroughApi(
  flow: Flow,
  request: APIRequestContext,
  person: { readonly email: string; readonly handle: string; readonly name: string },
): Promise<void> {
  const headers = { Origin: ORIGINS.musubi };
  const beginUrl = `${ORIGINS.osnApi}/register/begin`;
  const begin = await request.post(beginUrl, {
    headers,
    data: {
      email: person.email,
      handle: person.handle,
      birthdate: BIRTHDATE,
      displayName: person.name,
    },
  });
  flow.recordRequest("POST", beginUrl, begin.status());
  expect(begin.status(), "register/begin").toBe(200);

  const code = await otpFor(person.email);
  const completeUrl = `${ORIGINS.osnApi}/register/complete`;
  const complete = await request.post(completeUrl, {
    headers,
    data: { email: person.email, code },
  });
  flow.recordRequest("POST", completeUrl, complete.status());
  expect(complete.status(), "register/complete").toBe(201);
}

/** A virtual platform authenticator on `page`, through the Chrome DevTools Protocol. */
export async function addVirtualAuthenticator(page: Page): Promise<{
  cdp: CDPSession;
  credentials(): Promise<Array<{ rpId?: string; isResidentCredential: boolean }>>;
}> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return {
    cdp,
    async credentials() {
      const { credentials } = await cdp.send("WebAuthn.getCredentials", { authenticatorId });
      return credentials;
    },
  };
}

/** One row from a stack database, opened read-only for this query alone. */
export function queryOne<T>(
  dbPath: string,
  sql: string,
  ...params: Array<string | number>
): T | undefined {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).get(...params) as T | undefined;
  } finally {
    db.close();
  }
}

/**
 * Sends `context`'s invitation claims (`POST /api/claim`) from
 * `ORGANISER_ADDRESS` rather than from the machine the suite runs on.
 *
 * cire-api limits claims per client address, five a minute, and every other
 * flow claims from the same one; an organiser previews from their own network,
 * so this flow's claim spends its own window. The headers are the request's
 * own (`allHeaders`, which keeps `Origin` for the origin guard) plus the
 * address. `tools/e2e/tests/flows.test.ts` counts such flows apart.
 *
 * The route stays for the rest of the flow, on purpose. While any route is
 * installed Playwright pauses every request in the context, and removing the
 * route while the page is still loading strands whichever request was paused
 * at that moment: a module import the claim's reveal waits on never settles,
 * and the invitation stays on its code form.
 */
export async function claimFromOrganiserAddress(context: BrowserContext): Promise<void> {
  await context.route(`${ORIGINS.cireApi}/api/claim`, async (route: Route) => {
    const request = route.request();
    if (request.method() !== "POST") return route.continue();
    return route.continue({
      headers: { ...(await request.allHeaders()), "cf-connecting-ip": ORGANISER_ADDRESS },
    });
  });
}

/** A cookie in `context` by name, or undefined. */
export async function cookieNamed(context: BrowserContext, url: string, name: string) {
  return (await context.cookies(url)).find((c) => c.name === name);
}

/**
 * True when a row timestamp (unix seconds) was written on the suite clock: at
 * or after its start, within the hour a run takes. A server that missed the
 * clock preload writes the real date and fails this whatever day it runs.
 */
export function onSuiteClock(unixSeconds: number | undefined): boolean {
  const start = Math.floor(CLOCK_T0 / 1000);
  return unixSeconds !== undefined && unixSeconds >= start && unixSeconds < start + 3600;
}

/**
 * Which of the gift list's private strings (`CIRE_GIFT_LIST`: every gift title,
 * the couple's headline, their message, and the cash fund's name and words)
 * `text` holds, comma-joined, or `"none"`. Read off a page's HTML or an API
 * body: what a visitor without a claim must never receive.
 */
export function giftListTextIn(text: string): string {
  const secret = [
    ...CIRE_GIFT_LIST.gifts,
    CIRE_GIFT_LIST.headline,
    CIRE_GIFT_LIST.message,
    CIRE_GIFT_LIST.fund.title,
    CIRE_GIFT_LIST.fund.description,
  ];
  return secret.filter((s) => text.includes(s)).join(", ") || "none";
}

/**
 * Signs `page`'s context in to the cire organiser portal as the dev profile,
 * which owns every `CIRE_ORGANISER` wedding, and leaves the page on the
 * portal's wedding list.
 *
 * osn-api's `/dev/login` mints the OSN session, since no passkey can be enrolled
 * for an account a seed wrote. Everything after it is the real sign-in: the
 * portal's "Continue with musubi", cire-api's OIDC start leg, osn-api's
 * `/authorize`, which hands the first-party portal a code with no screen, and
 * cire-api's callback, which exchanges it and sets `cire_org_session`.
 *
 * Each call spends two of cire-api's OIDC redirect legs (15 a minute per
 * address), one `/dev/login` (10) and one osn-api `/authorize` (20);
 * `tests/flows.test.ts` caps how many flows may call it.
 */
export async function signInToCireHost(flow: Flow, page: Page): Promise<void> {
  const authorizePages: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame() && frame.url().startsWith(`${ORIGINS.musubi}/authorize`)) {
      authorizePages.push(frame.url());
    }
  });

  await flow.step("organiser: get an OSN session from /dev/login", async () => {
    const url = `${ORIGINS.osnApi}/dev/login`;
    // The context's own request client: the session cookie lands in the jar
    // the browser sends to osn-api's `/authorize`.
    const response = await page
      .context()
      .request.get(`${url}?secret=${encodeURIComponent(DEV_LOGIN_SECRET)}`);
    flow.recordRequest("GET", url, response.status());
    expect(response.status(), "dev login").toBe(200);
  });

  // The flows share one database, so the check is this sign-in's own row: one
  // more for the dev profile than before it.
  const sessionsBefore = organiserSessions();
  await flow.step("organiser: sign in to the portal with musubi", async () => {
    await page.goto(`${ORIGINS.cireHost}/login`);
    await page.getByRole("button", { name: "Continue with musubi" }).click();
    // The portal lands on `/` and rewrites the empty hash to its wedding list.
    await expect(page).toHaveURL(`${ORIGINS.cireHost}/#/weddings`);
  });

  flow.check("organiser: musubi /authorize page not shown", 0, authorizePages.length);
  const cookie = await cookieNamed(page.context(), ORIGINS.cireApi, "cire_org_session");
  flow.check("organiser: cire_org_session set by cire-api", true, cookie !== undefined);
  flow.check("organiser: cire_org_session is HttpOnly", true, cookie?.httpOnly ?? false);
  flow.check(
    "organiser: one organiser_sessions row added for the dev profile",
    1,
    organiserSessions() - sessionsBefore,
  );
}

/** How many cire organiser sessions the dev profile holds. */
function organiserSessions(): number {
  const row = queryOne<{ n: number }>(
    DB_FILES.cire,
    "SELECT count(*) AS n FROM organiser_sessions WHERE osn_profile_id = ?",
    CIRE_ORGANISER.profileId,
  );
  return row?.n ?? 0;
}
