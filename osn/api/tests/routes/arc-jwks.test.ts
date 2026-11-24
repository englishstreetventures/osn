import { arcOutboundKeys } from "@osn/db/schema";
import { Layer, Logger } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApp } from "../../src/app";
import { buildAppDeps } from "../../src/build-deps";
import { createInMemoryCoordination } from "../../src/lib/coordination/memory";
import { _resetOutboundKeyForTests } from "../../src/lib/outbound-arc";
import { createArcJwksRoutes as createArcJwksRoutesRaw } from "../../src/routes/arc-jwks";
import { memoryLimiter, MINUTE_MS, OSN_RATE_LIMITS } from "../../src/routes/auth/limiters";
import {
  createCapturingTestLayer,
  createTestLayer,
  createTestLayerWithSqlite,
} from "../helpers/db";
import { createArcJwksRoutes } from "../helpers/routes";

/**
 * `GET /.well-known/arc-jwks.json` serves exactly the outbound keys osn-api
 * may still sign with, read fresh, as a JWK Set apps can import.
 */

afterEach(() => {
  _resetOutboundKeyForTests();
  vi.restoreAllMocks();
});

describe("GET /.well-known/arc-jwks.json", () => {
  it("lists unexpired keys with kid, alg and use, never a private member or a row that is no EC key, and is never cached", async () => {
    const { layer, db } = createTestLayerWithSqlite();
    const now = Math.floor(Date.now() / 1000);
    const jwk = JSON.stringify({ kty: "EC", crv: "P-256", x: "xx", y: "yy", d: "secret" });
    await db.insert(arcOutboundKeys).values([
      { keyId: "live", publicKeyJwk: jwk, createdAt: now, expiresAt: now + 3600 },
      { keyId: "gone", publicKeyJwk: jwk, createdAt: now - 90_000, expiresAt: now - 1 },
      { keyId: "broken", publicKeyJwk: "{not json", createdAt: now, expiresAt: now + 3600 },
    ]);
    const app = createArcJwksRoutes(layer);

    const res = await app.handle(new Request("http://localhost/.well-known/arc-jwks.json"));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = (await res.json()) as { keys: Record<string, unknown>[] };
    expect(body.keys).toEqual([
      { kty: "EC", crv: "P-256", x: "xx", y: "yy", kid: "live", alg: "ES256", use: "sig" },
    ]);
  });

  it("shows a key written a moment ago on the next request", async () => {
    const { layer, db } = createTestLayerWithSqlite();
    const app = createArcJwksRoutes(layer);
    const get = async () =>
      (
        (await (
          await app.handle(new Request("http://localhost/.well-known/arc-jwks.json"))
        ).json()) as {
          keys: unknown[];
        }
      ).keys;
    expect(await get()).toEqual([]);
    const now = Math.floor(Date.now() / 1000);
    await db.insert(arcOutboundKeys).values({
      keyId: "new",
      publicKeyJwk: JSON.stringify({ kty: "EC", crv: "P-256", x: "xx", y: "yy" }),
      createdAt: now,
      expiresAt: now + 3600,
    });
    expect(await get()).toHaveLength(1);
  });
});

/**
 * The route is public, so each caller's address has two budgets: 30 a minute,
 * refused at the edge, and 60 an hour, which bounds the reads one address can
 * cost. The apps' fetch pattern stays far inside both.
 */
