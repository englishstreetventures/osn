import { describe, expect, it } from "bun:test";

import {
  checkProbeResponse,
  coloFromRay,
  DEFAULT_SAMPLES,
  isBelowFloor,
  MAX_SAMPLES,
  measurePairs,
  parseSampleCount,
  percentile,
  probeRequests,
  readDevTarget,
  renderReport,
  spacingMs,
  summarise,
  WARM_UP_PAIRS,
  type Arm,
  type ProbeRun,
} from "../../scripts/d1-latency-probe";

const committedToml = () => Bun.file(new URL("../../wrangler.toml", import.meta.url)).text();
const workflow = () =>
  Bun.file(
    new URL("../../../../.github/workflows/cire-d1-latency-probe.yml", import.meta.url),
  ).text();

/** A limiter binding with the given `simple` table, for the refusal cases. */
const limiterWith = (simple: string) =>
  `name = "CLAIM_SESSION_RATE_LIMITER"\ntype = "ratelimit"\nnamespace_id = "1102"\nsimple = ${simple}`;

/** The smallest config `readDevTarget` accepts; each case below breaks one piece. */
const devToml = ({
  origin = "https://api.dev.example.com",
  routePattern = "api.dev.example.com",
  limiter = 'name = "CLAIM_SESSION_RATE_LIMITER"\ntype = "ratelimit"\nnamespace_id = "1102"\nsimple = { limit = 60, period = 60 }',
}: { origin?: string; routePattern?: string; limiter?: string } = {}) => `
[env.dev.vars]
CIRE_API_ORIGIN = "${origin}"

[[env.dev.routes]]
pattern = "${routePattern}"
custom_domain = true

[[env.dev.unsafe.bindings]]
${limiter}
`;

describe("readDevTarget", () => {
  it("never targets a host production is served on", async () => {
    const toml = await committedToml();
    const parsed = Bun.TOML.parse(toml) as {
      env: { production: { routes: { pattern: string }[] } };
    };

    const target = readDevTarget(toml);

    expect(parsed.env.production.routes.map((route) => route.pattern)).not.toContain(
      new URL(target.origin).host,
    );
  });

  it("fits the longest allowed run inside the workflow's timeout", async () => {
    // The pauses alone, at the committed dev budget, for the most pairs the
    // workflow accepts. A quarter of the job is left for checkout, Bun setup
    // and the requests themselves. A tighter limiter, a larger sample cap or a
    // shorter timeout fails here rather than on the next manual run.
    const target = readDevTarget(await committedToml());
    const timeout = /timeout-minutes:\s*(\d+)/.exec(await workflow())?.[1];
    expect(timeout).toBeDefined();

    const pausesMs = (WARM_UP_PAIRS + MAX_SAMPLES) * 2 * spacingMs(target);

    expect(pausesMs).toBeLessThanOrEqual(0.75 * Number(timeout) * 60_000);
  });

  it("accepts a minimal dev block", () => {
    expect(readDevTarget(devToml())).toEqual({
      origin: "https://api.dev.example.com",
      limit: 60,
      periodSeconds: 60,
    });
  });

  it("refuses a config with no dev environment", () => {
    expect(() => readDevTarget('[vars]\nCIRE_API_ORIGIN = "https://x.example.com"')).toThrow(
      "[env.dev.vars] CIRE_API_ORIGIN",
    );
  });

  it("refuses an origin that is not https", () => {
    expect(() => readDevTarget(devToml({ origin: "http://api.dev.example.com" }))).toThrow("https");
  });

  it("refuses an origin with a path", () => {
    expect(() => readDevTarget(devToml({ origin: "https://api.dev.example.com/api" }))).toThrow(
      "bare origin",
    );
  });

  it("refuses an origin the dev Worker is not routed on", () => {
    expect(() => readDevTarget(devToml({ routePattern: "api.example.com" }))).toThrow(
      "[[env.dev.routes]]",
    );
  });

  it("refuses a dev block without the session-restore limiter", () => {
    expect(() =>
      readDevTarget(
        devToml({
          limiter:
            'name = "CLAIM_RATE_LIMITER"\ntype = "ratelimit"\nnamespace_id = "1101"\nsimple = { limit = 5, period = 60 }',
        }),
      ),
    ).toThrow("CLAIM_SESSION_RATE_LIMITER");
  });

  // `spacingMs` divides by both values; a missing or odd one would pace the
  // run at NaN and trip the limiter in the first minute.
  it.each([
    "{ limit = 0, period = 60 }",
    "{ limit = 1.5, period = 60 }",
    '{ limit = "60", period = 60 }',
    "{ period = 60 }",
  ])("refuses a limiter whose limit is not a positive whole number: %s", (simple) => {
    expect(() => readDevTarget(devToml({ limiter: limiterWith(simple) }))).toThrow("simple.limit");
  });

  it.each(["{ limit = 60, period = 0 }", "{ limit = 60, period = 1.5 }", "{ limit = 60 }"])(
    "refuses a limiter whose period is not a positive whole number: %s",
    (simple) => {
      expect(() => readDevTarget(devToml({ limiter: limiterWith(simple) }))).toThrow(
        "simple.period",
      );
    },
  );
});

