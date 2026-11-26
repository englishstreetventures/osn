import { arcOutboundKeys } from "@osn/db/schema";
import { mintArcKid, type ArcKidSecrets } from "@shared/crypto/arc-kid";
import { exportKeyToJwk, generateArcKeyPair, signArcToken } from "@shared/crypto/jwk";
import { verifyOsnArcToken } from "@shared/osn-auth-client/arc";
import { clearJwksCache } from "@shared/osn-auth-client/jwks-cache";
import { eq } from "drizzle-orm";
import { Effect, Logger } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  _resetOutboundKeyForTests,
  arcAuthHeader,
  publishOutboundKey,
} from "../../src/lib/outbound-arc";
import { KEY_MEMORY_MAX } from "../../src/lib/outbound-key-memory";
import { createArcJwksRoutes } from "../../src/routes/arc-jwks";
import { memoryLimiter, MINUTE_MS, OSN_RATE_LIMITS } from "../../src/routes/auth/limiters";
import { createCapturingTestLayer } from "../helpers/db";

/**
 * `GET /.well-known/arc-jwks.json?kid=<kid>`: an app asks osn-api for the one
 * key a token names. osn-api checks the kid's MACs itself, answers a kid it
 * can verify from memory, reads the database for it at most once a minute per
 * isolate, and keeps no budget a sender can spend through an app. Every read
 * here is counted: what the guarantee bounds is the database reads and the
 * fetches a sender can cause.
 */

const SERVICE_SECRET = "test-internal-secret-of-32-chars!";
const KID_SECRET = "kid-secret-kid-secret-kid-secret-kid";
const OTHER_SERVICE_SECRET = "another-internal-secret-of-32-chars";

/** What osn-api or an app can hold, named by the rollout state table. */
const HOLDS = {
  nothing: { kidSecret: undefined, serviceSecret: undefined },
  "the service secret": { kidSecret: undefined, serviceSecret: SERVICE_SECRET },
  "the kid secret": { kidSecret: KID_SECRET, serviceSecret: undefined },
  "both secrets": { kidSecret: KID_SECRET, serviceSecret: SERVICE_SECRET },
} as const satisfies Record<string, ArcKidSecrets>;
type Holds = keyof typeof HOLDS;

/** The address every Worker's cross-zone subrequest arrives from. */
const WORKER_ADDRESS = "2a06:98c0:3600::103";
const APP = { "cf-connecting-ip": WORKER_ADDRESS, "cf-worker": "cire.example" };
const ADDRESS = { "cf-connecting-ip": "203.0.113.50" };

type Line = { message: unknown; annotations?: unknown };

/** A limiter on `budget` that counts the checks it is asked. */
function counted(budget: Parameters<typeof memoryLimiter>[0]) {
  const inner = memoryLimiter(budget);
  const counter = { checks: 0 };
  return {
    counter,
    limiter: { check: (key: string) => (counter.checks++, inner.check(key)) },
  };
}

