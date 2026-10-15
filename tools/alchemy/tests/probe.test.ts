import { describe, expect, test } from "bun:test";

import { PROBE } from "../boundary.ts";
import probe, { MIN_PROBE_TOKEN_LENGTH, sameDigest, tokensMatch, type ProbeEnv } from "../probe.ts";

type Bucket = NonNullable<ProbeEnv["SHEETS"]>;

function database(row: { ok: number } | null, queries: string[]): ProbeEnv["DB"] {
  return {
    prepare(query: string) {
      queries.push(query);
      return {
        async first<T>() {
          return row as T | null;
        },
      };
    },
  };
}

function throwingDatabase(): ProbeEnv["DB"] {
  return {
    prepare() {
      return {
        async first<T>(): Promise<T | null> {
          throw new Error("D1 unavailable");
        },
      };
    },
  };
}

function bucket(limits: number[]): Bucket {
  return {
    async list({ limit }) {
      limits.push(limit);
      return { objects: [] };
    },
  };
}

// A limiter whose every call is recorded: the probe checks the binding exists
// and must never spend a request from the shared dev counter.
function limiter(calls: string[]): object {
  return {
    limit(options: { key: string }) {
      calls.push(options.key);
      return Promise.resolve({ success: true });
    },
  };
}

const token = "t".repeat(MIN_PROBE_TOKEN_LENGTH);
const healthRequest = (authorization = `Bearer ${token}`) =>
  new Request("https://probe.example/health", { headers: { authorization } });

function osnEnv(overrides: Partial<ProbeEnv> = {}): ProbeEnv {
  return {
    PROBE_PRODUCT: "osn",
    PROBE_TOKEN: token,
    DB: database({ ok: 1 }, []),
    RL_AUTH_IP_5_60: limiter([]),
    ...overrides,
  };
}

function cireEnv(overrides: Partial<ProbeEnv> = {}): ProbeEnv {
  return {
    PROBE_PRODUCT: "cire",
    PROBE_TOKEN: token,
    DB: database({ ok: 1 }, []),
    SHEETS: bucket([]),
    ASSETS: bucket([]),
    IMAGES: {},
    CLAIM_RATE_LIMITER: limiter([]),
    ...overrides,
  };
}