describe("spacingMs", () => {
  it("spaces requests to two thirds of the limiter's budget", () => {
    expect(spacingMs({ origin: "https://x", limit: 60, periodSeconds: 60 })).toBe(1500);
    expect(spacingMs({ origin: "https://x", limit: 10, periodSeconds: 60 })).toBe(9000);
  });
});

describe("parseSampleCount", () => {
  it("defaults when nothing is given", () => {
    expect(parseSampleCount(undefined)).toBe(DEFAULT_SAMPLES);
    expect(parseSampleCount("")).toBe(DEFAULT_SAMPLES);
    expect(parseSampleCount("  ")).toBe(DEFAULT_SAMPLES);
  });

  it("accepts whole numbers from 25 to 100", () => {
    expect(parseSampleCount("25")).toBe(25);
    expect(parseSampleCount(" 100 ")).toBe(100);
  });

  it.each(["24", "101", "30.5", "abc", "1e2", "-30"])("refuses %p", (raw) => {
    expect(() => parseSampleCount(raw)).toThrow("25 to 100");
  });
});

describe("probeRequests", () => {
  it("builds the same route twice, with the session cookie on the query arm only", () => {
    const { control, query } = probeRequests("https://api.dev.example.com", "tok");

    expect(control.url).toBe("https://api.dev.example.com/api/claim/session");
    expect(query.url).toBe(control.url);
    expect(control.headers).toEqual({});
    expect(query.headers).toEqual({ cookie: "cire_session=tok" });
  });
});

describe("percentile", () => {
  // Expected values are numpy's default method (linear, Hyndman-Fan type 7).
  it("interpolates between closest ranks", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.1)).toBeCloseTo(1.4, 10);
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5], 0.9)).toBeCloseTo(4.6, 10);
    expect(percentile([10, 20, 30, 40], 0.1)).toBeCloseTo(13, 10);
    expect(percentile([10, 20, 30, 40], 0.5)).toBe(25);
    expect(percentile([10, 20, 30, 40], 0.9)).toBeCloseTo(37, 10);
  });

  it("sorts its input rather than trusting the caller", () => {
    expect(percentile([5, 1, 4, 2, 3], 0.5)).toBe(3);
  });

  it("returns the only value of a single sample", () => {
    expect(percentile([7], 0.9)).toBe(7);
  });

  it("refuses an empty sample", () => {
    expect(() => percentile([], 0.5)).toThrow("empty");
  });
});

