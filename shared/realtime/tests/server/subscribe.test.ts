import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ParsedTopic } from "../../src/protocol";
import { fakeHub } from "../support/fake-hub";

const { metricSubscribe } = vi.hoisted(() => ({ metricSubscribe: vi.fn() }));
vi.mock("../../src/server/metrics", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/server/metrics")>()),
  metricSubscribe,
}));

import { HUB_SUBJECT_HEADER, HUB_TOPIC_HEADER } from "../../src/server/headers";
import type { HubNamespace } from "../../src/server/hub-namespace";
import { subscribe, type SubscribeOptions } from "../../src/server/subscribe";

const ORIGIN = "https://host.example.test";
const TOPIC = "cire:wedding:wed_1";
const RAW = encodeURIComponent(TOPIC);

function upgradeRequest(headers: Record<string, string> = {}, method = "GET"): Request {
  return new Request(`https://api.example.test/realtime/${RAW}`, {
    method,
    headers: { upgrade: "websocket", origin: ORIGIN, cookie: "session=secret", ...headers },
  });
}

function options(overrides: Partial<SubscribeOptions> = {}, hub?: HubNamespace): SubscribeOptions {
  return {
    product: "cire",
    hub: hub ?? fakeHub({}).hub,
    allowedOrigins: [ORIGIN],
    acceptsTopic: (topic: ParsedTopic) => topic.entity === "wedding",
    authenticate: async () => "usr_alice",
    allow: async () => true,
    authorize: async () => true,
    ...overrides,
  };
}

const run = (request: Request, raw: string, opts: SubscribeOptions) =>
  Effect.runPromise(subscribe(request, raw, opts));

beforeEach(() => metricSubscribe.mockReset());

describe("subscribe — admitted", () => {
  it("returns the hub's own 101 response, untouched", async () => {
    const hubResponse = new Response(null, { status: 101 });
    const { hub, fetches } = fakeHub({ fetch: async () => hubResponse });

    const res = await run(upgradeRequest(), RAW, options({}, hub));

    expect(res).toBe(hubResponse);
    expect(fetches[0]?.name).toBe(TOPIC);
    expect(metricSubscribe).toHaveBeenCalledWith("cire", "accepted");
  });

  it("hands the hub a fresh request: upgrade, topic and subject only, never the browser's headers", async () => {
    const { hub, fetches } = fakeHub({});
    await run(upgradeRequest({ [HUB_SUBJECT_HEADER]: "usr_forged" }), RAW, options({}, hub));

    const forwarded = fetches[0]?.request;
    expect(forwarded?.headers.get("upgrade")).toBe("websocket");
    expect(forwarded?.headers.get(HUB_TOPIC_HEADER)).toBe(TOPIC);
    expect(forwarded?.headers.get(HUB_SUBJECT_HEADER)).toBe("usr_alice");
    expect(forwarded?.headers.get("cookie")).toBeNull();
    expect(forwarded?.headers.get("origin")).toBeNull();
  });
});

describe("subscribe — refused before anything costly", () => {
  it.each([
    ["a request with no upgrade header", upgradeRequest({ upgrade: "" }), RAW, 426, "not_upgrade"],
    ["a POST", upgradeRequest({}, "POST"), RAW, 426, "not_upgrade"],
    [
      "a missing Origin",
      new Request(`https://api.example.test/realtime/${RAW}`, {
        headers: { upgrade: "websocket" },
      }),
      RAW,
      403,
      "bad_origin",
    ],
    [
      "a foreign Origin",
      upgradeRequest({ origin: "https://evil.example" }),
      RAW,
      403,
      "bad_origin",
    ],
    [
      "an Origin with a trailing slash",
      upgradeRequest({ origin: `${ORIGIN}/` }),
      RAW,
      403,
      "bad_origin",
    ],
    ["a malformed topic", upgradeRequest(), encodeURIComponent("cire:wedding:"), 404, "bad_topic"],
    ["a broken percent escape", upgradeRequest(), "cire%3Awedding%3A%E0%A4%A", 404, "bad_topic"],
    [
      "another product's topic",
      upgradeRequest(),
      encodeURIComponent("osn:org:org_1"),
      404,
      "bad_topic",
    ],
    [
      "an entity this product refuses",
      upgradeRequest(),
      encodeURIComponent("cire:vendor:v_1"),
      404,
      "bad_topic",
    ],
  ])("refuses %s", async (_label, request, raw, status, outcome) => {
    const authenticate = vi.fn(async () => "usr_alice");
    const { hub, fetches } = fakeHub({});
    const res = await run(request, raw, options({ authenticate }, hub));
    expect(res.status).toBe(status);
    expect(authenticate).not.toHaveBeenCalled();
    expect(fetches).toHaveLength(0);
    expect(metricSubscribe).toHaveBeenCalledWith("cire", outcome);
  });

  it("answers 503 without authenticating when no hub is bound", async () => {
    const authenticate = vi.fn(async () => "usr_alice");
    const res = await run(upgradeRequest(), RAW, { ...options({ authenticate }), hub: undefined });
    expect(res.status).toBe(503);
    expect(authenticate).not.toHaveBeenCalled();
    expect(metricSubscribe).toHaveBeenCalledWith("cire", "unavailable");
  });
});