describe("GET /.well-known/arc-jwks.json — the caller's budgets", () => {
  /** The address every Worker's cross-zone subrequest arrives from. */
  const WORKER_ADDRESS = "2a06:98c0:3600::103";

  const limited = (layer: Parameters<typeof createArcJwksRoutesRaw>[0]) =>
    createArcJwksRoutesRaw(
      layer,
      undefined,
      undefined,
      {
        minute: memoryLimiter(OSN_RATE_LIMITS.arcJwksIp),
        hour: memoryLimiter(OSN_RATE_LIMITS.arcJwksIpHour),
      },
      { trustCloudflare: true },
    );

  const get = (app: ReturnType<typeof limited>, address?: string) =>
    app.handle(
      new Request("http://localhost/.well-known/arc-jwks.json", {
        headers: address === undefined ? {} : { "cf-connecting-ip": address },
      }),
    );

  const keyReads = (captured: ReadonlyArray<{ sql: string }>) =>
    captured.filter((statement) => statement.sql.startsWith("select")).length;

  it("never refuses the apps' pattern: a cold start, a fetch every five minutes, a fan-out wave", async () => {
    const { layer } = createTestLayerWithSqlite();
    const app = limited(layer);
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    const statuses: number[] = [];
    const burst = async (count: number) => {
      for (let i = 0; i < count; i++) {
        // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
        statuses.push((await get(app, WORKER_ADDRESS)).status);
      }
    };
    await burst(8);
    for (let minute = 5; minute <= 55; minute += 5) {
      clock.mockReturnValue(start + minute * MINUTE_MS);
      // eslint-disable-next-line no-await-in-loop -- one fetch at a time
      await burst(minute === 30 ? 9 : 1);
    }
    expect(statuses).toHaveLength(8 + 10 + 9);
    expect(statuses.every((status) => status === 200)).toBe(true);
  });

  it("refuses the request past 30 in a minute without reading a key, and serves another address", async () => {
    const { layer, captured } = createCapturingTestLayer();
    const app = limited(layer);
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    for (let i = 0; i < OSN_RATE_LIMITS.arcJwksIp.maxRequests; i++) {
      // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
      expect((await get(app, "203.0.113.7")).status).toBe(200);
    }
    const reads = keyReads(captured);
    const over = await get(app, "203.0.113.7");
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: "rate_limited" });
    expect(keyReads(captured)).toBe(reads);
    expect((await get(app, "203.0.113.8")).status).toBe(200);
  });

  it("refuses the request past 60 in an hour, though no minute passed 30", async () => {
    const { layer } = createTestLayerWithSqlite();
    const app = limited(layer);
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    // A window ends strictly after its length, so each minute here is 61 s.
    const minute = MINUTE_MS + 1_000;
    for (let m = 0; m < 3; m++) {
      clock.mockReturnValue(start + m * minute);
      for (let i = 0; i < 20; i++) {
        // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
        expect((await get(app, "203.0.113.9")).status).toBe(200);
      }
    }
    clock.mockReturnValue(start + 3 * minute);
    expect((await get(app, "203.0.113.9")).status).toBe(429);
  });

  it("refuses a request whose address cannot be resolved", async () => {
    const { layer } = createTestLayerWithSqlite();
    const app = createArcJwksRoutesRaw(layer);
    expect((await get(app)).status).toBe(429);
  });
});

/**
 * In production every Worker's subrequest to another zone arrives from one
 * address, so the apps' fetches are budgeted under their own zone, which
 * another tenant's Worker or a direct caller cannot use.
 */
