// Holds scripts/production-operator.ts and .github/workflows/production-operator.yml
// to what they may do with production: which requests each action sends, what
// each refuses before sending one, and that no path prints a token, a bearer,
// an account id, a row or a response body. Run logs on this repository are
// public. Every request goes to a fake `fetch`; nothing here reaches
// Cloudflare, GitHub or osn-api.

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { PRODUCTION_HOSTS } from "../../shared/infra/src/production-sites";
import { listMigrations, migrationStatements } from "../migration-files";
import {
  countSql,
  type Deps,
  generatePublicJwk,
  gitShow,
  lookupProductionCommits,
  nowSeconds,
  parseWindow,
  permittedIn,
  run,
  scopesIn,
  ZAP_DATABASE,
} from "../production-operator";
import { CI_USER_AGENT } from "../smoke-check";

const root = join(import.meta.dir, "..", "..");
const readRepo = (path: string): string => readFileSync(join(root, path), "utf8");

const CANARY = "CANARY-row-or-body-7f3a";
const BEARER = "internal-service-secret-for-tests-0123456789";
const TOKEN = "cloudflare-token-for-tests-0123456789";
const ACCOUNT = "0123456789abcdef0123456789abcdef";
const GH_TOKEN = "github-token-for-tests-0123456789";
const UUID = "6f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b";
const CIRE_COMMIT = "a".repeat(40);
const OSN_COMMIT = "b".repeat(40);
const KID = "11111111-2222-4333-8444-555555555555";
const PUBLIC_JWK = JSON.stringify({
  kty: "EC",
  crv: "P-256",
  x: "x-coordinate-for-tests-AAAAAAAAAAAAAAAAAAAAA",
  y: "y-coordinate-for-tests-BBBBBBBBBBBBBBBBBBBBB",
});
const NOW = 1_795_000_000;
const FIVE = [
  "graph:read",
  "graph:resolve-account",
  "org:read",
  "account:email-read",
  "step-up:verify",
];

const BRIDGE = `// cire-api's bridge
const ARC_SCOPE = "graph:read";
const ARC_RESOLVE_ACCOUNT_SCOPE = "graph:resolve-account";
// const ARC_RETIRED_SCOPE = "graph:write";
const ARC_ORG_READ_SCOPE = "org:read";
const ARC_ACCOUNT_EMAIL_SCOPE = "account:email-read";
  /* const ARC_INDENTED_SCOPE = "indented:never"; */
const ARC_STEP_UP_SCOPE = "step-up:verify";
`;
const GRAPH = `const PERMITTED_SCOPES = new Set([
  "graph:read",
  "graph:resolve-account",
  "account:erase",
  "step-up:verify",
  "app-enrollment:write",
  "org:read",
  "account:email-read",
]);
`;

interface Sent {
  readonly method: string;
  readonly url: string;
  readonly headers: Headers;
  readonly body: string | undefined;
  readonly redirect: RequestInit["redirect"];
}

type Answer = Response | Error | ((sent: Sent) => Response | Error);

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const cfOk = (result: unknown): Response =>
  json(200, { success: true, errors: [], messages: [], result });

/** A fake `fetch` answering each request with the next answer its route has queued. */
function fakeFetch(routes: Record<string, Answer[]>) {
  const sent: Sent[] = [];
  const impl = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const record: Sent = {
      method,
      url,
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
      redirect: init?.redirect,
    };
    sent.push(record);
    const key = Object.keys(routes).find((prefix) => `${method} ${url}`.startsWith(prefix));
    const queue = key === undefined ? undefined : routes[key];
    const next = queue?.shift();
    if (next === undefined) throw new Error(`unexpected ${method} ${url}`);
    const answer = typeof next === "function" ? next(record) : next;
    if (answer instanceof Error) throw answer;
    return answer;
  }) as typeof fetch;
  return { impl, sent };
}

interface Harness {
  readonly deps: Deps;
  readonly out: string[];
  readonly files: Map<string, string>;
  readonly sent: Sent[];
  readonly shown: { commit: string; path: string }[];
  readonly text: () => string;
}

function harness(
  options: {
    env?: Record<string, string | undefined>;
    routes?: Record<string, Answer[]>;
    deps?: Partial<Deps>;
    show?: (commit: string, path: string) => string | undefined;
  } = {},
): Harness {
  const out: string[] = [];
  const files = new Map<string, string>();
  const shown: { commit: string; path: string }[] = [];
  const { impl, sent } = fakeFetch(options.routes ?? {});
  const deps: Deps = {
    env: {
      GITHUB_OUTPUT: "/github/output",
      GITHUB_STEP_SUMMARY: "/github/summary",
      ...options.env,
    },
    fetch: impl,
    out: (line) => out.push(line),
    err: (line) => out.push(line),
    appendFile: (path, text) => files.set(path, (files.get(path) ?? "") + text),
    now: () => NOW,
    sleep: async () => {},
    randomUUID: () => KID,
    generatePublicJwk: async () => PUBLIC_JWK,
    readFile: (path) => (path.endsWith("osn-bridge.ts") ? BRIDGE : GRAPH),
    gitShow: (commit, path) => {
      shown.push({ commit, path });
      if (options.show !== undefined) return options.show(commit, path);
      return path.endsWith("osn-bridge.ts") ? BRIDGE : GRAPH;
    },
    productionCommits: async () =>
      new Map([
        ["cire_api", CIRE_COMMIT],
        ["osn_api", OSN_COMMIT],
      ]),
    ...options.deps,
  };
  return {
    deps,
    out,
    files,
    sent,
    shown,
    text: () => [...out, ...files.values()].join("\n"),
  };
}