describe("summarise", () => {
  const pairs = [
    { control: 10, query: 40 },
    { control: 20, query: 45 },
    { control: 30, query: 70 },
    { control: 40, query: 90 },
    { control: 50, query: 80 },
  ];

  it("reports each arm and the paired differences", () => {
    const summary = summarise(pairs);

    expect(summary.n).toBe(5);
    expect(summary.control.p50).toBe(30);
    expect(summary.query.p50).toBe(70);
    // Differences 30, 25, 40, 50, 30 → sorted 25, 30, 30, 40, 50.
    expect(summary.difference.p10).toBeCloseTo(27, 10);
    expect(summary.difference.p50).toBe(30);
    expect(summary.difference.p90).toBeCloseTo(46, 10);
  });

  it("headlines the difference of the medians, not the median difference", () => {
    // 70 − 30, where the median of the paired differences above is 30.
    expect(summarise(pairs).costOfOneQuery).toBe(40);
  });
});

describe("isBelowFloor", () => {
  // The wiki states the threshold: a cost under 5 ms fails the run.
  it("flags a cost under 5 ms, and only that", () => {
    expect(isBelowFloor(summarise([{ control: 20, query: 24.9 }]))).toBe(true);
    expect(isBelowFloor(summarise([{ control: 20, query: 25 }]))).toBe(false);
    expect(isBelowFloor(summarise([{ control: 30, query: 20 }]))).toBe(true);
    expect(isBelowFloor(summarise([{ control: 20, query: 60 }]))).toBe(false);
  });
});

describe("checkProbeResponse", () => {
  const response = (status: number, headers: Record<string, string> = {}) =>
    new Response(null, { status, headers });

  it("gives the colo of a 401", () => {
    expect(checkProbeResponse("query", response(401, { "cf-ray": "8c1a2b3c4d5e6f70-IAD" }))).toBe(
      "IAD",
    );
  });

  it("stops on a 429 and says the limiter refused it", () => {
    expect(() => checkProbeResponse("query", response(429))).toThrow(
      "query request answered 429, expected 401 — the limiter refused it",
    );
  });

  it("stops on a Cloudflare challenge and says so", () => {
    expect(() =>
      checkProbeResponse("control", response(403, { "cf-mitigated": "challenge" })),
    ).toThrow("control request answered 403, expected 401 — Cloudflare answered a challenge");
  });

  it.each([200, 404, 500, 503])("stops on any other status: %p", (status) => {
    expect(() => checkProbeResponse("control", response(status))).toThrow(
      `control request answered ${status}, expected 401 — dev may be mid-deploy`,
    );
  });

  it("stops on a 401 that names no colo", () => {
    expect(() => checkProbeResponse("query", response(401))).toThrow(
      "query response carried no cf-ray colo",
    );
  });
});

describe("measurePairs", () => {
  /** A fake clock: control always 10 ms, query always 50 ms, colo by call. */
  const fake = () => {
    const calls: Arm[] = [];
    let sleeps = 0;
    const time = (arm: Arm) => {
      calls.push(arm);
      return Promise.resolve({
        ms: arm === "control" ? 10 : 50,
        colo: calls.length % 3 === 0 ? "EWR" : "IAD",
      });
    };
    const sleep = () => {
      sleeps += 1;
      return Promise.resolve();
    };
    return { calls, time, sleep, sleeps: () => sleeps };
  };

  it("files each timing under its own arm, whichever went first", async () => {
    const clock = fake();

    const { pairs } = await measurePairs({ warmUp: 2, samples: 5, ...clock });

    expect(pairs).toEqual(Array.from({ length: 5 }, () => ({ control: 10, query: 50 })));
  });

  it("alternates which arm goes first", async () => {
    const clock = fake();

    await measurePairs({ warmUp: 1, samples: 2, ...clock });

    expect(clock.calls).toEqual(["control", "query", "query", "control", "control", "query"]);
  });

  it("drops the warm-up pairs and counts colos for measured requests only", async () => {
    const clock = fake();

    const { pairs, colos } = await measurePairs({ warmUp: 3, samples: 4, ...clock });

    expect(pairs).toHaveLength(4);
    // Calls 7-14 are measured; every third call overall is EWR (9 and 12).
    expect(colos).toEqual({ IAD: 6, EWR: 2 });
  });

  it("pauses after every request", async () => {
    const clock = fake();

    await measurePairs({ warmUp: 1, samples: 3, ...clock });

    expect(clock.sleeps()).toBe(8);
  });

  it("reports progress once per pair", async () => {
    const seen: string[] = [];

    await measurePairs({
      warmUp: 1,
      samples: 2,
      ...fake(),
      onPair: (done, total) => seen.push(`${done}/${total}`),
    });

    expect(seen).toEqual(["1/3", "2/3", "3/3"]);
  });
});

