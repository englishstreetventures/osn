/**
 * The `flow` fixture every E2E flow runs with.
 *
 * It puts each browser page on the suite's clock, records the flow's steps,
 * API requests and assertions, and at the end takes the final-state screenshot
 * and attaches the record the results reporter writes into `results.json`.
 * Flows touch the stack only through the browser, the API request context and
 * the read-only helpers here.
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
} from "@playwright/test";

import { API_LABELS, BIRTHDATE, CLOCK_T0, ORIGINS, SCREENSHOT_DIR } from "../../src/config";
import { requestLine, requestSet, type Assertion, type FlowRecord } from "../../src/record";
import { RECORD_ATTACHMENT } from "../../src/reporter";

/** The launcher's real start; the suite's clock reads `CLOCK_T0` at that instant. */
const REAL_START = Number(process.env["E2E_CLOCK_R0"] ?? Date.now());
const suiteNow = (): number => CLOCK_T0 + (Date.now() - REAL_START);

export interface Flow {
  /** A named step: recorded in order and shown in the trace. */
  step<T>(name: string, body: () => Promise<T>): Promise<T>;
  /** Records a named check and fails the flow when `actual !== expected`. */
  check(name: string, expected: string | number | boolean, actual: string | number | boolean): void;
  /** A new page in `context` on the suite clock, with its API requests recorded. */
  newPage(context: BrowserContext): Promise<Page>;
  /** True when an API request recorded so far normalises to `line` (`POST osn-api /token 200`). */
  saw(line: string): boolean;
  /** A request made outside the browser (the API request context), recorded like a browser one. */
  recordRequest(method: string, url: string, status: number): void;
  /** The page whose final state is the flow's screenshot. Defaults to `page`. */
  finalPage: Page;
}

export const test = base.extend<{ flow: Flow }>({
  flow: async ({ page, context }, use, testInfo) => {
    const steps: string[] = [];
    const lines: string[] = [];
    const assertions: Assertion[] = [];
    const watched = new WeakSet<BrowserContext>();
    const watch = (ctx: BrowserContext): void => {
      if (watched.has(ctx)) return;
      watched.add(ctx);
      ctx.on("response", (response) => {
        const request = response.request();
        const line = requestLine(request.method(), request.url(), response.status(), API_LABELS);
        if (line) lines.push(line);
      });
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
        watch(ctx);
        const p = await ctx.newPage();
        await p.clock.install({ time: suiteNow() });
        return p;
      },
      saw(line) {
        return lines.includes(line);
      },
      recordRequest(method, url, status) {
        const line = requestLine(method, url, status, API_LABELS);
        if (line) lines.push(line);
      },
    };

    watch(context);
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