/** Nothing secret, nothing from a body, nothing that names the account. */
function expectClean(h: Harness): void {
  const text = h.text();
  for (const value of [
    CANARY,
    BEARER,
    TOKEN,
    ACCOUNT,
    GH_TOKEN,
    KID,
    "x-coordinate",
    "y-coordinate",
  ]) {
    expect({ value, printed: text.includes(value) }).toEqual({ value, printed: false });
  }
}

// ── the window ──────────────────────────────────────────────────────────────

describe("the window", () => {
  const START = "2026-11-16T02:17:49Z";
  const END = "2026-11-17T00:59:22Z";

  test("W1: a value that is not YYYY-MM-DDTHH:MM:SSZ is a usage error that names the input, before any request", async () => {
    for (const bad of [
      "2026-11-16",
      "2026-11-16T02:17:49+10:00",
      "2026-11-16T02:17:49.000Z",
      "2026-11-16 02:17:49Z",
      "yesterday",
      "",
    ]) {
      const h = harness({
        env: {
          WINDOW_START: bad,
          WINDOW_END: END,
          CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
          CLOUDFLARE_API_TOKEN: TOKEN,
        },
      });
      expect(await run(["count-deletion-fanouts"], h.deps)).toBe(2);
      expect(h.text()).toContain("WINDOW_START");
      expect(h.sent).toEqual([]);
    }
    const missing = harness({ env: { WINDOW_START: START } });
    expect(await run(["check-window"], missing.deps)).toBe(2);
    expect(missing.text()).toContain("WINDOW_END");
  });

  test("W2: a date that does not exist is a usage error", () => {
    expect(() => parseWindow({ WINDOW_START: "2026-02-30T00:00:00Z", WINDOW_END: END })).toThrow(
      "WINDOW_START",
    );
    expect(() => parseWindow({ WINDOW_START: START, WINDOW_END: "2026-11-17T24:00:00Z" })).toThrow(
      "WINDOW_END",
    );
  });

  test("W3: an end that is not after the start is a usage error", async () => {
    expect(() => parseWindow({ WINDOW_START: END, WINDOW_END: START })).toThrow("after");
    expect(() => parseWindow({ WINDOW_START: START, WINDOW_END: START })).toThrow("after");
    const h = harness({ env: { WINDOW_START: END, WINDOW_END: START } });
    expect(await run(["check-window"], h.deps)).toBe(2);
  });

  test("W4: a good window gives its unix seconds, and check-window prints it and nothing else", async () => {
    expect(parseWindow({ WINDOW_START: START, WINDOW_END: END })).toMatchObject({
      start: 1794795469,
      end: 1794877162,
    });
    const h = harness({ env: { WINDOW_START: START, WINDOW_END: END } });
    expect(await run(["check-window"], h.deps)).toBe(0);
    expect(h.out).toEqual([`Window: ${START} to ${END}, both ends included.`]);
    expect(h.sent).toEqual([]);
  });
});

// ── count-deletion-fanouts ──────────────────────────────────────────────────

