import { describe, expect, it } from "bun:test";

import { createRateLimiter } from "@shared/rate-limit";
import type { RateLimiterBackend } from "@shared/rate-limit";
import type { FallbackOutcome } from "@shared/realtime";

import { createApp } from "../../src/app";
import { createDb } from "../../src/db/setup";
import { createRealtimeRoute } from "../../src/routes/realtime";
import { counterValue } from "../test-helpers/metrics-harness";

const PATH = "/api/realtime/fallback";
// `createApp`'s default `webOrigin`, and so the only origin its guard admits.
const ORIGIN = "http://localhost:4321";

/**
 * An app with its own limiter. `bun test` runs every file in one process, so
 * the module-level default would carry one case's count into the next.
 */
function buildApp(limiter: RateLimiterBackend = generous()) {
  return createApp(createDb(":memory:"), { realtimeFallbackLimiter: limiter });
}

function generous(): RateLimiterBackend {
  return createRateLimiter({ maxRequests: 10_000, windowMs: 60_000 });
}

let lastOctet = 0;
/** A fresh address per request, so no case shares a bucket by accident. */
const nextIp = () => `203.0.113.${++lastOctet}`;

/**
 * POST `body` as the portal's beacon does: a `text/plain` string from an
 * allowed origin, behind Cloudflare. A `null` in `headers` removes that header.
 */
function beacon(
  app: ReturnType<typeof createApp>,
  body: string,
  headers: Record<string, string | null> = {},
): Promise<Response> {
  const sent: Record<string, string> = {
    Origin: ORIGIN,
    "cf-connecting-ip": nextIp(),
    "Content-Type": "text/plain;charset=UTF-8",
  };
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) delete sent[name];
    else sent[name] = value;
  }
  return Promise.resolve(
    app.fetch(new Request(`http://localhost${PATH}`, { method: "POST", headers: sent, body })),
  );
}

const fallbacks = (outcome: FallbackOutcome) =>
  counterValue("realtime.client.fallbacks", { product: "cire", outcome });

const allFallbacks = async () => (await fallbacks("refused")) + (await fallbacks("exhausted"));

async function expectNoContent(res: Response): Promise<void> {
  expect(res.status).toBe(204);
  expect(await res.text()).toBe("");
}

describe("POST /api/realtime/fallback — counted", () => {
  it("counts an exhausted beacon, answering 204 with no body", async () => {
    const app = buildApp();
    const before = await fallbacks("exhausted");
    await expectNoContent(await beacon(app, "exhausted"));
    expect(await fallbacks("exhausted")).toBe(before + 1);
  });

  it("counts a refused beacon", async () => {
    const app = buildApp();
    const before = await fallbacks("refused");
    await expectNoContent(await beacon(app, "refused"));
    expect(await fallbacks("refused")).toBe(before + 1);
  });

  it("counts an outcome with a trailing newline", async () => {
    const app = buildApp();
    const before = await fallbacks("refused");
    await expectNoContent(await beacon(app, "refused\n"));
    expect(await fallbacks("refused")).toBe(before + 1);
  });

  it("counts a padded body of exactly the byte cap", async () => {
    const app = buildApp();
    const before = await fallbacks("refused");
    await expectNoContent(await beacon(app, "refused".padEnd(64, " ")));
    expect(await fallbacks("refused")).toBe(before + 1);
  });
});

describe("POST /api/realtime/fallback — dropped, still 204", () => {
  it.each([
    ["an unknown word", "gave-up"],
    ["an empty body", ""],
    ["JSON", '{"outcome":"refused"}'],
  ])("drops %s", async (_label, body) => {
    const app = buildApp();
    const before = await allFallbacks();
    await expectNoContent(await beacon(app, body));
    expect(await allFallbacks()).toBe(before);
  });

  it("drops a beacon whose declared length is over the cap, unread", async () => {
    const app = buildApp();
    const before = await allFallbacks();
    await expectNoContent(await beacon(app, "refused", { "Content-Length": "65" }));
    expect(await allFallbacks()).toBe(before);
  });

  it("drops a body over the cap that declares no length", async () => {
    // Surrounding whitespace alone would pass `readFallbackOutcome`, so this
    // is refused by the route's own read cap.
    const app = buildApp();
    const before = await allFallbacks();
    await expectNoContent(await beacon(app, "refused".padEnd(65, " ")));
    expect(await allFallbacks()).toBe(before);
  });

  it("drops a beacon with no cf-connecting-ip", async () => {
    const app = buildApp();
    const before = await allFallbacks();
    await expectNoContent(await beacon(app, "refused", { "cf-connecting-ip": null }));
    expect(await allFallbacks()).toBe(before);
  });

  it("drops a second beacon from one address past the limit, and still counts another's", async () => {
    const app = buildApp(createRateLimiter({ maxRequests: 1, windowMs: 60_000 }));
    const ip = "198.51.100.7";
    const before = await fallbacks("refused");

    await expectNoContent(await beacon(app, "refused", { "cf-connecting-ip": ip }));
    expect(await fallbacks("refused")).toBe(before + 1);

    await expectNoContent(await beacon(app, "refused", { "cf-connecting-ip": ip }));
    expect(await fallbacks("refused")).toBe(before + 1);

    await expectNoContent(await beacon(app, "refused", { "cf-connecting-ip": "198.51.100.8" }));
    expect(await fallbacks("refused")).toBe(before + 2);
  });

  it("drops the beacon when the limiter throws", async () => {
    const app = buildApp({
      check: () => {
        throw new Error("limiter unavailable");
      },
    });
    const before = await allFallbacks();
    await expectNoContent(await beacon(app, "refused"));
    expect(await allFallbacks()).toBe(before);
  });
});

describe("POST /api/realtime/fallback — the origin guard", () => {
  it.each([
    ["a foreign Origin", "https://evil.example"],
    ["no Origin", null],
  ])("refuses %s with 403 and counts nothing", async (_label, origin) => {
    const app = buildApp();
    const before = await allFallbacks();
    const res = await beacon(app, "refused", { Origin: origin });
    expect(res.status).toBe(403);
    expect(await allFallbacks()).toBe(before);
  });
});

describe("POST /api/realtime/fallback — reaches the Elysia app", () => {
  it("is not taken by the Worker's realtime subscribe route", () => {
    const route = createRealtimeRoute(createDb(":memory:"));
    expect(
      route(new Request(`https://api.example.test${PATH}`, { method: "POST", body: "refused" })),
    ).toBeUndefined();
  });
});