describe("Alchemy dev probe", () => {
  test("only GET /health is exposed, before any token check", async () => {
    const unconfigured = {} as ProbeEnv;
    const post = await probe.fetch(
      new Request("https://probe.example/health", { method: "POST" }),
      unconfigured,
    );
    const other = await probe.fetch(new Request("https://probe.example/other"), unconfigured);
    expect(post.status).toBe(404);
    expect(other.status).toBe(404);
  });

  test("callers without a bearer token do not read D1", async () => {
    const queries: string[] = [];
    const response = await probe.fetch(
      new Request("https://probe.example/health"),
      osnEnv({ DB: database({ ok: 1 }, queries) }),
    );
    expect(response.status).toBe(401);
    expect(queries).toEqual([]);
  });

  test("a wrong token of the same length, a prefix or a longer token is refused", async () => {
    const queries: string[] = [];
    const env = osnEnv({ DB: database({ ok: 1 }, queries) });
    const sameLength = `${token.slice(0, -1)}u`;
    for (const presented of [sameLength, token.slice(0, -1), `${token}t`, ""]) {
      const response = await probe.fetch(healthRequest(`Bearer ${presented}`), env);
      expect(response.status).toBe(401);
    }
    const otherScheme = await probe.fetch(healthRequest(`Basic ${token}`), env);
    expect(otherScheme.status).toBe(401);
    expect(queries).toEqual([]);
  });

  test("a configured token shorter than the minimum fails closed for everyone", async () => {
    const short = "s".repeat(MIN_PROBE_TOKEN_LENGTH - 1);
    const queries: string[] = [];
    const response = await probe.fetch(
      healthRequest(`Bearer ${short}`),
      osnEnv({ PROBE_TOKEN: short, DB: database({ ok: 1 }, queries) }),
    );
    expect(response.status).toBe(503);
    expect(queries).toEqual([]);
  });

  test("Cire reads D1 and at most one object from each bucket", async () => {
    const queries: string[] = [];
    const limits: number[] = [];
    const response = await probe.fetch(
      healthRequest(),
      cireEnv({ DB: database({ ok: 1 }, queries), SHEETS: bucket(limits), ASSETS: bucket(limits) }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ product: "cire", ok: true });
    expect(queries).toEqual(["SELECT 1 AS ok"]);
    expect(limits).toEqual([1, 1]);
  });

  test("a failed D1 read or a missing binding fails health", async () => {
    const failedDb = await probe.fetch(healthRequest(), osnEnv({ DB: database(null, []) }));
    const missingLimiter = await probe.fetch(
      healthRequest(),
      osnEnv({ RL_AUTH_IP_5_60: undefined }),
    );
    const missingBucket = await probe.fetch(healthRequest(), cireEnv({ ASSETS: undefined }));
    expect(failedDb.status).toBe(503);
    expect(missingLimiter.status).toBe(503);
    expect(missingBucket.status).toBe(503);
  });

  test("a throwing D1 or R2 binding fails health with a 503, not an exception", async () => {
    const failingBucket: Bucket = {
      list: () => Promise.reject(new Error("R2 unavailable")),
    };
    const d1Throws = await probe.fetch(healthRequest(), osnEnv({ DB: throwingDatabase() }));
    const r2Throws = await probe.fetch(healthRequest(), cireEnv({ SHEETS: failingBucket }));
    expect(d1Throws.status).toBe(503);
    expect(r2Throws.status).toBe(503);
  });

  test("OSN returns health when D1 and the limiter are bound", async () => {
    const response = await probe.fetch(healthRequest(), osnEnv());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ product: "osn", ok: true });
  });

  test("a Cire probe missing any one of its bindings fails health", async () => {
    for (const binding of ["SHEETS", "ASSETS", "IMAGES", "CLAIM_RATE_LIMITER"] as const) {
      const response = await probe.fetch(healthRequest(), cireEnv({ [binding]: undefined }));
      expect(response.status).toBe(503);
      expect(await response.text()).toBe("cire binding probe failed");
    }
  });

  test("an unbound token fails closed with 503, not an exception", async () => {
    const env = osnEnv();
    const unbound = { ...env, PROBE_TOKEN: undefined } as unknown as ProbeEnv;
    const response = await probe.fetch(healthRequest(), unbound);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Probe token not configured");
  });

  test("reads its bindings under the names the stack binds them", async () => {
    const [sheets, assets] = PROBE.cire.buckets;
    const cire = await probe.fetch(healthRequest(), {
      PROBE_PRODUCT: "cire",
      PROBE_TOKEN: token,
      DB: database({ ok: 1 }, []),
      IMAGES: {},
      [sheets.binding]: bucket([]),
      [assets.binding]: bucket([]),
      [PROBE.cire.rateLimit.binding]: limiter([]),
    });
    const osn = await probe.fetch(healthRequest(), {
      PROBE_PRODUCT: "osn",
      PROBE_TOKEN: token,
      DB: database({ ok: 1 }, []),
      [PROBE.osn.rateLimit.binding]: limiter([]),
    });
    expect(cire.status).toBe(200);
    expect(osn.status).toBe(200);
  });

  test("the shared dev rate-limit counters are never spent", async () => {
    const calls: string[] = [];
    await probe.fetch(healthRequest(), osnEnv({ RL_AUTH_IP_5_60: limiter(calls) }));
    await probe.fetch(healthRequest(), cireEnv({ CLAIM_RATE_LIMITER: limiter(calls) }));
    expect(calls).toEqual([]);
  });
});

describe("sameDigest", () => {
  test("a difference in the first or the last byte is a mismatch", () => {
    const base = new Uint8Array(32).fill(7);
    const first = base.slice();
    first[0] = 8;
    const last = base.slice();
    last[31] = 8;
    expect(sameDigest(base, base.slice())).toBe(true);
    expect(sameDigest(first, base)).toBe(false);
    expect(sameDigest(last, base)).toBe(false);
    expect(sameDigest(base.slice(0, 31), base)).toBe(false);
  });
});

describe("tokensMatch", () => {
  test("matches only the identical string", async () => {
    expect(await tokensMatch(token, token)).toBe(true);
    expect(await tokensMatch(`${token.slice(0, -1)}u`, token)).toBe(false);
    expect(await tokensMatch(token.slice(1), token)).toBe(false);
    expect(await tokensMatch("", token)).toBe(false);
  });
});