describe("count-deletion-fanouts", () => {
  const LIST = `GET https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database?`;
  const QUERY = `POST https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${UUID}/query`;
  const env = {
    WINDOW_START: "2026-11-16T02:17:49Z",
    WINDOW_END: "2026-11-17T00:59:22Z",
    CLOUDFLARE_ACCOUNT_ID: ACCOUNT,
    CLOUDFLARE_API_TOKEN: TOKEN,
  };
  const listed = (databases: unknown[]) => cfOk(databases);
  const zap = { uuid: UUID, name: ZAP_DATABASE, version: "production", num_tables: 4 };
  const counted = (row: unknown) =>
    cfOk([{ results: [row], success: true, meta: { rows_read: 9, duration: 1 } }]);

  test("C1: one listing, one read-only query, and the two counts with their labels, nothing else", async () => {
    const h = harness({
      env,
      routes: {
        [LIST]: [listed([{ ...zap, name: "zap-db-prod-old", uuid: CANARY }, zap])],
        [QUERY]: [counted({ in_window: 2, total: 7 })],
      },
    });
    expect(await run(["count-deletion-fanouts"], h.deps)).toBe(0);
    expect(h.sent.map((s) => s.method)).toEqual(["GET", "POST"]);
    expect(h.sent[0]?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database?name=zap-db-prod&per_page=100`,
    );
    for (const s of h.sent) {
      expect(s.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(s.redirect).toBe("manual");
    }
    expect(JSON.parse(h.sent[1]?.body ?? "")).toEqual({
      sql: countSql({ start: 1794795469, end: 1794877162 }),
    });
    const lines = [
      "Zap erasures recorded in zap_account_purges (zap-db-prod):",
      "  processed from 2026-11-16T02:17:49Z to 2026-11-17T00:59:22Z, both ends included: 2",
      "  total: 7",
    ];
    expect(h.out).toEqual(lines);
    expect(h.files.get("/github/summary")).toBe(`${lines.join("\n")}\n`);
    expect(h.files.has("/github/output")).toBe(false);
    expectClean(h);
  });

  test("C2: the query counts rows on both edges as inside, one second past either edge as outside, and every row in the total", () => {
    const db = new Database(":memory:");
    const dir = join(root, "zap/db/drizzle");
    for (const file of listMigrations(dir)) {
      for (const statement of migrationStatements(readFileSync(join(dir, file), "utf8"))) {
        db.exec(statement);
      }
    }
    const start = 1794795469;
    const end = 1794877162;
    const insert = db.prepare(
      "INSERT INTO zap_account_purges (account_id, processed_at, kept_messages) VALUES (?, ?, 0)",
    );
    for (const [id, at] of [
      ["before", start - 1],
      ["start", start],
      ["middle", start + 3600],
      ["end", end],
      ["after", end + 1],
    ] as const) {
      insert.run(id, at);
    }
    const row = db.query(countSql({ start, end })).get();
    expect(row).toEqual({ in_window: 3, total: 5 });
    expect(() => countSql({ start: 1.5, end })).toThrow();
  });

  test("C3: no database of that exact name, or two, refuses before any query", async () => {
    for (const databases of [
      [],
      [{ ...zap, name: "zap-db-prod-2" }],
      [zap, { ...zap, uuid: "7f1c2a8e-3b4d-4e5f-8a9b-0c1d2e3f4a5b" }],
      [{ ...zap, uuid: CANARY }],
    ]) {
      const h = harness({ env, routes: { [LIST]: [listed(databases)] } });
      expect(await run(["count-deletion-fanouts"], h.deps)).toBe(1);
      expect(h.sent.map((s) => s.method)).toEqual(["GET"]);
      expectClean(h);
    }
  });

  test("C4: a refusal prints the status and Cloudflare's error codes, never the body or the account", async () => {
    for (const answer of [
      json(403, { success: false, errors: [{ code: 10000, message: CANARY }], result: null }),
      json(404, { success: false, errors: [{ code: 7003, message: `${CANARY} ${ACCOUNT}` }] }),
      json(200, { success: false, errors: [{ code: 7500, message: CANARY }], result: CANARY }),
      new Response(`<html>${CANARY}</html>`, { status: 400 }),
      new Response(CANARY, { status: 302, headers: { location: `https://${CANARY}.example` } }),
    ]) {
      const h = harness({ env, routes: { [LIST]: [answer] } });
      expect(await run(["count-deletion-fanouts"], h.deps)).toBe(1);
      expect(h.text()).toContain(`answered ${answer.status}`);
      expectClean(h);
    }
    const codes = harness({
      env,
      routes: {
        [LIST]: [json(403, { success: false, errors: [{ code: 10000, message: CANARY }] })],
      },
    });
    await run(["count-deletion-fanouts"], codes.deps);
    expect(codes.text()).toContain("codes 10000");

    // Only whole-number codes are printed: anything else in `code` is body text.
    const mixed = harness({
      env,
      routes: {
        [LIST]: [
          json(403, {
            success: false,
            errors: [{ code: CANARY }, { code: 1.5 }, { code: `${CANARY}9` }, { code: 9109 }],
          }),
        ],
      },
    });
    expect(await run(["count-deletion-fanouts"], mixed.deps)).toBe(1);
    expect(mixed.text()).toContain("answered 403, codes 9109.");
    expect(mixed.text()).not.toContain("1.5");
    expectClean(mixed);
  });

  test("C5: a network error, a 429 or a 5xx is tried again after 1 s then 2 s; three in a row refuse, naming the last error's class alone", async () => {
    const h = harness({
      env,
      routes: {
        [LIST]: [
          new TypeError(CANARY),
          json(503, { errors: [{ message: CANARY }] }),
          listed([zap]),
        ],
        [QUERY]: [json(429, {}), counted({ in_window: 0, total: 0 })],
      },
    });
    expect(await run(["count-deletion-fanouts"], h.deps)).toBe(0);
    expect(h.out.at(-1)).toBe("  total: 0");
    expectClean(h);

    const waits: number[] = [];
    const down = harness({
      env,
      routes: { [LIST]: [new TypeError(CANARY), json(500, {}), json(502, { e: CANARY })] },
      deps: { sleep: async (ms) => void waits.push(ms) },
    });
    expect(await run(["count-deletion-fanouts"], down.deps)).toBe(1);
    expect(down.sent).toHaveLength(3);
    expect(waits).toEqual([1000, 2000]);
    expect(down.text()).toContain("the last answered 502");
    expectClean(down);

    // The last try's error decides the message: its class, never its text.
    const unreachable = harness({
      env,
      routes: {
        [LIST]: [
          new TypeError(`${CANARY}1`),
          new TypeError(`${CANARY}2`),
          new DOMException(`${CANARY}3 ${ACCOUNT}`, "TimeoutError"),
        ],
      },
    });
    expect(await run(["count-deletion-fanouts"], unreachable.deps)).toBe(1);
    expect(unreachable.text()).toContain("did not complete (TimeoutError)");
    expectClean(unreachable);
  });

  test("C6: a query answer of any other shape refuses and prints nothing from it", async () => {
    const shapes: Response[] = [
      new Response(CANARY, { status: 200 }),
      json(200, { success: true, result: CANARY }),
      cfOk([{ results: [{ in_window: 1, total: 2 }], success: false, error: CANARY }]),
      cfOk([
        { results: [{ in_window: 1, total: 2 }], success: true },
        { results: [{ in_window: CANARY }], success: true },
      ]),
      counted(undefined),
      cfOk([{ results: [], success: true }]),
      cfOk([
        {
          results: [
            { in_window: 1, total: 2 },
            { in_window: 1, total: 2 },
          ],
          success: true,
        },
      ]),
      counted({ in_window: CANARY, total: 2 }),
      counted({ in_window: 1.5, total: 2 }),
      counted({ in_window: -1, total: 2 }),
      counted({ in_window: 3, total: 2 }),
      counted({ in_window: 1, total: 2, account_id: CANARY }),
    ];
    for (const answer of shapes) {
      const h = harness({ env, routes: { [LIST]: [listed([zap])], [QUERY]: [answer] } });
      expect(await run(["count-deletion-fanouts"], h.deps)).toBe(1);
      expect(h.out.some((line) => line.startsWith("  total"))).toBe(false);
      expectClean(h);
    }
  });

  test("C7: without either Cloudflare variable it is a usage error, before any request", async () => {
    for (const drop of ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"]) {
      const h = harness({ env: { ...env, [drop]: "" } });
      expect(await run(["count-deletion-fanouts"], h.deps)).toBe(2);
      expect(h.text()).toContain(drop);
      expect(h.sent).toEqual([]);
    }
  });
});