describe("GET /.well-known/arc-jwks.json — the apps' own budget", () => {
  const WORKER_ADDRESS = "2a06:98c0:3600::103";
  const APP_HOSTS = ["api.cire.example", "zap.cire.example"];

  const app = (layer: Parameters<typeof createArcJwksRoutesRaw>[0], trustCloudflare = true) =>
    createArcJwksRoutesRaw(
      layer,
      undefined,
      undefined,
      {
        minute: memoryLimiter(OSN_RATE_LIMITS.arcJwksIp),
        hour: memoryLimiter(OSN_RATE_LIMITS.arcJwksIpHour),
      },
      { trustCloudflare },
      APP_HOSTS,
    );

  const get = (routes: ReturnType<typeof app>, headers: Record<string, string>): Promise<number> =>
    routes
      .handle(new Request("http://localhost/.well-known/arc-jwks.json", { headers }))
      .then((res) => res.status);

  const spend = async (routes: ReturnType<typeof app>, headers: Record<string, string>) => {
    for (let i = 0; i < OSN_RATE_LIMITS.arcJwksIp.maxRequests; i++) {
      // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
      await get(routes, headers);
    }
  };

  it("serves an app after another tenant's Worker spent the shared address's budget", async () => {
    const { layer } = createTestLayerWithSqlite();
    const routes = app(layer);
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const stranger = { "cf-connecting-ip": WORKER_ADDRESS, "cf-worker": "stranger.example" };
    await spend(routes, stranger);
    expect(await get(routes, stranger)).toBe(429);
    expect(
      await get(routes, { "cf-connecting-ip": WORKER_ADDRESS, "cf-worker": "cire.example" }),
    ).toBe(200);
  });

  it("refuses the apps past their own minute budget", async () => {
    const { layer } = createTestLayerWithSqlite();
    const routes = app(layer);
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const apps = { "cf-connecting-ip": WORKER_ADDRESS, "cf-worker": "cire.example" };
    await spend(routes, apps);
    expect(await get(routes, apps)).toBe(429);
  });

  it("budgets a direct caller naming an app's zone by its own address", async () => {
    const { layer } = createTestLayerWithSqlite();
    const routes = app(layer);
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const direct = { "cf-connecting-ip": "203.0.113.20", "cf-worker": "cire.example" };
    await spend(routes, direct);
    expect(await get(routes, direct)).toBe(429);
    expect(
      await get(routes, { "cf-connecting-ip": WORKER_ADDRESS, "cf-worker": "cire.example" }),
    ).toBe(200);
  });

  it("gives no lane to a shared platform zone or a zone no app is under", async () => {
    const { layer } = createTestLayerWithSqlite();
    const routes = createArcJwksRoutesRaw(
      layer,
      undefined,
      undefined,
      {
        minute: memoryLimiter(OSN_RATE_LIMITS.arcJwksIp),
        hour: memoryLimiter(OSN_RATE_LIMITS.arcJwksIpHour),
      },
      { trustCloudflare: true },
      ["cire-api.tenant.workers.dev"],
    );
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const platform = { "cf-connecting-ip": WORKER_ADDRESS, "cf-worker": "workers.dev" };
    await spend(routes, platform);
    // The shared address's budget is spent, whatever zone a Worker names.
    expect(await get(routes, platform)).toBe(429);
    expect(
      await get(routes, { "cf-connecting-ip": WORKER_ADDRESS, "cf-worker": "other.example" }),
    ).toBe(429);
  });

  it("serves an app's fetch that carries no client address, and gives no lane off Cloudflare", async () => {
    const { layer } = createTestLayerWithSqlite();
    expect(await get(app(layer), { "cf-worker": "cire.example" })).toBe(200);
    expect(await get(app(layer, false), { "cf-worker": "cire.example" })).toBe(429);
  });
});

/**
 * What an operator sees, and how an address is counted: an IPv6 caller is
 * budgeted by its /64; each refusal is logged once a minute per lane, with
 * the budget that refused it; a limiter that fails refuses.
 */