describe("subscribe — refused by the product", () => {
  it("401s a caller with no session", async () => {
    const res = await run(upgradeRequest(), RAW, options({ authenticate: async () => null }));
    expect(res.status).toBe(401);
    expect(metricSubscribe).toHaveBeenCalledWith("cire", "unauthenticated");
  });

  it("429s a rate-limited caller before checking membership", async () => {
    const authorize = vi.fn(async () => true);
    const res = await run(upgradeRequest(), RAW, options({ allow: async () => false, authorize }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("60");
    expect(authorize).not.toHaveBeenCalled();
    expect(metricSubscribe).toHaveBeenCalledWith("cire", "rate_limited");
  });

  it("keys the rate limit on the subject", async () => {
    const allow = vi.fn(async () => true);
    await run(upgradeRequest(), RAW, options({ allow }));
    expect(allow).toHaveBeenCalledWith("usr_alice");
  });

  it("403s a caller who is not a member, and never reaches the hub", async () => {
    const { hub, fetches } = fakeHub({});
    const res = await run(upgradeRequest(), RAW, options({ authorize: async () => false }, hub));
    expect(res.status).toBe(403);
    expect(fetches).toHaveLength(0);
    expect(metricSubscribe).toHaveBeenCalledWith("cire", "denied");
  });

  it("passes the parsed topic to the membership check", async () => {
    const authorize = vi.fn(async () => true);
    await run(upgradeRequest(), RAW, options({ authorize }));
    expect(authorize).toHaveBeenCalledWith("usr_alice", {
      product: "cire",
      entity: "wedding",
      id: "wed_1",
    });
  });
});

describe("subscribe — failures answer 503 and never throw", () => {
  it.each([
    ["authenticate throws", { authenticate: async () => Promise.reject(new Error("d1 down")) }],
    ["the limiter throws", { allow: async () => Promise.reject(new Error("binding gone")) }],
    [
      "the membership check throws",
      { authorize: async () => Promise.reject(new Error("d1 down")) },
    ],
    [
      "acceptsTopic throws (a defect)",
      {
        acceptsTopic: () => {
          throw new Error("bug");
        },
      },
    ],
  ])("when %s", async (_label, overrides) => {
    const res = await run(upgradeRequest(), RAW, options(overrides as Partial<SubscribeOptions>));
    expect(res.status).toBe(503);
    expect(metricSubscribe).toHaveBeenCalledWith("cire", "unavailable");
  });

  it("when the hub's fetch rejects", async () => {
    const { hub } = fakeHub({ fetch: () => Promise.reject(new Error("over quota")) });
    const res = await run(upgradeRequest(), RAW, options({}, hub));
    expect(res.status).toBe(503);
  });

  it("when the hub answers anything but 101", async () => {
    const { hub } = fakeHub({ fetch: async () => new Response(null, { status: 400 }) });
    const res = await run(upgradeRequest(), RAW, options({}, hub));
    expect(res.status).toBe(503);
    expect(metricSubscribe).toHaveBeenCalledWith("cire", "unavailable");
  });
});