// ── the scopes production cire-api signs with ───────────────────────────────

describe("plan-register", () => {
  const env = { GITHUB_TOKEN: GH_TOKEN, GITHUB_REPOSITORY: "englishstreetventures/osn" };

  test("P1: reads osn-bridge.ts at production cire-api's commit and the allowlist at osn-api's, and writes both outputs", async () => {
    const h = harness({ env });
    expect(await run(["plan-register"], h.deps)).toBe(0);
    expect(h.shown).toEqual([
      { commit: CIRE_COMMIT, path: "cire/api/src/services/osn-bridge.ts" },
      { commit: OSN_COMMIT, path: "osn/api/src/routes/graph-internal.ts" },
    ]);
    expect(h.files.get("/github/output")).toBe(`commit=${CIRE_COMMIT}\nscopes=${FIVE.join(",")}\n`);
    expect(h.files.get("/github/summary")).toContain(FIVE.join(", "));
    expect(h.text()).toContain(CIRE_COMMIT);
    expect(h.sent).toEqual([]);
    expectClean(h);
  });

  test("P2: no trusted production record, or a commit that is not a full SHA, refuses", async () => {
    for (const commits of [
      new Map<string, string>(),
      new Map([["osn_api", OSN_COMMIT]]),
      new Map([["cire_api", CIRE_COMMIT]]),
      new Map([
        ["cire_api", `${CIRE_COMMIT.slice(0, 39)};`],
        ["osn_api", OSN_COMMIT],
      ]),
      new Map([
        ["cire_api", "HEAD"],
        ["osn_api", OSN_COMMIT],
      ]),
    ]) {
      const h = harness({ env, deps: { productionCommits: async () => commits } });
      expect(await run(["plan-register"], h.deps)).toBe(1);
      expect(h.shown).toEqual([]);
      expect(h.files.has("/github/output")).toBe(false);
    }
  });

  test("P3: a file git cannot show, or one with no scope, refuses", async () => {
    for (const show of [
      () => undefined,
      (_: string, path: string) => (path.endsWith("osn-bridge.ts") ? "// nothing here\n" : GRAPH),
      (_: string, path: string) => (path.endsWith("osn-bridge.ts") ? BRIDGE : undefined),
      (_: string, path: string) => (path.endsWith("osn-bridge.ts") ? BRIDGE : "// no allowlist\n"),
    ]) {
      const h = harness({ env, show });
      expect(await run(["plan-register"], h.deps)).toBe(1);
      expect(h.files.has("/github/output")).toBe(false);
    }
  });

  test("P4: a scope production osn-api does not permit refuses before approval", async () => {
    const h = harness({
      env,
      show: (_, path) =>
        path.endsWith("osn-bridge.ts") ? `${BRIDGE}const ARC_NEW_SCOPE = "events:read";\n` : GRAPH,
    });
    expect(await run(["plan-register"], h.deps)).toBe(1);
    expect(h.text()).toContain("events:read");
    expect(h.files.has("/github/output")).toBe(false);
  });

  test("P5: when main's list differs, both are shown and production's is written", async () => {
    const h = harness({
      env,
      deps: { readFile: () => `${BRIDGE}const ARC_NEXT_SCOPE = "account:erase";\n` },
    });
    expect(await run(["plan-register"], h.deps)).toBe(0);
    expect(
      h.out.some((line) => line.startsWith("::notice::") && line.includes("account:erase")),
    ).toBe(true);
    expect(h.files.get("/github/output")).toContain(`scopes=${FIVE.join(",")}\n`);
  });

  test("P6: the scopes are read from line-start constants only, in source order, once each", () => {
    expect(scopesIn(BRIDGE)).toEqual(FIVE);
    expect(scopesIn(`${BRIDGE}const ARC_AGAIN_SCOPE = "org:read";\n`)).toEqual(FIVE);
    expect(scopesIn(readRepo("cire/api/src/services/osn-bridge.ts"))).toEqual(FIVE);
    const permitted = permittedIn(readRepo("osn/api/src/routes/graph-internal.ts"));
    expect(FIVE.filter((scope) => !permitted.includes(scope))).toEqual([]);
    expect(() => scopesIn('const ARC_BAD_SCOPE = "Graph Read";\n')).toThrow();
  });

  test("P7: without GITHUB_TOKEN or GITHUB_REPOSITORY it is a usage error, before any lookup", async () => {
    for (const drop of ["GITHUB_TOKEN", "GITHUB_REPOSITORY"]) {
      let looked = false;
      const h = harness({
        env: { ...env, [drop]: undefined },
        deps: {
          productionCommits: async () => {
            looked = true;
            return new Map();
          },
        },
      });
      expect(await run(["plan-register"], h.deps)).toBe(2);
      expect(h.text()).toContain(drop);
      expect(looked).toBe(false);
    }
  });

  test("P8: an error from GitHub's API names its class alone, never the body the client quotes", async () => {
    const { impl } = fakeFetch({ "GET https://api.github.com/": [json(500, { message: CANARY })] });
    const h = harness({
      env,
      deps: { productionCommits: () => lookupProductionCommits(impl, env) },
    });
    expect(await run(["plan-register"], h.deps)).toBe(1);
    expect(h.text()).toContain("deployment records");
    expectClean(h);
  });

  test("P10: the real lookup sends GITHUB_TOKEN to GitHub's API alone, and never follows a redirect with it", async () => {
    const { impl, sent } = fakeFetch({
      "GET https://api.github.com/": [
        new Response(CANARY, { status: 302, headers: { location: `https://${CANARY}.example` } }),
      ],
    });
    await expect(lookupProductionCommits(impl, env)).rejects.toThrow();
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) {
      expect(s.url.startsWith("https://api.github.com/repos/englishstreetventures/osn/")).toBe(
        true,
      );
      expect(s.redirect).toBe("error");
      expect(s.headers.get("authorization")).toBe(`Bearer ${GH_TOKEN}`);
    }
  });

  test("P9: the real git lookup answers nothing for a commit it lacks and for a path that is not a file", () => {
    expect(gitShow("0".repeat(40), "cire/api/src/services/osn-bridge.ts")).toBeUndefined();
    expect(gitShow("HEAD", "cire/api/src/services/no-such-file.ts")).toBeUndefined();
    expect(gitShow("HEAD", "cire/api/src/services/osn-bridge.ts")).toContain("ARC_STEP_UP_SCOPE");
  });
});