describe("coloFromRay", () => {
  it("reads the colo after the last dash of cf-ray", () => {
    expect(coloFromRay("8c1a2b3c4d5e6f70-SYD")).toBe("SYD");
  });

  it.each([null, "", "8c1a2b3c4d5e6f70", "8c1a2b3c4d5e6f70-", "8c1a2b3c4d5e6f70-syd"])(
    "gives null for %p",
    (ray) => {
      expect(coloFromRay(ray)).toBeNull();
    },
  );
});

describe("renderReport", () => {
  const run: ProbeRun = {
    url: "https://api.dev.example.com/api/claim/session",
    startedAt: new Date("2026-09-25T10:00:00Z"),
    windowSeconds: 160,
    region: "eastus",
    colos: { IAD: 98, EWR: 2 },
    spacingMs: 1500,
    warmUpPairs: 3,
    pairs: [
      { control: 10, query: 40 },
      { control: 20, query: 45 },
      { control: 30, query: 70 },
      { control: 40, query: 90 },
      { control: 50, query: 80 },
    ],
    runUrl: "https://github.com/o/r/actions/runs/1",
  };

  it("carries the location, the method and the three percentiles", () => {
    const report = renderReport(run);

    expect(report).toContain("eastus");
    expect(report).toContain("IAD ×98, EWR ×2");
    expect(report).toContain("5 measured");
    expect(report).toContain("3 warm-up pairs discarded");
    expect(report).toContain("1500 ms");
    expect(report).toContain("| Control (no D1 query) | 14.0 ms | 30.0 ms | 46.0 ms |");
    expect(report).toContain("| One extra `SELECT` | 42.0 ms | 70.0 ms | 86.0 ms |");
    expect(report).toContain("| Paired difference | 27.0 ms | 30.0 ms | 46.0 ms |");
    expect(report).toContain("| Window | from 2026-09-25T10:00:00.000Z, 160 s |");
    expect(report).toContain("**Cost of one query: 40.0 ms**");
  });

  it("ends with a wiki row and a measured marker naming the run", () => {
    const report = renderReport(run);

    expect(report).toContain(
      "| GitHub-hosted runner (eastus) | IAD ×98, EWR ×2 | 30.0 ms | 70.0 ms | **40.0 ms** | 27.0 / 30.0 / 46.0 ms | 5 |",
    );
    expect(report).toContain(
      "*Measured 2026-09-25 — [`cire-d1-latency-probe.yml` run](https://github.com/o/r/actions/runs/1), runner region eastus, colo IAD ×98, EWR ×2, n=5*",
    );
  });

  it("says when a run was local and the region unknown", () => {
    const report = renderReport({ ...run, region: null, runUrl: null });

    expect(report).toContain("not reported");
    expect(report).toContain("| Local run | IAD ×98, EWR ×2 |");
    expect(report).toContain(
      "*Measured 2026-09-25 — `bun --no-install cire/api/scripts/d1-latency-probe.ts` from a local client, colo IAD ×98, EWR ×2, n=5*",
    );
  });

  it("names a lone colo by its code alone", () => {
    const report = renderReport({ ...run, colos: { SYD: 10 } });

    expect(report).toContain("| GitHub-hosted runner (eastus) | SYD |");
    expect(report).toContain("colo SYD, n=5*");
    expect(report).not.toContain("SYD ×");
  });

  it("lists every raw pair so a reader can recompute", () => {
    expect(renderReport(run)).toContain("10.0, 40.0");
  });
});
