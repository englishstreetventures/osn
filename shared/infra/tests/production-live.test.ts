import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  declaredRule,
  judgeLive,
  lostSecrets,
  readProductionLive,
  runReadLiveCli,
  type AdoptedResources,
  type LiveState,
  type LiveWorker,
} from "../src/production-live";
import { tierSecrets } from "../src/secrets/inventory";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`;

/** Production's one lifecycle rule on cire's buckets, as declared. */
const ABORT_RULE = {
  id: "Default Multipart Abort Rule",
  enabled: true,
  prefix: "",
  abortMultipartUploadsTransition: { condition: { type: "Age", maxAge: 604800 } },
};

const ADOPTED: AdoptedResources = {
  workers: {
    CireApi: {
      name: "cire-api-production",
      worker: "cire-api",
      crons: ["0 4 * * *"],
      durableObjects: { REALTIME_HUB: "TopicHub" },
      envNames: ["OSN_ENV", "DB", "REALTIME_HUB"],
      previews: false,
      observability: {
        logs: true,
        headSamplingRate: 1,
        redactQueryString: true,
        traces: { enabled: false },
        invocationLogs: false,
        issues: true,
      },
    },
  },
  databases: { CireDb: { name: "cire-db", readReplication: "auto" } },
  buckets: {
    CireAssets: {
      name: "cire-assets",
      lifecycleRules: [declaredRule(ABORT_RULE)],
      cors: [],
      publicAccess: false,
      domains: [],
    },
  },
};

const ok = (result: unknown, resultInfo?: unknown) =>
  Response.json({ success: true, errors: [], messages: [], result, result_info: resultInfo });
const failed = (status: number, code: number) =>
  Response.json({ success: false, errors: [{ code, message: "no" }], result: null }, { status });

/** Every secret cire-api must hold on production, live. */
const REQUIRED = tierSecrets("cire-api", "production").secrets;

/** A scripted Cloudflare API holding cire's adopted resources as production has them. */
function scripted(overrides: Readonly<Record<string, () => Response>> = {}) {
  const calls: string[] = [];
  const routes: Record<string, () => Response> = {
    "/workers/scripts/cire-api-production/settings": () =>
      ok({
        observability: {
          enabled: true,
          logs: { enabled: true, invocation_logs: false },
          traces: { enabled: false },
          redact_query_string: true,
        },
      }),
    "/workers/scripts/cire-api-production/secrets": () =>
      ok([...REQUIRED, "UPSTASH_REDIS_REST_URL"].map((name) => ({ name, type: "secret_text" }))),
    "/workers/scripts/cire-api-production/schedules": () =>
      ok({ schedules: [{ cron: "0 4 * * *" }] }),
    "/workers/domains?service=cire-api-production": () =>
      ok([
        {
          hostname: "api.cireweddings.com",
          service: "cire-api-production",
          previews_enabled: null,
        },
      ]),
    "/workers/durable_objects/namespaces?page=1&per_page=1000": () =>
      ok([
        { id: "n1", class: "TopicHub", script: "cire-api-production", use_sqlite: true },
        { id: "n2", class: "CoordinationStore", script: "osn-api-production", use_sqlite: true },
      ]),
    "/d1/database?name=cire-db&page=1&per_page=100": () =>
      ok([
        { uuid: "u-dev", name: "cire-db-dev" },
        { uuid: "u-prod", name: "cire-db" },
      ]),
    "/d1/database/u-prod": () => ok({ uuid: "u-prod", read_replication: { mode: "auto" } }),
    "/r2/buckets/cire-assets": () => ok({ name: "cire-assets" }),
    "/r2/buckets/cire-assets/lifecycle": () =>
      ok({
        rules: [
          {
            id: "Default Multipart Abort Rule",
            enabled: true,
            conditions: { prefix: "" },
            abortMultipartUploadsTransition: { condition: { maxAge: 604800, type: "Age" } },
          },
        ],
      }),
    "/r2/buckets/cire-assets/cors": () => failed(404, 10059),
    "/r2/buckets/cire-assets/domains/managed": () =>
      ok({ bucketId: "b", domain: "pub-x.r2.dev", enabled: false }),
    "/r2/buckets/cire-assets/domains/custom": () => ok({ domains: [] }),
    ...overrides,
  };
  const fetcher = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push(url);
    const route = routes[url.slice(API.length)];
    return route === undefined ? failed(404, 0) : route();
  }) as unknown as typeof fetch;
  return { fetch: fetcher, calls };
}

const api = (fetcher: typeof fetch) => ({
  account: ACCOUNT,
  token: "token-value",
  fetch: fetcher,
  sleep: async () => undefined,
});

describe("LR1: the live read reads each adopted resource as the provider would", () => {
  test("reads names and settings only, defaulting as the provider does", async () => {
    const live = await readProductionLive(ADOPTED, api(scripted().fetch));
    expect(live.workers.CireApi).toEqual({
      exists: true,
      secrets: [...REQUIRED, "UPSTASH_REDIS_REST_URL"].toSorted(),
      crons: ["0 4 * * *"],
      durableObjectClasses: ["TopicHub"],
      // A null previews flag reads as off.
      domains: [{ hostname: "api.cireweddings.com", previews: false }],
      observability: expect.objectContaining({ enabled: true }),
    });
    // Only the exact name counts among the databases the name filter lists.
    expect(live.databases.CireDb).toEqual({ exists: true, readReplication: "auto" });
    // No CORS configuration reads as none.
    expect(live.buckets.CireAssets).toEqual({
      exists: true,
      lifecycleRules: [declaredRule(ABORT_RULE)],
      corsRules: 0,
      managedDomain: false,
      customDomains: [],
    });
  });

  test("LR2: a Worker, database or bucket that does not exist reads as absent", async () => {
    const live = await readProductionLive(
      ADOPTED,
      api(
        scripted({
          "/workers/scripts/cire-api-production/settings": () => failed(404, 10007),
          "/d1/database?name=cire-db&page=1&per_page=100": () =>
            ok([{ uuid: "u", name: "cire-db-dev" }]),
          "/r2/buckets/cire-assets": () => failed(404, 10006),
        }).fetch,
      ),
    );
    expect(live.workers.CireApi?.exists).toBe(false);
    expect(live.databases.CireDb).toEqual({ exists: false, readReplication: "disabled" });
    expect(live.buckets.CireAssets?.exists).toBe(false);
  });

  test("LR3: a database with no read replication setting reads as disabled, as the provider reads it", async () => {
    const live = await readProductionLive(
      ADOPTED,
      api(
        scripted({ "/d1/database/u-prod": () => ok({ uuid: "u-prod", read_replication: null }) })
          .fetch,
      ),
    );
    expect(live.databases.CireDb?.readReplication).toBe("disabled");
  });

  test("LR4: a refused read or three failed tries throws, naming no account id", async () => {
    const forbidden = scripted({
      "/workers/scripts/cire-api-production/secrets": () => failed(403, 10000),
    });
    await expect(readProductionLive(ADOPTED, api(forbidden.fetch))).rejects.toThrow(/answered 403/);
    const down = scripted({
      "/r2/buckets/cire-assets/lifecycle": () => new Response("busy", { status: 503 }),
    });
    const error = await readProductionLive(ADOPTED, api(down.fetch)).catch((e: unknown) => e);
    expect(String(error)).toContain("failed three times");
    expect(String(error)).not.toContain(ACCOUNT);
    expect(down.calls.filter((url) => url.endsWith("/lifecycle"))).toHaveLength(3);
  });
});

/** A live state matching ADOPTED exactly. */
const matching = (): LiveState => ({
  workers: {
    CireApi: {
      exists: true,
      secrets: [...REQUIRED],
      crons: ["0 4 * * *"],
      durableObjectClasses: ["TopicHub"],
      domains: [{ hostname: "api.cireweddings.com", previews: false }],
      observability: {
        enabled: true,
        logs: { enabled: true, invocation_logs: false },
        traces: { enabled: false },
        redact_query_string: true,
      },
    },
  },
  databases: { CireDb: { exists: true, readReplication: "auto" } },
  buckets: {
    CireAssets: {
      exists: true,
      lifecycleRules: [declaredRule(ABORT_RULE)],
      corsRules: 0,
      managedDomain: false,
      customDomains: [],
    },
  },
});

const withWorker = (live: LiveState, worker: Partial<LiveWorker>): LiveState => ({
  ...live,
  workers: { CireApi: { ...live.workers.CireApi!, ...worker } },
});

const ALL = new Set(["CireApi", "CireDb", "CireAssets"]);

describe("LJ: the guard's judgement of the live state", () => {
  test("LJ1: live state equal to the declaration passes, adopting or not", () => {
    expect(judgeLive({ adopted: ADOPTED, live: matching(), adopting: ALL })).toEqual({
      refusals: [],
      notices: [],
    });
    expect(judgeLive({ adopted: ADOPTED, live: matching(), adopting: new Set() }).refusals).toEqual(
      [],
    );
  });

  test("LJ2: an adopted resource that does not exist live is refused on every release", () => {
    const live = matching();
    const gone: LiveState = {
      workers: { CireApi: { ...live.workers.CireApi!, exists: false } },
      databases: { CireDb: { exists: false, readReplication: "disabled" } },
      buckets: { CireAssets: { ...live.buckets.CireAssets!, exists: false } },
    };
    const refused = judgeLive({ adopted: ADOPTED, live: gone, adopting: new Set() }).refusals;
    expect(refused).toHaveLength(3);
    expect(refused.join("\n")).toContain("no Worker cire-api-production exists live");
    expect(refused.join("\n")).toContain("no D1 database cire-db exists live");
    expect(refused.join("\n")).toContain("no R2 bucket cire-assets exists live");
    // A resource the read did not cover is refused too.
    expect(
      judgeLive({
        adopted: ADOPTED,
        live: { workers: {}, databases: {}, buckets: {} },
        adopting: ALL,
      }).refusals,
    ).toHaveLength(3);
  });

  test("LJ3: a missing required secret or a forbidden one present is refused on every release, naming it; an unknown one is kept and listed", () => {
    const [first] = REQUIRED;
    const live = withWorker(matching(), {
      secrets: [
        ...REQUIRED.filter((name) => name !== first),
        "RESEND_API_URL",
        "UPSTASH_REDIS_REST_URL",
      ],
    });
    const judged = judgeLive({ adopted: ADOPTED, live, adopting: new Set() });
    expect(judged.refusals).toEqual([
      `cire-api-production lacks secrets it needs on production: ${first}; set each on the Worker (wrangler secret put) before releasing`,
      "cire-api-production holds secrets it must not: RESEND_API_URL; delete each with wrangler secret delete before releasing",
    ]);
    expect(judged.notices).toEqual([
      "cire-api-production keeps live secrets the inventory does not list: UPSTASH_REDIS_REST_URL",
    ]);
  });

  test("LJ4: a declared var or binding named like a live secret is refused: the upload would replace the secret", () => {
    const live = withWorker(matching(), { secrets: [...REQUIRED, "OSN_ENV"] });
    expect(judgeLive({ adopted: ADOPTED, live, adopting: new Set() }).refusals).toContain(
      "cire-api-production declares vars or bindings named like its live secrets, which the upload would replace: OSN_ENV",
    );
  });

  test("LJ5: while adopting, a cron, Durable Object class, read replication or bucket difference is refused; once adopted, none is", () => {
    const live: LiveState = {
      workers: {
        CireApi: {
          ...matching().workers.CireApi!,
          crons: ["0 4 * * *", "*/5 * * * *"],
          durableObjectClasses: ["TopicHub", "OldHub"],
        },
      },
      databases: { CireDb: { exists: true, readReplication: "disabled" } },
      buckets: {
        CireAssets: {
          exists: true,
          lifecycleRules: [],
          corsRules: 1,
          managedDomain: true,
          customDomains: ["assets.cireweddings.com"],
        },
      },
    };
    const refused = judgeLive({ adopted: ADOPTED, live, adopting: ALL }).refusals.join("\n");
    expect(refused).toContain(
      "live cron schedule [0 4 * * *, */5 * * * *] differs from the declared [0 4 * * *]",
    );
    expect(refused).toContain("hosts Durable Object classes no declared binding names: OldHub");
    expect(refused).toContain("cire-db's read replication is disabled live and auto declared");
    expect(refused).toContain(
      "cire-assets: its lifecycle rules, its CORS rules, its r2.dev access, its custom domains differ live",
    );
    expect(judgeLive({ adopted: ADOPTED, live, adopting: new Set() }).refusals).toEqual([]);
  });

  test("LJ6: a custom domain whose previews flag differs is listed while adopting and refused otherwise", () => {
    const live = withWorker(matching(), {
      domains: [{ hostname: "api.cireweddings.com", previews: true }],
    });
    const adopting = judgeLive({ adopted: ADOPTED, live, adopting: new Set(["CireDb"]) });
    expect(adopting.refusals).toEqual([]);
    expect(adopting.notices.join("\n")).toContain("detaches it and attaches it again");
    expect(
      judgeLive({ adopted: ADOPTED, live, adopting: new Set() }).refusals.join("\n"),
    ).toContain("change it in the Cloudflare dashboard first");
  });

  test("LJ7: a lifecycle rule read in another key order or with absent fields equals its declaration", () => {
    const live: LiveState = {
      ...matching(),
      buckets: {
        CireAssets: {
          ...matching().buckets.CireAssets!,
          lifecycleRules: [
            {
              prefix: "",
              abortMultipartUploadsTransition: { condition: { maxAge: 604800, type: "Age" } },
              enabled: true,
              id: "Default Multipart Abort Rule",
            },
          ],
        },
      },
    };
    expect(judgeLive({ adopted: ADOPTED, live, adopting: ALL }).refusals).toEqual([]);
  });

  test("LJ8: an observability difference is listed while adopting, never refused", () => {
    const live = withWorker(matching(), { observability: null });
    const judged = judgeLive({ adopted: ADOPTED, live, adopting: ALL });
    expect(judged.refusals).toEqual([]);
    expect(judged.notices.join("\n")).toContain("observability changes from [none]");
  });
});

describe("LS: the check after a deploy", () => {
  test("LS1: a secret name live before the deploy and gone after it is named", () => {
    const before = withWorker(matching(), { secrets: [...REQUIRED, "CIRE_OPS_EMAIL"] });
    expect(lostSecrets(before, matching())).toEqual(["CireApi: CIRE_OPS_EMAIL"]);
    expect(lostSecrets(matching(), before)).toEqual([]);
  });

  test("LS2: read-live with --kept exits 1 naming a lost secret, 0 when every one is kept, and writes the state either way", async () => {
    const dir = mkdtempSync(join(tmpdir(), "read-live-"));
    const before = join(dir, "before.json");
    const after = join(dir, "after.json");
    const env = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "token-value" };
    const run = async (argv: string[], fetcher = scripted().fetch) => {
      const out: string[] = [];
      const code = await runReadLiveCli({
        adopted: ADOPTED,
        argv,
        env,
        fetch: fetcher,
        sleep: async () => undefined,
        out: (text) => out.push(text),
      });
      return { code, out: out.join("") };
    };
    expect((await run(["--", "--out", before])).code).toBe(0);
    const kept = await run(["--out", after, "--kept", before]);
    expect(kept.code).toBe(0);
    expect(kept.out).toContain("Every secret live before the deploy is live after it.");
    const dropped = scripted({
      "/workers/scripts/cire-api-production/secrets": () =>
        ok(REQUIRED.map((name) => ({ name, type: "secret_text" }))),
    });
    const lost = await run(["--out", after, "--kept", before], dropped.fetch);
    expect(lost.code).toBe(1);
    expect(lost.out).toContain("CireApi: UPSTASH_REDIS_REST_URL");
    expect(JSON.parse(readFileSync(after, "utf8"))).toHaveProperty("workers.CireApi.exists", true);
    // Nothing printed is a value: the token never appears.
    expect(lost.out + kept.out).not.toContain("token-value");
  });

  test("LS3: a bad argument, a missing credential or a failed read exits 2, naming no account", async () => {
    const dir = mkdtempSync(join(tmpdir(), "read-live-"));
    const out: string[] = [];
    const base = {
      adopted: ADOPTED,
      fetch: scripted().fetch,
      sleep: async () => undefined,
      out: (text: string) => out.push(text),
    };
    const env = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_API_TOKEN: "token-value" };
    expect(await runReadLiveCli({ ...base, argv: [], env })).toBe(2);
    expect(
      await runReadLiveCli({ ...base, argv: ["--out", join(dir, "a.json"), "--kept"], env }),
    ).toBe(2);
    expect(await runReadLiveCli({ ...base, argv: ["--out", join(dir, "a.json")], env: {} })).toBe(
      2,
    );
    writeFileSync(join(dir, "bad.json"), "not json");
    const failing = scripted({ "/r2/buckets/cire-assets": () => failed(403, 10000) });
    expect(
      await runReadLiveCli({
        ...base,
        fetch: failing.fetch,
        argv: ["--out", join(dir, "a.json")],
        env,
      }),
    ).toBe(2);
    expect(out.join("")).not.toContain(ACCOUNT);
  });
});