// ── register-cire-arc ───────────────────────────────────────────────────────

describe("register-cire-arc", () => {
  const REGISTER = `POST https://${PRODUCTION_HOSTS.osnApi}/graph/internal/register-service`;
  const REVOKE = `DELETE https://${PRODUCTION_HOSTS.osnApi}/graph/internal/service-keys/`;
  const env = {
    INTERNAL_SERVICE_SECRET: BEARER,
    EXPECTED_COMMIT: CIRE_COMMIT,
    GITHUB_TOKEN: GH_TOKEN,
    GITHUB_REPOSITORY: "englishstreetventures/osn",
  };

  test("R1: one POST with a born-expired throwaway key and production's scopes, then its revoke, each with the bearer, the CI user agent and no redirect", async () => {
    const h = harness({
      env,
      routes: { [REGISTER]: [json(200, { ok: true })], [REVOKE]: [json(200, { ok: true })] },
    });
    expect(await run(["register-cire-arc"], h.deps)).toBe(0);
    expect(h.sent.map((s) => `${s.method} ${s.url}`)).toEqual([`${REGISTER}`, `${REVOKE}${KID}`]);
    for (const s of h.sent) {
      expect(s.headers.get("authorization")).toBe(`Bearer ${BEARER}`);
      // Cloudflare's Bot Fight Mode answers a runner's request that carries
      // Bun's own user agent in osn-api's place (scripts/smoke-check.ts).
      expect(s.headers.get("user-agent")).toBe(CI_USER_AGENT);
      expect(s.redirect).toBe("manual");
    }
    expect(JSON.parse(h.sent[0]?.body ?? "")).toEqual({
      serviceId: "cire-api",
      keyId: KID,
      publicKeyJwk: PUBLIC_JWK,
      allowedScopes: FIVE.join(","),
      expiresAt: NOW - 60,
    });
    expect(h.sent[0]?.headers.get("content-type")).toBe("application/json");
    const text = h.text();
    expect(text).toContain("answered 200");
    expect(text).toContain(FIVE.join(", "));
    expect(text).toContain("5 minutes");
    expect(h.files.has("/github/output")).toBe(false);
    expectClean(h);
  });

  test("R2: the real key is an ECDSA P-256 public key with kty, crv, x and y alone, and the real clock is in whole seconds", async () => {
    const jwk = JSON.parse(await generatePublicJwk()) as {
      readonly kty?: string;
      readonly crv?: string;
      readonly x?: string;
      readonly y?: string;
    };
    expect(Object.keys(jwk).toSorted()).toEqual(["crv", "kty", "x", "y"]);
    expect(jwk).toMatchObject({ kty: "EC", crv: "P-256" });
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"],
    );
    expect(key.type).toBe("public");
    const now = nowSeconds();
    expect(Number.isInteger(now)).toBe(true);
    expect(Math.abs(now - Date.now() / 1000)).toBeLessThan(5);
  });

  test("R3: a refusal from osn-api prints its status and that status's hint, never the body; the key is revoked after a 5xx and left alone after a 3xx or 4xx, which wrote nothing", async () => {
    const hints: [number, string][] = [
      [302, "never follows with the bearer"],
      [400, "a scope it does not permit"],
      [401, "INTERNAL_SERVICE_SECRET is not the value osn-api holds"],
      [403, "in front of osn-api"],
      [404, "no such route"],
      [409, "revoked or as another service's"],
      [422, "body malformed"],
      [429, "limited the rate"],
      [500, "did not store the scopes"],
      [501, "registration is off"],
      [503, "unavailable"],
    ];
    for (const [status, hint] of hints) {
      const h = harness({
        env,
        routes: {
          [REGISTER]: [
            new Response(CANARY, { status, headers: { location: `https://${CANARY}.example` } }),
          ],
          [REVOKE]: [json(404, { error: CANARY })],
        },
      });
      expect(await run(["register-cire-arc"], h.deps)).toBe(1);
      expect(h.text()).toContain(`answered ${status}`);
      expect({ status, hinted: h.text().includes(hint) }).toEqual({ status, hinted: true });
      expect({ status, sent: h.sent.map((s) => s.method) }).toEqual({
        status,
        sent: status >= 500 ? ["POST", "DELETE"] : ["POST"],
      });
      expectClean(h);
    }
  });

  test("R13: an answer carrying cf-mitigated says Cloudflare answered in osn-api's place, naming the header's value only when it is one short word, never the body", async () => {
    const challenged = harness({
      env,
      routes: {
        [REGISTER]: [
          new Response(`<html>${CANARY}</html>`, {
            status: 403,
            headers: { "cf-mitigated": "challenge", "content-type": "text/html" },
          }),
        ],
      },
    });
    expect(await run(["register-cire-arc"], challenged.deps)).toBe(1);
    expect(challenged.text()).toContain(
      "The registration answered 403. Cloudflare answered in osn-api's place (cf-mitigated: challenge); the request never reached osn-api.",
    );
    expect(challenged.text()).not.toContain("in front of osn-api refused");
    expect(challenged.sent.map((s) => s.method)).toEqual(["POST"]);
    expectClean(challenged);

    const odd = harness({
      env,
      routes: {
        [REGISTER]: [
          new Response(CANARY, { status: 403, headers: { "cf-mitigated": `${CANARY} challenge` } }),
        ],
      },
    });
    expect(await run(["register-cire-arc"], odd.deps)).toBe(1);
    expect(odd.text()).toContain("Cloudflare answered in osn-api's place (cf-mitigated);");
    expectClean(odd);
  });

  test("R4: a 200 that does not say ok refuses", async () => {
    for (const body of [
      json(200, { ok: false }),
      json(200, { error: CANARY }),
      new Response(CANARY),
    ]) {
      const h = harness({
        env,
        routes: { [REGISTER]: [body], [REVOKE]: [json(200, { ok: true })] },
      });
      expect(await run(["register-cire-arc"], h.deps)).toBe(1);
      expectClean(h);
    }
  });

  test("R5: a request that throws prints the error's class alone, and the revoke is still sent", async () => {
    const h = harness({
      env,
      routes: {
        [REGISTER]: [new TypeError(`${CANARY} ${BEARER}`)],
        [REVOKE]: [json(200, { ok: true })],
      },
    });
    expect(await run(["register-cire-arc"], h.deps)).toBe(1);
    expect(h.text()).toContain("TypeError");
    expect(h.sent.map((s) => s.method)).toEqual(["POST", "DELETE"]);
    expectClean(h);
  });

  test("R6: a failed revoke after a stored registration is a warning, and the run succeeds", async () => {
    for (const revoke of [json(500, { error: CANARY }), new TypeError(CANARY)]) {
      const h = harness({
        env,
        routes: { [REGISTER]: [json(200, { ok: true })], [REVOKE]: [revoke] },
      });
      expect(await run(["register-cire-arc"], h.deps)).toBe(0);
      expect(h.out.some((line) => line.startsWith("::warning::"))).toBe(true);
      expectClean(h);
    }
  });

  test("R10: the job registers the scopes it reads again at production cire-api's commit, not main's, and refuses one production osn-api does not permit", async () => {
    const h = harness({
      env,
      routes: { [REGISTER]: [json(200, { ok: true })], [REVOKE]: [json(200, { ok: true })] },
      deps: { readFile: () => 'const ARC_SCOPE = "graph:read";\n' },
    });
    expect(await run(["register-cire-arc"], h.deps)).toBe(0);
    expect(h.shown).toEqual([
      { commit: CIRE_COMMIT, path: "cire/api/src/services/osn-bridge.ts" },
      { commit: OSN_COMMIT, path: "osn/api/src/routes/graph-internal.ts" },
    ]);
    expect(JSON.parse(h.sent[0]?.body ?? "")).toMatchObject({ allowedScopes: FIVE.join(",") });

    const refused = harness({
      env,
      show: (_, path) =>
        path.endsWith("osn-bridge.ts") ? `${BRIDGE}const ARC_NEW_SCOPE = "events:read";\n` : GRAPH,
    });
    expect(await run(["register-cire-arc"], refused.deps)).toBe(1);
    expect(refused.text()).toContain("events:read");
    expect(refused.sent).toEqual([]);
  });

  test("R11: an error no action expected prints its class alone", async () => {
    const h = harness({
      env,
      deps: {
        generatePublicJwk: async () => {
          throw new RangeError(`${CANARY} ${BEARER}`);
        },
      },
    });
    expect(await run(["register-cire-arc"], h.deps)).toBe(1);
    expect(h.out).toEqual(["::error::register-cire-arc failed (RangeError)."]);
    expect(h.sent).toEqual([]);
    expectClean(h);
  });

  // register-cire-arc reaches cire-api's own key only because osn-api keeps
  // a service's scopes on the service: the registration upserts them by
  // serviceId alone, and verification joins every key of a service to that
  // one row. If scopes ever move onto the key, the action changes nothing
  // while reporting success, and this fails first.
  test("R12: osn-api keeps a service's scopes on the service row, which the throwaway-key renewal relies on", () => {
    const route = readRepo("osn/api/src/routes/graph-internal.ts");
    expect(route).toMatch(
      /\.insert\(serviceAccounts\)[\s\S]*?\.onConflictDoUpdate\(\{\s*target: serviceAccounts\.serviceId,\s*set: \{ allowedScopes: body\.allowedScopes\b/,
    );
    const arc = readRepo("shared/crypto/src/arc.ts");
    expect(arc).toMatch(/allowedScopes: serviceAccounts\.allowedScopes,/);
    expect(arc).toMatch(
      /\.innerJoin\(serviceAccounts, eq\(serviceAccountKeys\.serviceId, serviceAccounts\.serviceId\)\)/,
    );
    const schema = readRepo("osn/db/src/schema/index.ts");
    const keys = /sqliteTable\(\s*"service_account_keys",\s*\{([\s\S]*?)\n {2}\},/.exec(
      schema,
    )?.[1];
    expect(keys).toContain("public_key_jwk");
    expect(keys).not.toMatch(/scope/i);
  });

  test("R7: a production commit other than the one the check job read refuses before any request", async () => {
    const h = harness({ env: { ...env, EXPECTED_COMMIT: "c".repeat(40) } });
    expect(await run(["register-cire-arc"], h.deps)).toBe(1);
    expect(h.text()).toContain("c".repeat(40));
    expect(h.sent).toEqual([]);
    for (const bad of ["", "HEAD", CIRE_COMMIT.slice(1)]) {
      const usage = harness({ env: { ...env, EXPECTED_COMMIT: bad } });
      expect(await run(["register-cire-arc"], usage.deps)).toBe(2);
      expect(usage.sent).toEqual([]);
    }
  });

  test("R8: without the bearer it is a usage error, before any lookup or request", async () => {
    let looked = false;
    const h = harness({
      env: { ...env, INTERNAL_SERVICE_SECRET: "" },
      deps: {
        productionCommits: async () => {
          looked = true;
          return new Map();
        },
      },
    });
    expect(await run(["register-cire-arc"], h.deps)).toBe(2);
    expect(h.text()).toContain("INTERNAL_SERVICE_SECRET");
    expect(looked).toBe(false);
    expect(h.sent).toEqual([]);
  });

  test("R9: the host is osn-api's production issuer, and the database is zap-api's production one", () => {
    const osnToml = Bun.TOML.parse(readRepo("osn/api/wrangler.toml")) as {
      env: { production: { vars: { OSN_ISSUER_URL: string } } };
    };
    expect(`https://${PRODUCTION_HOSTS.osnApi}`).toBe(osnToml.env.production.vars.OSN_ISSUER_URL);
    const zapToml = Bun.TOML.parse(readRepo("zap/api/wrangler.toml")) as {
      env: { production: { d1_databases: { database_name: string }[] } };
    };
    expect(zapToml.env.production.d1_databases.map((d) => d.database_name)).toEqual([ZAP_DATABASE]);
  });
});

// ── the command line ────────────────────────────────────────────────────────

describe("the command line", () => {
  async function cli(args: string[]) {
    const proc = Bun.spawn(["bun", "--no-install", "scripts/production-operator.ts", ...args], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" },
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { output: stdout + stderr, exitCode };
  }

  test("X1: each action, run as the workflow runs it with no variables, exits 2 naming what is missing", async () => {
    for (const [action, missing] of [
      ["check-window", "WINDOW_START"],
      ["plan-register", "GITHUB_TOKEN"],
      ["register-cire-arc", "INTERNAL_SERVICE_SECRET"],
      ["count-deletion-fanouts", "WINDOW_START"],
    ] as const) {
      const result = await cli([action]);
      expect({ action, exitCode: result.exitCode }).toEqual({ action, exitCode: 2 });
      expect(result.output).toContain(missing);
    }
  });

  test("X2: an unknown action, none, or a known one with anything after it exits 2", async () => {
    expect((await cli(["set-secret"])).exitCode).toBe(2);
    expect((await cli(["constructor"])).exitCode).toBe(2);
    expect((await cli([])).exitCode).toBe(2);
    const h = harness({
      env: { WINDOW_START: "2026-11-16T02:17:49Z", WINDOW_END: "2026-11-17T00:59:22Z" },
    });
    expect(await run(["check-window", "--force"], h.deps)).toBe(2);
    expect(h.out).toEqual([
      "::error::production-operator: usage: production-operator.ts <check-window|plan-register|register-cire-arc|count-deletion-fanouts>",
    ]);
  });
});

// ── the workflow ────────────────────────────────────────────────────────────

interface Step {
  readonly name?: string;
  readonly id?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Readonly<Record<string, unknown>>;
  readonly env?: Readonly<Record<string, string>>;
}

interface Job {
  readonly name?: string;
  readonly needs?: string | readonly string[];
  readonly if?: string;
  readonly environment?: unknown;
  readonly permissions?: unknown;
  readonly env?: unknown;
  readonly steps?: readonly Step[];
}

interface Workflow {
  readonly on: Readonly<Record<string, unknown>>;
  readonly env?: unknown;
  readonly permissions?: unknown;
  readonly jobs: Readonly<Record<string, Job>>;
}

describe("the workflow", () => {
  const workflow = Bun.YAML.parse(
    readRepo(".github/workflows/production-operator.yml"),
  ) as Workflow;
  const dispatch = workflow.on.workflow_dispatch as {
    inputs: Record<
      string,
      { type?: string; options?: string[]; default?: unknown; required?: boolean }
    >;
  };
  const ACTIONS = ["count-deletion-fanouts", "register-cire-arc"];
  const secretsRead = (fragment: unknown): string[] =>
    [
      ...new Set(
        [...JSON.stringify(fragment ?? {}).matchAll(/\bsecrets\.([A-Za-z0-9_]+)/g)].map(
          (m) => m[1] ?? "",
        ),
      ),
    ].toSorted();
  const steps = (job: string): readonly Step[] => workflow.jobs[job]?.steps ?? [];

  test("F1: it runs only when dispatched", () => {
    expect(Object.keys(workflow.on)).toEqual(["workflow_dispatch"]);
  });

  test("F2: the check job holds no secret and no Environment, and refuses any ref but main", () => {
    const check = workflow.jobs.check;
    expect(check?.environment).toBeUndefined();
    expect(secretsRead(check)).toEqual([]);
    const refuse = steps("check")[0];
    expect(refuse?.if).toBe("github.ref != 'refs/heads/main'");
    expect(refuse?.run).toContain("exit 1");
  });

  test("F3: each action is one job, under the production Environment, after the check, that runs only for its own action; the input has no default", () => {
    expect(dispatch.inputs.action?.options).toEqual(ACTIONS);
    expect(dispatch.inputs.action?.default).toBeUndefined();
    expect(dispatch.inputs.action?.required).toBe(true);
    expect(Object.keys(workflow.jobs).toSorted()).toEqual(["check", ...ACTIONS].toSorted());
    for (const action of ACTIONS) {
      const job = workflow.jobs[action];
      expect({ action, environment: job?.environment, needs: job?.needs, if: job?.if }).toEqual({
        action,
        environment: "production",
        needs: "check",
        if: `inputs.action == '${action}'`,
      });
    }
  });

  test("F4: each job reads exactly the secrets its action needs, on its one action step", () => {
    expect(secretsRead(workflow.env)).toEqual([]);
    for (const job of Object.values(workflow.jobs)) expect(secretsRead(job.env)).toEqual([]);
    const reading = (job: string) =>
      steps(job)
        .filter((step) => secretsRead(step).length > 0)
        .map((step) => ({ run: step.run, secrets: secretsRead(step) }));
    expect(reading("register-cire-arc")).toEqual([
      {
        run: "bun --no-install scripts/production-operator.ts register-cire-arc",
        secrets: ["INTERNAL_SERVICE_SECRET"],
      },
    ]);
    expect(reading("count-deletion-fanouts")).toEqual([
      {
        run: "bun --no-install scripts/production-operator.ts count-deletion-fanouts",
        secrets: ["CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN"],
      },
    ]);
  });

  test("F5: no run line expands an expression: inputs and secrets reach a step through env alone", () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) expect(step.run ?? "").not.toContain("${{");
    }
  });

  test("F6: nothing is installed or fetched, and every script runs with --no-install", () => {
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps ?? []) {
        const line = step.run ?? "";
        expect(line).not.toMatch(
          /\bbun (install|i|add)\b|\bbunx\b|\bnpx\b|\bnpm\b|\bcurl\b|\bwget\b/,
        );
        if (line.includes("scripts/")) expect(line).toMatch(/^bun --no-install scripts\//);
        if (step.uses !== undefined) {
          expect(step.uses).toMatch(/^(actions\/checkout|oven-sh\/setup-bun)@/);
        }
      }
    }
  });

  test("F7: the check job runs each action's own check, and the register job refuses unless production is at the commit the check job showed", () => {
    const scriptSteps = (job: string) =>
      steps(job).filter((step) => step.run?.includes("scripts/"));
    expect(
      scriptSteps("check").map((step) => ({
        id: step.id,
        if: step.if,
        run: step.run,
        env: step.env,
      })),
    ).toEqual([
      {
        id: undefined,
        if: "inputs.action == 'count-deletion-fanouts'",
        run: "bun --no-install scripts/production-operator.ts check-window",
        env: { WINDOW_START: "${{ inputs.window_start }}", WINDOW_END: "${{ inputs.window_end }}" },
      },
      {
        id: "plan",
        if: "inputs.action == 'register-cire-arc'",
        run: "bun --no-install scripts/production-operator.ts plan-register",
        env: { GITHUB_TOKEN: "${{ github.token }}" },
      },
    ]);
    expect((workflow.jobs.check as { outputs?: unknown }).outputs).toMatchObject({
      commit: "${{ steps.plan.outputs.commit }}",
    });
    expect(scriptSteps("register-cire-arc")[0]?.env).toEqual({
      INTERNAL_SERVICE_SECRET: "${{ secrets.INTERNAL_SERVICE_SECRET }}",
      EXPECTED_COMMIT: "${{ needs.check.outputs.commit }}",
      GITHUB_TOKEN: "${{ github.token }}",
    });
    expect(scriptSteps("count-deletion-fanouts")[0]?.env).toMatchObject({
      WINDOW_START: "${{ inputs.window_start }}",
      WINDOW_END: "${{ inputs.window_end }}",
    });
    // The lookup reads deployment records, and the scopes at older commits,
    // which only the registration needs: the count's check takes one commit.
    // `0` is false in an expression, so the condition is on the other side.
    const depth = (job: string) =>
      steps(job).find((step) => step.uses?.startsWith("actions/checkout@"))?.with?.["fetch-depth"];
    expect(depth("check")).toBe("${{ inputs.action != 'register-cire-arc' && 1 || 0 }}");
    expect(depth("register-cire-arc")).toBe(0);
    for (const job of ["check", "register-cire-arc"]) {
      expect(workflow.jobs[job]?.permissions).toEqual({
        contents: "read",
        deployments: "read",
        actions: "read",
      });
    }
  });
});