describe("GET /.well-known/arc-jwks.json — counting and seeing refusals", () => {
  type Line = { message: unknown; annotations?: unknown };
  const keep = (lines: Line[]) =>
    Logger.layer([Logger.map(Logger.formatStructured, (line) => void lines.push(line as Line))]);

  const routes = (
    layer: Parameters<typeof createArcJwksRoutesRaw>[0],
    lines: Line[] = [],
    limiters = {
      minute: memoryLimiter(OSN_RATE_LIMITS.arcJwksIp),
      hour: memoryLimiter(OSN_RATE_LIMITS.arcJwksIpHour),
    },
  ) =>
    createArcJwksRoutesRaw(layer, keep(lines), undefined, limiters, { trustCloudflare: true }, [
      "api.cire.example",
    ]);

  const status = (app: ReturnType<typeof routes>, headers: Record<string, string>) =>
    app
      .handle(new Request("http://localhost/.well-known/arc-jwks.json", { headers }))
      .then((res) => res.status);

  const refusals = (lines: Line[]) =>
    lines.filter((line) => JSON.stringify(line.message).includes("refused a caller"));

  it("counts every address in one IPv6 /64 against one budget", async () => {
    const { layer } = createTestLayerWithSqlite();
    const app = routes(layer);
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    for (let i = 0; i < OSN_RATE_LIMITS.arcJwksIp.maxRequests; i++) {
      // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
      await status(app, { "cf-connecting-ip": `2001:db8:1:2::${(i + 1).toString(16)}` });
    }
    expect(await status(app, { "cf-connecting-ip": "2001:db8:1:2::ffff" })).toBe(429);
    expect(await status(app, { "cf-connecting-ip": "2001:db8:1:3::1" })).toBe(200);
  });

  it("logs the first refusal in a minute per lane, with the budget that refused it", async () => {
    const { layer } = createTestLayerWithSqlite();
    const lines: Line[] = [];
    const app = routes(layer, lines);
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const direct = { "cf-connecting-ip": "203.0.113.30" };
    for (let i = 0; i < OSN_RATE_LIMITS.arcJwksIp.maxRequests + 2; i++) {
      // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
      await status(app, direct);
    }
    await vi.waitFor(() => expect(refusals(lines)).toHaveLength(1));
    expect(JSON.stringify(refusals(lines)[0])).toContain("address");
    expect(JSON.stringify(refusals(lines)[0])).toContain("minute");
  });

  it("refuses, and says so, when a limiter fails", async () => {
    const { layer } = createTestLayerWithSqlite();
    const lines: Line[] = [];
    const failing = {
      check: () => {
        throw new Error("store down");
      },
    };
    const app = routes(layer, lines, { minute: failing, hour: failing });
    expect(await status(app, { "cf-connecting-ip": "203.0.113.31" })).toBe(429);
    await vi.waitFor(() => expect(refusals(lines)).toHaveLength(1));
    expect(JSON.stringify(refusals(lines)[0])).toContain("minute");
  });
});

/**
 * Which zone is an app's, which budget is asked first, and what an isolate
 * remembers: the edges a lane or a budget can get wrong without the tests
 * above noticing.
 */