/** osn-api's key routes on a fresh database, isolate memory and limiters, holding `osnHolds`. */
function osnApi(osnHolds: ArcKidSecrets = HOLDS["both secrets"]) {
  const { layer, db, captured } = createCapturingTestLayer();
  const lines: Line[] = [];
  const minute = counted(OSN_RATE_LIMITS.arcJwksIp);
  const hour = counted(OSN_RATE_LIMITS.arcJwksIpHour);
  const routes = createArcJwksRoutes(
    layer,
    Logger.layer([Logger.map(Logger.formatStructured, (line) => void lines.push(line as Line))]),
    undefined,
    { minute: minute.limiter, hour: hour.limiter },
    { trustCloudflare: true },
    ["api.cire.example"],
    osnHolds,
  );
  /** Reads of one key by id: the only statement the key-by-id path runs. */
  const keyReads = () =>
    captured.filter((statement) => statement.sql.includes('"arc_outbound_keys"."key_id" >='))
      .length;
  const ask = async (kid: string, headers: Record<string, string> = APP) => {
    const res = await routes.handle(
      new Request(`http://localhost/.well-known/arc-jwks.json?kid=${encodeURIComponent(kid)}`, {
        headers,
      }),
    );
    const body = res.status === 200 ? ((await res.json()) as { keys: { kid: string }[] }) : null;
    return { status: res.status, kids: body?.keys.map((key) => key.kid) ?? null };
  };
  const list = (headers: Record<string, string>) =>
    routes
      .handle(new Request("http://localhost/.well-known/arc-jwks.json", { headers }))
      .then((res) => res.status);
  /** Writes a key minted as osn-api mints one holding `minter`, and answers its kid. */
  const publish = async (minter: ArcKidSecrets = osnHolds, expiresAt = nowSec() + 3_600) => {
    const pair = await generateArcKeyPair();
    const kid = await mintArcKid(minter, expiresAt);
    await db.insert(arcOutboundKeys).values({
      keyId: kid,
      publicKeyJwk: await exportKeyToJwk(pair.publicKey),
      createdAt: nowSec(),
      expiresAt,
    });
    return kid;
  };
  return { routes, db, layer, lines, keyReads, ask, list, publish, minute, hour };
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** A kid shaped as osn-api mints one, with a MAC no secret keyed. */
const madeUp = (parts: 3 | 4 = 4) => {
  const mac = () => crypto.randomUUID().replace(/-/g, "").slice(0, 22);
  return [
    crypto.randomUUID(),
    String(nowSec() + 3_600),
    mac(),
    ...(parts === 4 ? [mac()] : []),
  ].join(".");
};

/** `kid` with part `index` replaced by 22 base64url characters no secret keyed. */
const swapped = (kid: string, index: 2 | 3) => {
  const parts = kid.split(".");
  parts[index] = "Z".repeat(22);
  return parts.join(".");
};

afterEach(() => {
  _resetOutboundKeyForTests();
  clearJwksCache();
  vi.restoreAllMocks();
});

describe("GET /.well-known/arc-jwks.json?kid= — what is read", () => {
  it("refuses an ask no osn-api could have minted with no read and no store call, on either lane", async () => {
    const api = osnApi();
    const uuid = crypto.randomUUID();
    const mac = "A".repeat(22);
    for (const headers of [APP, ADDRESS]) {
      for (const kid of [
        "x",
        `${uuid}.${nowSec() - 1}.${mac}`,
        `${uuid}.${nowSec() + 6 * 3_600}.${mac}`,
        `${uuid}.${nowSec() + 60}.${"~".repeat(22)}`,
        `${uuid.toUpperCase()}.${nowSec() + 60}.${mac}`,
      ]) {
        expect(await api.ask(kid, headers)).toEqual({ status: 200, kids: [] });
      }
      expect((await api.ask("", headers)).status).toBe(422);
      expect((await api.ask("A".repeat(129), headers)).status).toBe(422);
    }
    expect(api.keyReads()).toBe(0);
    expect(api.hour.counter.checks).toBe(0);
  });

  it("answers a made-up kid it cannot verify by one read each, holds none, and refuses past 30 a minute per lane", async () => {
    const api = osnApi();
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    for (let i = 0; i < OSN_RATE_LIMITS.arcJwksIp.maxRequests; i++) {
      // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
      expect(await api.ask(madeUp(), APP)).toEqual({ status: 200, kids: [] });
    }
    expect(api.keyReads()).toBe(OSN_RATE_LIMITS.arcJwksIp.maxRequests);
    expect((await api.ask(madeUp(), APP)).status).toBe(429);
    expect(api.keyReads()).toBe(OSN_RATE_LIMITS.arcJwksIp.maxRequests);
    expect(api.hour.counter.checks).toBe(0);
    // The same made-up kid again is read again: nothing a sender names is held.
    const again = osnApi();
    const kid = madeUp();
    await again.ask(kid);
    await again.ask(kid);
    expect(again.keyReads()).toBe(2);
  });

  it("reads a real kid once a minute however often it is asked, and a copy with a part swapped costs nothing more", async () => {
    const api = osnApi(HOLDS["both secrets"]);
    const kid = await api.publish();
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    for (let i = 0; i < 50; i++) {
      // eslint-disable-next-line no-await-in-loop -- one ask at a time
      expect(await api.ask(kid)).toEqual({ status: 200, kids: [kid] });
    }
    expect(await api.ask(swapped(kid, 2))).toEqual({ status: 200, kids: [kid] });
    expect(await api.ask(swapped(kid, 3))).toEqual({ status: 200, kids: [kid] });
    expect(api.keyReads()).toBe(1);
    clock.mockReturnValue(start + MINUTE_MS + 1_000);
    expect(await api.ask(kid)).toEqual({ status: 200, kids: [kid] });
    expect(api.keyReads()).toBe(2);
  });

  it("finds a key written a moment ago, while it holds others", async () => {
    const api = osnApi();
    const held = await api.publish();
    await api.ask(held);
    const fresh = await api.publish();
    expect(await api.ask(fresh)).toEqual({ status: 200, kids: [fresh] });
    expect(api.keyReads()).toBe(2);
  });

  it("reads once for asks that arrive together", async () => {
    const api = osnApi();
    const kid = await api.publish();
    const answers = await Promise.all(Array.from({ length: 10 }, () => api.ask(kid)));
    expect(answers.every((a) => a.kids?.[0] === kid)).toBe(true);
    expect(api.keyReads()).toBe(1);
  });

  it("stops answering a key whose row is deleted within a minute, and holds its absence for 30 seconds", async () => {
    const api = osnApi();
    const kid = await api.publish();
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    expect(await api.ask(kid)).toEqual({ status: 200, kids: [kid] });
    await api.db.delete(arcOutboundKeys).where(eq(arcOutboundKeys.keyId, kid));
    clock.mockReturnValue(start + MINUTE_MS - 1_000);
    expect(await api.ask(kid)).toEqual({ status: 200, kids: [kid] });
    clock.mockReturnValue(start + MINUTE_MS);
    expect(await api.ask(kid)).toEqual({ status: 200, kids: [] });
    expect(api.keyReads()).toBe(2);
    clock.mockReturnValue(start + MINUTE_MS + 29_000);
    expect(await api.ask(kid)).toEqual({ status: 200, kids: [] });
    expect(api.keyReads()).toBe(2);
    clock.mockReturnValue(start + MINUTE_MS + 30_000);
    expect(await api.ask(kid)).toEqual({ status: 200, kids: [] });
    expect(api.keyReads()).toBe(3);
  });

  it("answers 500 when the read fails, holds nothing, and reads again on the next ask", async () => {
    const api = osnApi();
    const kid = await api.publish();
    vi.spyOn(api.db, "select").mockImplementationOnce(() => {
      throw new Error("D1 is down");
    });
    expect((await api.ask(kid)).status).toBe(500);
    expect(await api.ask(kid)).toEqual({ status: 200, kids: [kid] });
  });

  it("never answers a row whose expiry has passed", async () => {
    const api = osnApi();
    const kid = await api.publish();
    await api.db
      .update(arcOutboundKeys)
      .set({ expiresAt: nowSec() - 1 })
      .where(eq(arcOutboundKeys.keyId, kid));
    expect(await api.ask(kid)).toEqual({ status: 200, kids: [] });
  });

  it("answers a three-part ask with the four-part kid it stored", async () => {
    const api = osnApi(HOLDS["both secrets"]);
    const kid = await api.publish();
    const [uuid, expiry, v2, v1] = kid.split(".") as [string, string, string, string];
    expect(await api.ask(`${uuid}.${expiry}.${v2}`)).toEqual({ status: 200, kids: [kid] });
    expect(await api.ask(`${uuid}.${expiry}.${v1}`)).toEqual({ status: 200, kids: [kid] });
  });

  it("holding no secret that keys a MAC, reads on every ask and holds nothing", async () => {
    const api = osnApi(HOLDS.nothing);
    const kid = await api.publish(HOLDS.nothing);
    expect(kid.split(".")).toHaveLength(2);
    expect(await api.ask(kid)).toEqual({ status: 200, kids: [kid] });
    expect(await api.ask(kid)).toEqual({ status: 200, kids: [kid] });
    expect(api.keyReads()).toBe(2);
  });

  it(`holds at most ${KEY_MEMORY_MAX} keys, answers past that from a read, and says so once a minute`, async () => {
    const api = osnApi();
    const start = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(start);
    const kids: string[] = [];
    for (let i = 0; i <= KEY_MEMORY_MAX + 1; i++) {
      // eslint-disable-next-line no-await-in-loop -- one write at a time
      kids.push(await api.publish());
    }
    for (const kid of kids.slice(0, KEY_MEMORY_MAX)) {
      // eslint-disable-next-line no-await-in-loop -- one ask at a time
      await api.ask(kid);
    }
    expect(api.keyReads()).toBe(KEY_MEMORY_MAX);
    const over = kids[KEY_MEMORY_MAX]!;
    expect(await api.ask(over)).toEqual({ status: 200, kids: [over] });
    expect(await api.ask(over)).toEqual({ status: 200, kids: [over] });
    expect(api.keyReads()).toBe(KEY_MEMORY_MAX + 2);
    const full = () =>
      api.lines.filter((line) => JSON.stringify(line.message).includes("key memory is full"));
    await vi.waitFor(() => expect(full()).toHaveLength(1));
    // Once the held keys lapse they make room again.
    clock.mockReturnValue(start + MINUTE_MS + 1_000);
    const last = kids[KEY_MEMORY_MAX + 1]!;
    await api.ask(last);
    await api.ask(last);
    expect(api.keyReads()).toBe(KEY_MEMORY_MAX + 3);
  });
});

describe("GET /.well-known/arc-jwks.json?kid= — budgets", () => {
  it("answers an app by kid after its zone's list budgets and its probe budget are spent, and asks the store nothing", async () => {
    const api = osnApi();
    const kid = await api.publish();
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    for (let i = 0; i < OSN_RATE_LIMITS.arcJwksIp.maxRequests; i++) {
      // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
      await api.list(APP);
      // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
      await api.ask(madeUp(), APP);
    }
    expect(await api.list(APP)).toBe(429);
    expect((await api.ask(madeUp(), APP)).status).toBe(429);
    const checks = api.hour.counter.checks;
    for (let i = 0; i < 100; i++) {
      // eslint-disable-next-line no-await-in-loop -- one ask at a time
      expect(await api.ask(kid, APP)).toEqual({ status: 200, kids: [kid] });
    }
    expect(api.hour.counter.checks).toBe(checks);
  });

  it("budgets a direct caller's asks at 30 a minute by its address, never asking the store, and refuses one with no address", async () => {
    const api = osnApi();
    const kid = await api.publish();
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    for (let i = 0; i < OSN_RATE_LIMITS.arcJwksIp.maxRequests; i++) {
      // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
      expect((await api.ask(kid, ADDRESS)).status).toBe(200);
    }
    expect((await api.ask(kid, ADDRESS)).status).toBe(429);
    expect((await api.ask(kid, { "cf-connecting-ip": "203.0.113.51" })).status).toBe(200);
    expect((await api.ask(kid, {})).status).toBe(429);
    expect(api.hour.counter.checks).toBe(0);
  });

  it("gives every address one hour budget for the whole list, and each app zone its own", async () => {
    const api = osnApi();
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const statuses: number[] = [];
    for (const address of ["203.0.113.60", "203.0.113.61", "203.0.113.62"]) {
      for (let i = 0; i < OSN_RATE_LIMITS.arcJwksIp.maxRequests; i++) {
        // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
        statuses.push(await api.list({ "cf-connecting-ip": address }));
      }
    }
    const hour = OSN_RATE_LIMITS.arcJwksIpHour.maxRequests;
    expect(statuses.slice(0, hour).every((status) => status === 200)).toBe(true);
    expect(statuses.slice(hour).every((status) => status === 429)).toBe(true);
    expect(await api.list(APP)).toBe(200);
  });
});

/**
 * osn-api signs a call to an app with its real outbound key, and the app
 * verifies it as Pulse, Zap and cire-api do, with `verifyOsnArcToken`, asking
 * osn-api's key route over HTTP. Each cell counts the app's fetches and
 * osn-api's reads.
 */
describe("an app verifying osn-api's calls by asking for one key", () => {
  const AUDIENCE = "zap-api";
  const SCOPE = "account:erase";

  let stops: (() => void)[] = [];
  beforeEach(() => {
    stops = [];
    clearJwksCache();
  });
  afterEach(() => {
    for (const stop of stops) stop();
  });

  /**
   * osn-api's key route over HTTP, and the requests it served. Each request
   * arrives as from `from` (a direct caller's address unless told otherwise).
   */
  function serve(
    api: ReturnType<typeof osnApi>,
    options: { ignoreKid?: boolean; from?: Record<string, string> } = {},
  ) {
    let fetches = 0;
    const server = Bun.serve({
      port: 0,
      fetch: (request) => {
        fetches += 1;
        const url = new URL(request.url);
        // No kid reaches the route: an app on the code before key-by-id asks
        // for none, and an osn-api on that code reads none.
        if (options.ignoreKid) url.search = "";
        return api.routes.handle(
          new Request(url.toString(), { headers: { ...(options.from ?? ADDRESS) } }),
        );
      },
    });
    stops.push(() => void server.stop(true));
    return { issuer: `http://localhost:${server.port}`, fetches: () => fetches };
  }

  /** An osn-api route with budgets no test here reaches. */
  function roomyApi(osnHolds: ArcKidSecrets) {
    const api = osnApi(osnHolds);
    const roomy = { store: "arc.test", maxRequests: 100_000, windowMs: MINUTE_MS } as const;
    const routes = createArcJwksRoutes(
      api.layer,
      undefined,
      undefined,
      { minute: memoryLimiter(roomy), hour: memoryLimiter(roomy) },
      { trustCloudflare: true },
      [],
      osnHolds,
    );
    return { ...api, routes };
  }

  /** osn-api's real signer, as an isolate holding `osnHolds`: publish, then sign. */
  const signed = async (api: ReturnType<typeof osnApi>, osnHolds: ArcKidSecrets) => {
    const key = await Effect.runPromise(
      publishOutboundKey(osnHolds).pipe(Effect.provide(api.layer)),
    );
    return { header: await arcAuthHeader(key, AUDIENCE, SCOPE), kid: key.keyId };
  };

  const verify = (header: string, issuer: string, appHolds: ArcKidSecrets) =>
    verifyOsnArcToken(
      header,
      { osnIssuer: issuer, ...appHolds },
      { audience: AUDIENCE, scope: SCOPE, allowedScopes: new Set([SCOPE]) },
    );

  const cells: readonly (readonly [Holds, Holds, boolean])[] = [
    ["the service secret", "nothing", true],
    ["the service secret", "the service secret", true],
    ["the service secret", "the kid secret", false],
    ["the service secret", "both secrets", true],
    ["both secrets", "nothing", true],
    ["both secrets", "the service secret", true],
    ["both secrets", "the kid secret", true],
    ["both secrets", "both secrets", true],
  ];

  it.each(cells)(
    "osn-api holding %s, an app holding %s: admitted %s, as the rollout table says",
    async (osnHolds, appHolds, admitted) => {
      const api = roomyApi(HOLDS[osnHolds]);
      const { issuer, fetches } = serve(api);
      const { header } = await signed(api, HOLDS[osnHolds]);
      expect((await verify(header, issuer, HOLDS[appHolds])).ok).toBe(admitted);
      expect(fetches()).toBe(admitted ? 1 : 0);
    },
  );

  it.each(["nothing", "the service secret", "the kid secret", "both secrets"] as const)(
    "an app holding %s: made-up kids cost osn-api no budget and at most one read each; a real kid replayed at twenty app isolates costs one read",
    async (appHolds) => {
      const api = roomyApi(HOLDS["both secrets"]);
      const { issuer, fetches } = serve(api);
      const real = await signed(api, HOLDS["both secrets"]);
      const reads = api.keyReads();

      const pair = await generateArcKeyPair();
      for (let i = 0; i < 10; i++) {
        const kid = madeUp();
        // eslint-disable-next-line no-await-in-loop -- one token at a time
        const header = `ARC ${await signArcToken(pair.privateKey, { iss: "osn-api", aud: AUDIENCE, scope: SCOPE, kid })}`;
        // eslint-disable-next-line no-await-in-loop -- one verdict at a time
        expect((await verify(header, issuer, HOLDS[appHolds])).ok).toBe(false);
      }
      // An app holding a secret refuses before it asks; one holding none asks,
      // and osn-api reads once for each, holding none.
      const askedForMadeUp = appHolds === "nothing" ? 10 : 0;
      expect(fetches()).toBe(askedForMadeUp);
      expect(api.keyReads() - reads).toBe(askedForMadeUp);

      for (let isolate = 0; isolate < 20; isolate++) {
        clearJwksCache();
        // eslint-disable-next-line no-await-in-loop -- one app isolate at a time
        expect((await verify(real.header, issuer, HOLDS[appHolds])).ok).toBe(true);
      }
      expect(fetches()).toBe(askedForMadeUp + 20);
      expect(api.keyReads() - reads).toBe(askedForMadeUp + 1);

      // A key another isolate wrote a moment ago verifies at once.
      _resetOutboundKeyForTests();
      const fresh = await signed(api, HOLDS["both secrets"]);
      expect(fresh.kid).not.toBe(real.kid);
      expect((await verify(fresh.header, issuer, HOLDS[appHolds])).ok).toBe(true);
    },
  );

  it.each([
    [
      "minted holding both secrets, asked of an isolate holding the service secret alone",
      HOLDS["both secrets"],
      HOLDS["the service secret"],
      ["nothing", "the service secret", "the kid secret", "both secrets"],
    ],
    [
      "minted under one service secret, asked of an isolate holding another",
      HOLDS["the service secret"],
      { kidSecret: undefined, serviceSecret: OTHER_SERVICE_SECRET },
      ["nothing"],
    ],
  ] as const)("a key %s still verifies", async (_label, minter, routeHolds, appStates) => {
    const api = roomyApi(routeHolds);
    const { issuer } = serve(api);
    const { header } = await signed(api, minter);
    for (const appHolds of appStates) {
      clearJwksCache();
      // eslint-disable-next-line no-await-in-loop -- one app at a time
      expect({ appHolds, ok: (await verify(header, issuer, HOLDS[appHolds])).ok }).toEqual({
        appHolds,
        ok: true,
      });
    }
  });

  it("refuses no real call once strangers spend the whole list's shared hour budget", async () => {
    // osn-api's real budgets. Only an app on the code before key-by-id reads
    // the whole list, and it arrives in the app lane; an app on this code asks
    // by kid, which no hour budget covers, from whichever lane it arrives in.
    const api = osnApi(HOLDS["the service secret"]);
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    for (const address of ["203.0.113.70", "203.0.113.71", "203.0.113.72"]) {
      for (let i = 0; i < OSN_RATE_LIMITS.arcJwksIp.maxRequests; i++) {
        // eslint-disable-next-line no-await-in-loop -- a window counts hits in order
        await api.list({ "cf-connecting-ip": address });
      }
    }
    expect(await api.list({ "cf-connecting-ip": "203.0.113.73" })).toBe(429);
    const { header } = await signed(api, HOLDS["the service secret"]);
    const verdict = async (from: Record<string, string>, ignoreKid: boolean) => {
      clearJwksCache();
      const { issuer } = serve(api, { from, ignoreKid });
      return (await verify(header, issuer, HOLDS.nothing)).ok;
    };
    // An app on this code, in the app lane and in the address lane.
    expect(await verdict(APP, false)).toBe(true);
    expect(await verdict({ "cf-connecting-ip": "203.0.113.74" }, false)).toBe(true);
    // An app on the code before key-by-id, in the app lane: its zone's own budget.
    expect(await verdict(APP, true)).toBe(true);
  });

  it.each(["nothing", "the service secret", "the kid secret", "both secrets"] as const)(
    "an app holding %s verifies against an osn-api that ignores the kid and answers the whole list",
    async (appHolds) => {
      const api = roomyApi(HOLDS["both secrets"]);
      const { issuer } = serve(api, { ignoreKid: true });
      await api.publish();
      const { header } = await signed(api, HOLDS["both secrets"]);
      expect((await verify(header, issuer, HOLDS[appHolds])).ok).toBe(true);
    },
  );
});