describe("GET /.well-known/arc-jwks.json — lanes and budgets at their edges", () => {
  const WORKER_ADDRESS = "2a06:98c0:3600::103";

  /** A limiter on `budget` that counts the checks it is asked. */
  const counted = (budget: Parameters<typeof memoryLimiter>[0]) => {
    const inner = memoryLimiter(budget);
    const counter = { checks: 0 };
    return { counter, limiter: { check: (key: string) => (counter.checks++, inner.check(key)) } };
  };

  const build = (
    layer: Parameters<typeof createArcJwksRoutesRaw>[0],
    appHosts: string[],
    limiters = {
      minute: memoryLimiter(OSN_RATE_LIMITS.arcJwksIp),
      hour: memoryLimiter(OSN_RATE_LIMITS.arcJwksIpHour),
    },
    lines: { message: unknown }[] = [],
  ) =>
    createArcJwksRoutesRaw(
      layer,
      Logger.layer([
        Logger.map(
          Logger.formatStructured,
          (line) => void lines.push(line as { message: unknown }),
        ),
      ]),
      undefined,
      limiters,
      { trustCloudflare: true },
      appHosts,
    );

  const status = (
    app: { handle: (request: Request) => Promise<Response> | Response },
    headers: Record<string, string>,
  ) =>
    Promise.resolve(
      app.handle(new Request("http://localhost/.well-known/arc-jwks.json", { headers })),
    ).then((res) => res.status);

  /** Spends the Worker address's minute budget, under a zone that is no app's. */
  const spendWorkerAddress = async (app: ReturnType<typeof build>) => {
    for (let i = 0; i < OSN_RATE_LIMITS.arcJwksIp.maxRequests; i++) {
      // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
      await status(app, { "cf-connecting-ip": WORKER_ADDRESS, "cf-worker": "stranger.example" });
    }
  };

  it("takes a zone as an app's only on a label boundary, and reads the header loosely", async () => {
    const { layer } = createTestLayerWithSqlite();
    const app = build(layer, ["api.cire.example", "zap.example"]);
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    await spendWorkerAddress(app);
    const from = (zone: string) =>
      status(app, { "cf-connecting-ip": WORKER_ADDRESS, "cf-worker": zone });
    expect(await from("ire.example")).toBe(429);
    expect(await from("example")).toBe(429);
    expect(await from("pages.dev")).toBe(429);
    expect(await from(" CIRE.Example ")).toBe(200);
    // An app on its zone's own apex host.
    expect(await from("zap.example")).toBe(200);
  });

  it("asks the minute budget first, so a refused flood never reaches the hour one", async () => {
    const { layer } = createTestLayerWithSqlite();
    const hour = counted(OSN_RATE_LIMITS.arcJwksIpHour);
    const app = build(layer, [], {
      minute: memoryLimiter(OSN_RATE_LIMITS.arcJwksIp),
      hour: hour.limiter,
    });
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    for (let i = 0; i < OSN_RATE_LIMITS.arcJwksIp.maxRequests + 10; i++) {
      // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
      await status(app, { "cf-connecting-ip": "203.0.113.40" });
    }
    expect(hour.counter.checks).toBe(OSN_RATE_LIMITS.arcJwksIp.maxRequests);
  });

  it("remembers an hour refusal for a minute instead of asking the store again", async () => {
    const { layer } = createTestLayerWithSqlite();
    const hour = counted(OSN_RATE_LIMITS.arcJwksIpHour);
    const app = build(layer, [], {
      minute: memoryLimiter(OSN_RATE_LIMITS.arcJwksIp),
      hour: hour.limiter,
    });
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    const minute = MINUTE_MS + 1_000;
    const caller = { "cf-connecting-ip": "203.0.113.41" };
    for (let m = 0; m < 3; m++) {
      clock.mockReturnValue(start + m * minute);
      for (let i = 0; i < 20; i++) {
        // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
        await status(app, caller);
      }
    }
    clock.mockReturnValue(start + 3 * minute);
    expect(await status(app, caller)).toBe(429);
    const asked = hour.counter.checks;
    expect(await status(app, caller)).toBe(429);
    expect(hour.counter.checks).toBe(asked);
    clock.mockReturnValue(start + 4 * minute);
    expect(await status(app, caller)).toBe(429);
    expect(hour.counter.checks).toBe(asked + 1);
  });

  it("logs each lane's first refusal in a minute, and again once the minute has passed", async () => {
    const { layer } = createTestLayerWithSqlite();
    const lines: { message: unknown }[] = [];
    const app = build(layer, ["api.cire.example"], undefined, lines);
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    const refusals = () =>
      lines.filter((line) => JSON.stringify(line.message).includes("refused a caller"));
    const appFetch = { "cf-connecting-ip": WORKER_ADDRESS, "cf-worker": "cire.example" };
    const direct = { "cf-connecting-ip": "203.0.113.42" };
    for (let i = 0; i <= OSN_RATE_LIMITS.arcJwksIp.maxRequests; i++) {
      // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
      await status(app, appFetch);
      // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
      await status(app, direct);
    }
    await vi.waitFor(() => expect(refusals()).toHaveLength(2));
    clock.mockReturnValue(start + MINUTE_MS + 1_000);
    for (let i = 0; i <= OSN_RATE_LIMITS.arcJwksIp.maxRequests; i++) {
      // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
      await status(app, direct);
    }
    await vi.waitFor(() => expect(refusals()).toHaveLength(3));
  });

  it("gets the app hosts from the deletion app URLs when the app is built", async () => {
    const built = await buildAppDeps(
      { OSN_ISSUER_URL: "http://localhost:4000", CIRE_API_URL: "https://api.cire.example" },
      {
        coordination: () => createInMemoryCoordination(),
        dbAndEmailLayer: createTestLayer(),
        observabilityLayer: Layer.empty,
        includeObservabilityPlugin: false,
        trustCloudflare: true,
      },
    );
    const app = createApp(built.deps);
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    for (let i = 0; i < OSN_RATE_LIMITS.arcJwksIp.maxRequests; i++) {
      // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
      await status(app, { "cf-connecting-ip": WORKER_ADDRESS, "cf-worker": "stranger.example" });
    }
    expect(
      await status(app, { "cf-connecting-ip": WORKER_ADDRESS, "cf-worker": "cire.example" }),
    ).toBe(200);
  });
});
