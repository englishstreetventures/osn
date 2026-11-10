// scripts/pages-domain.ts reads where a production site's host is — its
// Pages project, a Worker, or neither — and moves it between the two. These
// drive it with an injected fetch standing in for the Cloudflare API.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  type PerSite,
  PRODUCTION_SITE_MODES,
  type SiteMode,
} from "../../shared/infra/src/production-sites";
import {
  ApiError,
  classify,
  type DnsRecord,
  type ObservedAttempt,
  pagesDnsApi,
  runPagesDomain,
} from "../pages-domain";

const ACCOUNT = "0123456789abcdef0123456789abcdef";
const TOKEN = "pages-dns-token-for-tests";
const ENV = { CLOUDFLARE_ACCOUNT_ID: ACCOUNT, CLOUDFLARE_PAGES_DNS_TOKEN: TOKEN };
const API = "https://api.cloudflare.com/client/v4";
const ZONE = { "cireweddings.com": "zone-cire", "musubi.social": "zone-musubi" } as const;

const ok = (result: unknown, info?: unknown) =>
  new Response(JSON.stringify({ success: true, errors: [], result, result_info: info }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const failed = (status: number, code: number) =>
  new Response(JSON.stringify({ success: false, errors: [{ code, message: `no ${ACCOUNT}` }] }), {
    status,
  });

const CNAME = (project: string): DnsRecord => ({
  id: `rec-${project}`,
  type: "CNAME",
  content: `${project}.pages.dev`,
});
const WORKER: DnsRecord = {
  id: "rec-worker",
  type: "AAAA",
  content: "100::",
  meta: { origin_worker_id: "abc123", read_only: true },
};

/** Pages projects and their domains, and the DNS records per host. */
interface World {
  projects: Record<string, string[]>;
  records: Record<string, DnsRecord[]>;
  /** Answers a path with this instead, for an API failure. */
  fail?: Record<string, Response>;
  /** Projects per page of the projects list; 25 unless set. */
  perPage?: number;
  /** `result_info` of the projects list: `total_pages` and `page` unless set otherwise. */
  pageInfo?: "omit-total" | ((page: number, total: number) => Record<string, unknown>);
  /** Answers every page of the projects list with the first, as a server that ignores `?page`. */
  ignorePage?: boolean;
  /** What the token's zone listing answers: ZONE's two, in ACCOUNT, unless set. */
  zones?: { id: string; name: string; account: { id: string } }[];
  /** `result_info` of the zone listing, when set. */
  zoneInfo?: Record<string, unknown>;
  /** The account ids the token's account listing answers: ACCOUNT alone unless set. */
  accounts?: string[];
  /** Answers given in turn to `METHOD /path` (no query) before the usual one; an Error is a network failure. */
  flaky?: Record<string, (Response | Error)[]>;
  /** `result_info` of the DNS records listing, when set. */
  recordsInfo?: Record<string, unknown>;
}

const ZONES = Object.entries(ZONE).map(([name, id]) => ({ id, name, account: { id: ACCOUNT } }));

function fakeCloudflare(world: World) {
  const calls: {
    method: string;
    url: string;
    body?: unknown;
    auth: string | null;
    signal: boolean;
  }[] = [];
  const flaky = Object.fromEntries(
    Object.entries(world.flaky ?? {}).map(([key, answers]) => [key, [...answers]]),
  );
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({
      method,
      url,
      body,
      auth: new Headers(init?.headers).get("authorization"),
      signal: init?.signal instanceof AbortSignal,
    });
    const path = url.slice(API.length);
    const next = flaky[`${method} ${path.split("?")[0]}`]?.shift();
    if (next instanceof Error) throw next;
    if (next !== undefined) return next;
    const failure = world.fail?.[`${method} ${path.split("?")[0]}`];
    if (failure !== undefined) return failure.clone();
    if (method === "GET" && path === "/accounts?per_page=50") {
      const ids = world.accounts ?? [ACCOUNT];
      return ok(
        ids.map((id) => ({ id })),
        { total_count: ids.length },
      );
    }
    if (method === "GET" && path === "/zones?per_page=50") {
      return ok(world.zones ?? ZONES, world.zoneInfo);
    }
    const projectsPath = `/accounts/${ACCOUNT}/pages/projects`;
    const listPage = new RegExp(`^${projectsPath}\\?page=(\\d+)$`).exec(path);
    if (method === "GET" && listPage !== null) {
      const page = world.ignorePage === true ? 1 : Number(listPage[1]);
      const perPage = world.perPage ?? 25;
      const names = Object.keys(world.projects);
      const total = Math.ceil(names.length / perPage);
      const info =
        world.pageInfo === "omit-total"
          ? { page }
          : (world.pageInfo?.(page, total) ?? { page, total_pages: total });
      return ok(
        names.slice((page - 1) * perPage, page * perPage).map((name) => ({ name })),
        info,
      );
    }
    const domains = new RegExp(`^${projectsPath}/([^/]+)/domains$`).exec(path);
    if (method === "GET" && domains !== null) {
      return ok((world.projects[domains[1] ?? ""] ?? []).map((name) => ({ name })));
    }
    if (method === "DELETE" && path.startsWith(`${projectsPath}/`)) return ok(null);
    if (method === "POST" && domains !== null) return ok({ name: (body as { name: string }).name });
    const records = /^\/zones\/[^/]+\/dns_records\?name=(.+)$/.exec(path);
    if (method === "GET" && records !== null) {
      // Each record carries its name, as Cloudflare's listing does; a fixture's own wins.
      const host = decodeURIComponent(records[1] ?? "");
      return ok(
        (world.records[host] ?? []).map((record) => Object.assign({ name: host }, record)),
        world.recordsInfo,
      );
    }
    if (/^\/zones\/[^/]+\/dns_records(\/.+)?$/.test(path)) return ok({ id: "rec-new" });
    throw new Error(`test fetched an unlisted URL: ${method} ${url}`);
  };
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

async function run(
  args: string[],
  world: World,
  env: Record<string, string | undefined> = {},
  modes?: PerSite<SiteMode>,
) {
  const api = fakeCloudflare(world);
  const lines: string[] = [];
  const sleeps: number[] = [];
  const code = await runPagesDomain({
    args,
    env: { ...ENV, ...env },
    fetch: api.fetch,
    out: (text) => lines.push(text),
    modes,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  return { code, calls: api.calls, output: lines.join(""), sleeps };
}

/** Before the first flip: each Pages project holds its own host; www.musubi.social is empty. */
const TODAY: World = {
  projects: {
    "cire-host": ["cire-host.pages.dev", "host.cireweddings.com"],
    "cire-vendor": ["cire-vendor.pages.dev", "vendor.cireweddings.com"],
    "cire-landing": ["cire-landing.pages.dev", "cireweddings.com"],
    "osn-social": ["osn-social.pages.dev", "musubi.social"],
  },
  records: {
    "host.cireweddings.com": [CNAME("cire-host")],
    "vendor.cireweddings.com": [CNAME("cire-vendor")],
    "musubi.social": [CNAME("osn-social")],
  },
};

/** After cire vendor's flip: its Worker holds vendor.cireweddings.com, and every other Pages project its own host. */
const VENDOR_MOVED: World = {
  projects: { ...TODAY.projects, "cire-vendor": ["cire-vendor.pages.dev"] },
  records: { ...TODAY.records, "vendor.cireweddings.com": [WORKER] },
};

/**
 * What both apexes hold beside their web record, as public DNS showed on
 * 2026-11-10: Cloudflare Email Routing's three MX records and its SPF TXT.
 */
const MAIL: DnsRecord[] = [
  { id: "rec-mx1", type: "MX", content: "route1.mx.cloudflare.net" },
  { id: "rec-mx2", type: "MX", content: "route2.mx.cloudflare.net" },
  { id: "rec-mx3", type: "MX", content: "route3.mx.cloudflare.net" },
  { id: "rec-spf", type: "TXT", content: "v=spf1 include:_spf.mx.cloudflare.net ~all" },
];

/**
 * Records that could route a host and are not its CNAME to its Pages project:
 * a detach would leave each standing, and the Worker's custom domain could
 * not attach beside it.
 */
const STRAYS: DnsRecord[] = [
  { id: "rec-elsewhere", type: "CNAME", content: "elsewhere.example.net" },
  { id: "rec-a", type: "A", content: "192.0.2.1" },
  { id: "rec-aaaa", type: "AAAA", content: "2001:db8::1" },
  { ...WORKER, id: "rec-other-worker" },
  { id: "rec-https", type: "HTTPS", content: '1 . alpn="h2"' },
  { id: "rec-svcb", type: "SVCB", content: "1 . port=8443" },
];

/**
 * After cire host's flip: the two portals on their Workers, and each apex on
 * its Pages project, its CNAME beside its mail records.
 */
const HOST_MOVED: World = {
  projects: {
    ...VENDOR_MOVED.projects,
    "cire-host": ["cire-host.pages.dev"],
  },
  records: {
    "host.cireweddings.com": [WORKER],
    "vendor.cireweddings.com": [WORKER],
    "cireweddings.com": [...MAIL, CNAME("cire-landing")],
    "musubi.social": [...MAIL, CNAME("osn-social")],
  },
};

/** The modes before any flip: every Pages site staged. */
const BEFORE_FLIPS = {
  ...PRODUCTION_SITE_MODES,
  cire_host: "staged",
  cire_vendor: "staged",
  cire_landing: "staged",
  osn_social: "staged",
} as const;

/** The modes cire host's flip ran under: both apexes still staged. */
const APEXES_STAGED = {
  ...PRODUCTION_SITE_MODES,
  cire_landing: "staged",
  osn_social: "staged",
} as const;

describe("pages-domain.ts", () => {
  test("PD1: imports nothing but the repository's own import-free files", () => {
    const source = readFileSync(join(import.meta.dir, "..", "pages-domain.ts"), "utf8");
    const imports = [...source.matchAll(/^import[^;]*from "([^"]+)";/gm)].map((m) => m[1]);
    expect(imports.toSorted()).toEqual(
      ["./deploy-surfaces", "../shared/infra/src/production-sites"].toSorted(),
    );
    const surfaces = readFileSync(join(import.meta.dir, "..", "deploy-surfaces.ts"), "utf8");
    expect(
      [...surfaces.matchAll(/^import[^;]*from "([^"]+)";/gm)].map((m) => m[1]).toSorted(),
    ).toEqual(["../shared/infra/src/production-sites", "node:fs"].toSorted());
  });
});

describe("classify", () => {
  test("PD2: a host one Pages project lists is on Pages", () => {
    expect(
      classify(
        "host.cireweddings.com",
        [{ name: "cire-host", domains: ["host.cireweddings.com"] }],
        [CNAME("cire-host")],
      ),
    ).toEqual({
      kind: "pages",
      project: "cire-host",
    });
  });

  test("PD3: a host no project lists, with no record or a Worker's alone, is free", () => {
    expect(classify("www.musubi.social", [], [])).toEqual({ kind: "free" });
    expect(classify("www.musubi.social", [], [WORKER])).toEqual({ kind: "free" });
    expect(
      classify(
        "www.musubi.social",
        [],
        [{ id: "r", type: "AAAA", content: "100::", meta: { read_only: true } }],
      ),
    ).toEqual({ kind: "free" });
  });

  test("PD4: two projects listing it, or a record that is neither Pages' nor a Worker's, is unclear", () => {
    const two = [
      { name: "a", domains: ["x.musubi.social"] },
      { name: "b", domains: ["x.musubi.social"] },
    ];
    expect(classify("x.musubi.social", two, []).kind).toBe("unclear");
    for (const record of [
      CNAME("osn-social"),
      { id: "r", type: "A", content: "192.0.2.1" },
      { id: "r", type: "AAAA", content: "100::" },
    ]) {
      expect({ record, kind: classify("x.musubi.social", [], [record]).kind }).toEqual({
        record,
        kind: "unclear",
      });
    }
  });
});

describe("check", () => {
  test("PD2/PD3: prints each host's state, with the token sent only as a bearer", async () => {
    const result = await run(["check", "cire_host", "musubi_landing"], TODAY);
    expect(result.code).toBe(0);
    expect(result.output).toBe(
      "cire_host host.cireweddings.com pages cire-host\nmusubi_landing www.musubi.social free\n",
    );
    expect(result.calls.every((call) => call.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(result.calls.every((call) => call.method === "GET")).toBe(true);
  });

  test("PD4: any API error fails, naming the call, and no output carries the token or the account id (PD8)", async () => {
    const result = await run(["check", "cire_host"], {
      ...TODAY,
      fail: { [`GET /accounts/${ACCOUNT}/pages/projects/cire-vendor/domains`]: failed(403, 10000) },
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "listing cire-vendor's domains: Cloudflare answered 403 (codes 10000)",
    );
    expect(result.output).not.toContain(TOKEN);
    expect(result.output).not.toContain(ACCOUNT);
  });

  /** TODAY's projects behind `filler` others, so osn-social sits on a later page. */
  const behind = (filler: number): World => ({
    ...TODAY,
    projects: {
      ...Object.fromEntries(Array.from({ length: filler }, (_, at) => [`old-${at}`, []])),
      ...TODAY.projects,
    },
  });
  const listed = (calls: { url: string }[]) =>
    calls.filter((call) => call.url.includes("/pages/projects?page=")).map((call) => call.url);

  test("PD3/PD4: every page of the projects list is read, to total_pages or, without it, to an empty page", async () => {
    // osn-social is the ninth project: page 2 at five a page.
    for (const pageInfo of [undefined, "omit-total"] as const) {
      const result = await run(["check", "osn_social"], { ...behind(5), perPage: 5, pageInfo });
      expect({ pageInfo, code: result.code, output: result.output }).toEqual({
        pageInfo,
        code: 0,
        output: "osn_social musubi.social pages osn-social\n",
      });
      expect(listed(result.calls)).toHaveLength(pageInfo === undefined ? 2 : 3);
    }
  });

  test("PD4: a list whose end cannot be known fails instead of reading a host as free: past 20 pages, or a page other than the one asked", async () => {
    // Twenty pages of one project each, the last holding osn-social: read in full.
    const twenty = await run(["check", "osn_social"], { ...behind(16), perPage: 1 });
    expect(twenty.code).toBe(0);
    expect(listed(twenty.calls)).toHaveLength(20);
    // A twenty-first page, or twenty full pages with no total_pages, is past the cap.
    for (const world of [
      { ...behind(17), perPage: 1 },
      { ...behind(16), perPage: 1, pageInfo: "omit-total" as const },
    ]) {
      const result = await run(["check", "musubi_landing"], world);
      expect(result.code).toBe(1);
      expect(result.output).toContain("listing Pages projects: the list runs past 20 pages");
      expect(result.output).not.toContain(" free");
      expect(listed(result.calls)).toHaveLength(20);
    }
    // A server that ignores `?page` and says so.
    const ignored = await run(["check", "musubi_landing"], {
      ...behind(5),
      perPage: 5,
      ignorePage: true,
    });
    expect(ignored.code).toBe(1);
    expect(ignored.output).toContain("asked for page 2, Cloudflare answered page 1");
  });

  test("PD2: a project listed twice by a repeated page counts once", async () => {
    // A server that ignores `?page` and does not say which page it sent.
    const world: World = {
      ...TODAY,
      projects: { "osn-social": ["musubi.social"], a: [], b: [] },
      perPage: 2,
      ignorePage: true,
      pageInfo: (_, total) => ({ total_pages: total }),
    };
    const result = await run(["check", "osn_social"], world);
    expect(result.code).toBe(0);
    expect(result.output).toBe("osn_social musubi.social pages osn-social\n");
  });

  test("usage: no site, an unknown name, or no token exits 2 before any request", async () => {
    for (const [args, env] of [
      [["check"], {}],
      [["check", "cire_api"], {}],
      [["move", "cire_host"], {}],
      [["detach", "cire_host", "cire_vendor"], {}],
      [["check", "cire_host"], { CLOUDFLARE_PAGES_DNS_TOKEN: "" }],
    ] as const) {
      const result = await run([...args], TODAY, env);
      expect({ args, code: result.code, calls: result.calls.length }).toEqual({
        args,
        code: 2,
        calls: 0,
      });
    }
  });
});

describe("precheck", () => {
  test("PD5: a worker site whose host is free passes; with no worker site shipping it asks nothing", async () => {
    // Every Pages site staged, as before the first flip.
    const free = await run(["precheck"], TODAY, { STACKS: "musubi cire", FLIP: "" }, BEFORE_FLIPS);
    expect(free.code).toBe(0);
    expect(free.output).toContain("musubi_landing www.musubi.social free");
    const none = await run(["precheck"], TODAY, { STACKS: "cire", FLIP: "" }, BEFORE_FLIPS);
    expect(none.code).toBe(0);
    expect(none.calls).toEqual([]);
  });

  test("PD5: while host.cireweddings.com is on Pages, a release shipping the cire stack is refused unless it flips cire_host", async () => {
    // The modes cire host's flip ran under.
    const precheck = (env: Record<string, string>) =>
      run(["precheck"], VENDOR_MOVED, env, APEXES_STAGED);
    const refused = await precheck({ STACKS: "cire", FLIP: "" });
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("cire_host host.cireweddings.com pages cire-host");
    expect(refused.output).toContain("cire_vendor vendor.cireweddings.com free");
    expect(refused.output).toContain(
      "host.cireweddings.com is still on the cire-host Pages project. Move it back to the Worker as wiki/shared/production-deploy.md §5.7 says",
    );
    expect(refused.output).not.toContain("flip");
    const flip = await precheck({ STACKS: "cire", FLIP: "cire_host" });
    expect(flip.code).toBe(0);
    // A release that leaves the cire sites out asks nothing of the cire zone.
    const musubi = await precheck({ STACKS: "musubi", FLIP: "" });
    expect(musubi.code).toBe(0);
    expect(musubi.output).not.toContain("cire_host");
  });

  test("PD5: while both apexes are on Pages, each stack's release is refused unless it flips its own apex, in either order; once both have moved, each reads free", async () => {
    // Today's modes: both apexes are worker sites, still on their Pages projects.
    const cire = await run(["precheck"], HOST_MOVED, { STACKS: "cire", FLIP: "" });
    expect(cire.code).toBe(1);
    expect(cire.output).toContain("cire_landing cireweddings.com pages cire-landing");
    expect(cire.output).toContain("cire_host host.cireweddings.com free");
    expect(cire.output).toContain(
      "cireweddings.com is still on the cire-landing Pages project. Move it back to the Worker as wiki/shared/production-deploy.md §5.7 says",
    );
    const musubi = await run(["precheck"], HOST_MOVED, { STACKS: "musubi", FLIP: "" });
    expect(musubi.code).toBe(1);
    expect(musubi.output).toContain("osn_social musubi.social pages osn-social");
    expect(musubi.output).toContain(
      "musubi.social is still on the osn-social Pages project. Move it back to the Worker as wiki/shared/production-deploy.md §5.7 says",
    );
    expect(musubi.output).toContain("leave out the musubi stack's sites");
    // A daily run ships both stacks, so both apexes refuse it.
    const daily = await run(["precheck"], HOST_MOVED, { STACKS: "musubi cire", FLIP: "" });
    expect(daily.code).toBe(1);
    // Each flip passes with the other apex still on Pages: its stack ships alone.
    for (const [flip, stack] of [
      ["cire_landing", "cire"],
      ["osn_social", "musubi"],
    ] as const) {
      const result = await run(["precheck"], HOST_MOVED, { STACKS: stack, FLIP: flip });
      expect({ flip, code: result.code }).toEqual({ flip, code: 0 });
    }
    // After cire landing's flip, osn_social's still runs; after both, the daily run passes.
    const landingMoved: World = {
      projects: { ...HOST_MOVED.projects, "cire-landing": ["cire-landing.pages.dev"] },
      records: { ...HOST_MOVED.records, "cireweddings.com": [...MAIL, WORKER] },
    };
    const second = await run(["precheck"], landingMoved, { STACKS: "musubi", FLIP: "osn_social" });
    expect(second.code).toBe(0);
    const bothMoved: World = {
      projects: { ...landingMoved.projects, "osn-social": ["osn-social.pages.dev"] },
      records: { ...landingMoved.records, "musubi.social": [...MAIL, WORKER] },
    };
    const after = await run(["precheck"], bothMoved, { STACKS: "musubi cire", FLIP: "" });
    expect(after.code).toBe(0);
    for (const line of [
      "cire_landing cireweddings.com free",
      "osn_social musubi.social free",
      "musubi_landing www.musubi.social free",
    ]) {
      expect(after.output).toContain(line);
    }
  });

  test("PD5: a worker site still on Pages is refused without a flip naming it", async () => {
    const onPages: World = {
      ...TODAY,
      projects: { ...TODAY.projects, "musubi-landing": ["www.musubi.social"] },
    };
    const precheck = (flip: string) =>
      run(["precheck"], onPages, { STACKS: "musubi", FLIP: flip }, APEXES_STAGED);
    const refused = await precheck("");
    expect(refused.code).toBe(1);
    expect(refused.output).toContain(
      "Move it back to the Worker as wiki/shared/production-deploy.md §5.7 says",
    );
    const flipped = await precheck("musubi_landing");
    expect(flipped.code).toBe(0);
  });

  test("PD5: a worker site whose host is unclear is refused, flip or not, changing nothing", async () => {
    const foreign: World = {
      ...TODAY,
      records: {
        ...TODAY.records,
        "www.musubi.social": [{ id: "a", type: "A", content: "192.0.2.1" }],
      },
    };
    const twoProjects: World = {
      ...TODAY,
      projects: { ...TODAY.projects, a: ["www.musubi.social"], b: ["www.musubi.social"] },
    };
    for (const [world, reason] of [
      [foreign, "the zone holds a A record for it that is not a Worker's"],
      [twoProjects, "2 Pages projects list it: a, b"],
    ] as const) {
      const result = await run(["precheck"], world, { STACKS: "musubi", FLIP: "" }, APEXES_STAGED);
      expect({ reason, code: result.code }).toEqual({ reason, code: 1 });
      expect(result.output).toContain("musubi_landing www.musubi.social unclear");
      expect(result.output).toContain(reason);
      expect(result.calls.filter((call) => call.method !== "GET")).toEqual([]);
    }
  });

  test("PD5: a flip whose host is on no Pages project, or of a site this commit stages, or whose stack does not ship, is refused", async () => {
    const precheck = (world: World, stack: string, flip: string) =>
      run(["precheck"], world, { STACKS: stack, FLIP: flip }, APEXES_STAGED);
    const free = await precheck(TODAY, "musubi", "musubi_landing");
    expect(free.code).toBe(1);
    expect(free.output).toContain("nothing to move");
    const staged = await precheck(TODAY, "cire", "cire_landing");
    expect(staged.code).toBe(1);
    expect(staged.calls).toEqual([]);
    // Today's modes: osn_social is a worker site, but this release ships the cire stack.
    const elsewhere = await run(["precheck"], HOST_MOVED, { STACKS: "cire", FLIP: "osn_social" });
    expect(elsewhere.code).toBe(1);
    expect(elsewhere.calls).toEqual([]);
  });

  test("PD5: a flip site on its Pages project beside a record that could route it but its CNAME is refused, naming the record's type alone", async () => {
    for (const stray of STRAYS) {
      const world: World = {
        ...HOST_MOVED,
        records: {
          ...HOST_MOVED.records,
          "cireweddings.com": [...MAIL, CNAME("cire-landing"), stray],
        },
      };
      const result = await run(["precheck"], world, { STACKS: "cire", FLIP: "cire_landing" });
      expect({ type: stray.type, code: result.code }).toEqual({ type: stray.type, code: 1 });
      expect(result.output).toContain("cire_landing cireweddings.com pages cire-landing");
      expect(result.output).toContain(`a ${stray.type} record`);
      expect(result.output).not.toContain(stray.content);
    }
  });
});

describe("detach and attach", () => {
  test("PD6: detach refuses a site this commit still stages, before changing anything", async () => {
    const result = await run(["detach", "cire_landing"], TODAY, {}, APEXES_STAGED);
    expect(result.code).toBe(1);
    expect(result.output).toContain("cire_landing is staged");
    expect(result.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  test("PD6: detach refuses a host not on the site's own project", async () => {
    // musubi_landing serves from its Worker, and has no Pages project at all.
    const result = await run(["detach", "musubi_landing"], TODAY);
    expect(result.code).toBe(1);
    expect(result.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  test("PD6: detach, for a worker site on its own project, takes the domain off it and deletes only the CNAME to it", async () => {
    // The modes and hosts cire host's flip release found.
    const world: World = {
      ...VENDOR_MOVED,
      records: {
        ...VENDOR_MOVED.records,
        "host.cireweddings.com": [
          CNAME("cire-host"),
          { id: "rec-txt", type: "TXT", content: "verification" },
        ],
      },
    };
    const result = await run(["detach", "cire_host"], world, {}, APEXES_STAGED);
    expect(result.code).toBe(0);
    expect(
      result.calls
        .filter((call) => call.method === "DELETE")
        .map((call) => call.url.slice(API.length)),
    ).toEqual([
      `/accounts/${ACCOUNT}/pages/projects/cire-host/domains/host.cireweddings.com`,
      "/zones/zone-cire/dns_records/rec-cire-host",
    ]);
    // The flip's precheck passes once the mode says worker and the host is on Pages.
    const precheck = await run(
      ["precheck"],
      VENDOR_MOVED,
      { STACKS: "cire", FLIP: "cire_host" },
      APEXES_STAGED,
    );
    expect(precheck.code).toBe(0);
  });

  test("PD6: detach at each apex takes the domain off its project and deletes its CNAME alone; the mail records, a CAA and the apex's NS stay, and the flip's precheck passes beside them", async () => {
    // A CAA record and the zone's own NS records at the apex route nothing either.
    const others: DnsRecord[] = [
      { id: "rec-caa", type: "CAA", content: '0 issue "letsencrypt.org"' },
      { id: "rec-ns", type: "NS", content: "lou.ns.cloudflare.com" },
    ];
    for (const [site, host, project, zone, stack] of [
      ["cire_landing", "cireweddings.com", "cire-landing", "zone-cire", "cire"],
      ["osn_social", "musubi.social", "osn-social", "zone-musubi", "musubi"],
    ] as const) {
      for (const world of [
        HOST_MOVED,
        {
          ...HOST_MOVED,
          records: { ...HOST_MOVED.records, [host]: [...MAIL, ...others, CNAME(project)] },
        },
      ]) {
        const result = await run(["detach", site], world);
        expect({ site, code: result.code }).toEqual({ site, code: 0 });
        expect(nonGets(result.calls)).toEqual([
          `DELETE /accounts/${ACCOUNT}/pages/projects/${project}/domains/${host}`,
          `DELETE /zones/${zone}/dns_records/rec-${project}`,
        ]);
        expect(result.output).toContain(
          `Took ${host} off ${project} and deleted 1 CNAME record to ${project}.pages.dev.`,
        );
        const precheck = await run(["precheck"], world, { STACKS: stack, FLIP: site });
        expect({ site, code: precheck.code }).toEqual({ site, code: 0 });
      }
    }
  });

  const vendorFlipped = { ...PRODUCTION_SITE_MODES, cire_vendor: "worker" } as const;
  function nonGets(calls: { method: string; url: string }[]) {
    return calls
      .filter((call) => call.method !== "GET")
      .map((call) => `${call.method} ${call.url.slice(API.length)}`);
  }

  test("PD6: detach refuses, writing nothing, while the host holds a record that could route it but its CNAME to the project, naming the record's type alone", async () => {
    for (const stray of STRAYS) {
      for (const records of [[stray], [...MAIL, CNAME("cire-landing"), stray]]) {
        const world: World = {
          ...HOST_MOVED,
          records: { ...HOST_MOVED.records, "cireweddings.com": records },
        };
        const result = await run(["detach", "cire_landing"], world);
        expect({ type: stray.type, code: result.code }).toEqual({ type: stray.type, code: 1 });
        expect(nonGets(result.calls)).toEqual([]);
        expect(result.output).toContain(`a ${stray.type} record`);
        expect(result.output).not.toContain(stray.content);
      }
    }
  });

  test("PD4: a records listing that holds a record for another name refuses before any write, naming no record", async () => {
    // A listing wider than the host asked: the subdomain's CNAME to the same project.
    const wide: DnsRecord = {
      id: "rec-www",
      type: "CNAME",
      name: "www.cireweddings.com",
      content: "cire-landing.pages.dev",
    };
    const world: World = {
      ...HOST_MOVED,
      records: {
        ...HOST_MOVED.records,
        "cireweddings.com": [...MAIL, CNAME("cire-landing"), wide],
      },
    };
    const detach = await run(["detach", "cire_landing"], world);
    expect(detach.code).toBe(1);
    expect(detach.output).toContain(
      "listing cireweddings.com's DNS records: the listing holds a record for another name",
    );
    expect(detach.output).not.toContain("www.cireweddings.com");
    expect(nonGets(detach.calls)).toEqual([]);
    const precheck = await run(["precheck"], world, { STACKS: "cire", FLIP: "cire_landing" });
    expect(precheck.code).toBe(1);
  });

  test("PD4: a records listing with more than it returned refuses before any write, the precheck too", async () => {
    for (const info of [{ total_pages: 2 }, { total_count: 7 }]) {
      const world: World = { ...HOST_MOVED, recordsInfo: info };
      const detach = await run(["detach", "cire_landing"], world);
      expect(detach.code).toBe(1);
      expect(detach.output).toContain("listing cireweddings.com's DNS records");
      expect(nonGets(detach.calls)).toEqual([]);
      const precheck = await run(["precheck"], world, { STACKS: "cire", FLIP: "cire_landing" });
      expect(precheck.code).toBe(1);
    }
    // One page that holds every record passes.
    const whole = await run(["detach", "cire_landing"], {
      ...HOST_MOVED,
      recordsInfo: { page: 1, total_pages: 1, count: 5, total_count: 5 },
    });
    expect(whole.code).toBe(0);
  });

  test("PD4/PD8: a detach whose CNAME delete fails exits 1 naming the call, and attach then finishes the way back", async () => {
    const failing = await run(
      ["detach", "cire_vendor"],
      {
        ...TODAY,
        fail: { "DELETE /zones/zone-cire/dns_records/rec-cire-vendor": failed(403, 9109) },
      },
      {},
      vendorFlipped,
    );
    expect(failing.code).toBe(1);
    expect(failing.output).toContain(
      "deleting vendor.cireweddings.com's CNAME: Cloudflare answered 403 (codes 9109)",
    );
    expect(failing.output).not.toContain(TOKEN);
    expect(failing.output).not.toContain(ACCOUNT);
    // Where that leaves the host: off its project, its CNAME still there. The
    // same state an attach that stopped after its CNAME leaves.
    const halfway: World = {
      ...TODAY,
      projects: { ...TODAY.projects, "cire-vendor": ["cire-vendor.pages.dev"] },
    };
    const back = await run(["attach", "cire_vendor"], halfway);
    expect(back.code).toBe(0);
    expect(nonGets(back.calls)).toEqual([
      `POST /accounts/${ACCOUNT}/pages/projects/cire-vendor/domains`,
    ]);
  });

  test("PD7: attach makes only what is missing: a CNAME the project's listing lacks, nothing when both hold", async () => {
    const noCname = await run(["attach", "cire_host"], {
      projects: { "cire-host": ["host.cireweddings.com"] },
      records: {},
    });
    expect(noCname.code).toBe(0);
    expect(nonGets(noCname.calls)).toEqual(["POST /zones/zone-cire/dns_records"]);
    const already = await run(["attach", "cire_host"], TODAY);
    expect(already.code).toBe(0);
    expect(already.output).toContain(
      "host.cireweddings.com is already on cire-host; nothing to do",
    );
    expect(nonGets(already.calls)).toEqual([]);
  });

  test("PD7: attach refuses a host another Pages project lists", async () => {
    const result = await run(["attach", "cire_host"], {
      projects: { "cire-host": [], "cire-old": ["host.cireweddings.com"] },
      records: { "host.cireweddings.com": [CNAME("cire-host")] },
    });
    expect(result.code).toBe(1);
    expect(nonGets(result.calls)).toEqual([]);
  });

  test("PD7: attach refuses while the zone still holds a record for the host", async () => {
    const result = await run(["attach", "cire_host"], {
      projects: {},
      records: { "host.cireweddings.com": [WORKER] },
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain("remove the Worker's custom domain");
    expect(result.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  test("PD7: attach points the host back at its Pages project and adds the domain", async () => {
    const result = await run(["attach", "cire_host"], {
      projects: { "cire-host": [] },
      records: {},
    });
    expect(result.code).toBe(0);
    expect(
      result.calls
        .filter((call) => call.method === "POST")
        .map((call) => [call.url.slice(API.length), call.body]),
    ).toEqual([
      [
        "/zones/zone-cire/dns_records",
        {
          type: "CNAME",
          name: "host.cireweddings.com",
          content: "cire-host.pages.dev",
          proxied: true,
        },
      ],
      [`/accounts/${ACCOUNT}/pages/projects/cire-host/domains`, { name: "host.cireweddings.com" }],
    ]);
  });
});

describe("what the token reaches", () => {
  const vendorFlipped = { ...PRODUCTION_SITE_MODES, cire_vendor: "worker" } as const;
  const reads = (calls: { url: string }[]) => calls.map((call) => call.url.slice(API.length));
  const other = { id: "fedcba9876543210fedcba9876543210", name: "x", account: { id: ACCOUNT } };

  test("PD9: a token reaching anything but the account and the two zones refuses before any other request, and detach writes nothing", async () => {
    const refusals: [string, Partial<World>, string, string[]][] = [
      ["two accounts", { accounts: [ACCOUNT, other.id] }, "reaches 2 accounts", []],
      ["another account", { accounts: [other.id] }, "not the one CLOUDFLARE_ACCOUNT_ID names", []],
      [
        "a third zone",
        { zones: [...ZONES, { ...other, name: "pulse.events" }] },
        "sees the zones cireweddings.com, musubi.social, pulse.events;",
        ["/zones?per_page=50"],
      ],
      [
        "a missing zone",
        { zones: ZONES.slice(0, 1) },
        "sees the zones cireweddings.com;",
        ["/zones?per_page=50"],
      ],
      [
        "a zone twice",
        { zones: [...ZONES, { ...ZONES[0]!, id: "zone-cire-copy" }] },
        "sees the zones cireweddings.com, cireweddings.com, musubi.social;",
        ["/zones?per_page=50"],
      ],
      [
        "a zone in another account",
        { zones: [ZONES[0]!, { ...ZONES[1]!, account: { id: other.id } }] },
        "in the account CLOUDFLARE_ACCOUNT_ID names",
        ["/zones?per_page=50"],
      ],
      [
        "a second page of zones",
        { zoneInfo: { page: 1, total_pages: 2 } },
        "sees the zones cireweddings.com, musubi.social;",
        ["/zones?per_page=50"],
      ],
      [
        "more zones than the page holds",
        { zoneInfo: { page: 1, total_count: 51 } },
        "and 49 more",
        ["/zones?per_page=50"],
      ],
    ];
    for (const [what, reach, message, after] of refusals) {
      const result = await run(
        ["detach", "cire_vendor"],
        { ...TODAY, ...reach },
        {},
        vendorFlipped,
      );
      expect({ what, code: result.code, said: result.output.includes(message) }).toEqual({
        what,
        code: 1,
        said: true,
      });
      expect({ what, reads: reads(result.calls) }).toEqual({
        what,
        reads: ["/accounts?per_page=50", ...after],
      });
      expect(result.output).not.toContain(ACCOUNT);
      expect(result.output).not.toContain(other.id);
    }
  });

  test("PD15: a refusal counts the zones of another account the token sees, and names none", async () => {
    const result = await run(["check", "cire_host"], {
      ...TODAY,
      zones: [...ZONES, { ...other, name: "private-client.example", account: { id: other.id } }],
    });
    expect(result.code).toBe(1);
    expect(result.output).toContain(
      "sees the zones cireweddings.com, musubi.social, and 1 in another account;",
    );
    expect(result.output).not.toContain("private-client.example");
  });

  test("PD13: the zones are read once a run, from the token's own listing, however many sites", async () => {
    const result = await run(["check", "cire_host", "cire_vendor", "cire_landing"], TODAY);
    expect(result.code).toBe(0);
    expect(reads(result.calls).filter((url) => url.startsWith("/zones?"))).toEqual([
      "/zones?per_page=50",
    ]);
  });

  test("PD12: every request gives up after a time", async () => {
    const result = await run(["detach", "cire_vendor"], TODAY, {}, vendorFlipped);
    expect(result.code).toBe(0);
    expect(result.calls.length).toBeGreaterThan(4);
    expect(result.calls.every((call) => call.signal)).toBe(true);
  });

  test("PD11: a read is tried again after a 429, a 5xx or no answer, 1 s then 2 s later, then fails", async () => {
    const domains = `GET /accounts/${ACCOUNT}/pages/projects/cire-host/domains`;
    const passes = await run(["check", "cire_host"], {
      ...TODAY,
      flaky: { [domains]: [failed(429, 10000), new Error("connection reset")] },
    });
    expect(passes.code).toBe(0);
    expect(passes.sleeps).toEqual([1_000, 2_000]);
    expect(passes.output).toContain("cire_host host.cireweddings.com pages cire-host");
    const fails = await run(["check", "cire_host"], {
      ...TODAY,
      flaky: { [domains]: [failed(503, 0), failed(502, 0), failed(500, 0)] },
    });
    expect(fails.code).toBe(1);
    expect(fails.sleeps).toEqual([1_000, 2_000]);
    expect(fails.output).toContain("listing cire-host's domains: Cloudflare answered 500");
    // A refusal is not asked again.
    const refused = await run(["check", "cire_host"], {
      ...TODAY,
      flaky: { [domains]: [failed(403, 10000)] },
    });
    expect(refused.code).toBe(1);
    expect(refused.sleeps).toEqual([]);
  });

  test("PD11: a write that fails is sent once", async () => {
    const remove = `DELETE /accounts/${ACCOUNT}/pages/projects/cire-vendor/domains/vendor.cireweddings.com`;
    const detach = await run(
      ["detach", "cire_vendor"],
      { ...TODAY, flaky: { [remove]: [failed(503, 0)] } },
      {},
      vendorFlipped,
    );
    expect(detach.code).toBe(1);
    expect(detach.sleeps).toEqual([]);
    expect(detach.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    const attach = await run(["attach", "cire_host"], {
      projects: { "cire-host": [] },
      records: {},
      flaky: { "POST /zones/zone-cire/dns_records": [new Error("connection reset")] },
    });
    expect(attach.code).toBe(1);
    expect(attach.sleeps).toEqual([]);
    expect(attach.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  });
});

describe("pagesDnsApi", () => {
  // The domain move rehearsal records every answer through `observe` into an
  // artifact; the token must never reach it, and a retried read must show
  // each attempt, since the retries are part of what Cloudflare answered.
  test("PD14: the observer sees every attempt, retries and failures included, and never the token", async () => {
    const domains = `GET /accounts/${ACCOUNT}/pages/projects/cire-host/domains`;
    const api = fakeCloudflare({
      ...TODAY,
      flaky: { [domains]: [failed(503, 0), new Error("connection reset")] },
    });
    const seen: ObservedAttempt[] = [];
    const client = pagesDnsApi({
      account: ACCOUNT,
      token: TOKEN,
      fetch: api.fetch,
      sleep: async () => {},
      observe: (attempt) => seen.push(attempt),
    });
    const listed = await client.call(
      "GET",
      `/accounts/${ACCOUNT}/pages/projects/cire-host/domains`,
      "listing cire-host's domains",
    );
    expect(Array.isArray(listed.result)).toBe(true);
    expect(seen.map((attempt) => [attempt.method, attempt.status])).toEqual([
      ["GET", 503],
      ["GET", null],
      ["GET", 200],
    ]);
    expect(seen.every((attempt) => attempt.what === "listing cire-host's domains")).toBe(true);
    expect(JSON.stringify(seen)).not.toContain(TOKEN);
    // A refusal reaches the caller with its status and codes.
    const refusing = pagesDnsApi({
      account: ACCOUNT,
      token: TOKEN,
      fetch: fakeCloudflare({ ...TODAY, flaky: { [domains]: [failed(403, 10000)] } }).fetch,
      sleep: async () => {},
    });
    const error = await refusing
      .call("GET", `/accounts/${ACCOUNT}/pages/projects/cire-host/domains`, "listing")
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ApiError);
    expect({ status: (error as ApiError).status, codes: (error as ApiError).codes }).toEqual({
      status: 403,
      codes: [10000],
    });
  });

  test("PD16: a read asked with retry: false is sent once, even on a 429", async () => {
    const domains = `GET /accounts/${ACCOUNT}/pages/projects/cire-host/domains`;
    const seen: ObservedAttempt[] = [];
    const sleeps: number[] = [];
    const client = pagesDnsApi({
      account: ACCOUNT,
      token: TOKEN,
      fetch: fakeCloudflare({ ...TODAY, flaky: { [domains]: [failed(429, 10000)] } }).fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      observe: (attempt) => seen.push(attempt),
    });
    const error = await client
      .call("GET", `/accounts/${ACCOUNT}/pages/projects/cire-host/domains`, "polling", undefined, {
        retry: false,
      })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(ApiError);
    expect(seen.map((attempt) => attempt.status)).toEqual([429]);
    expect(sleeps).toEqual([]);
  });
});

describe("records that route nothing", () => {
  const apexRecords: DnsRecord[] = [
    { id: "rec-txt", type: "TXT", content: "v=spf1 include:_spf.example.net ~all" },
    { id: "rec-mx", type: "MX", content: "mx.example.net" },
    { id: "rec-caa", type: "CAA", content: '0 issue "letsencrypt.org"' },
    { id: "rec-ns", type: "NS", content: "ns1.example.net" },
  ];

  test("PD10: an apex's TXT, MX, CAA and NS records leave it free beside a Worker's record, and on Pages beside its CNAME", async () => {
    expect(classify("musubi.social", [], [...apexRecords, WORKER])).toEqual({ kind: "free" });
    expect(classify("musubi.social", [], apexRecords)).toEqual({ kind: "free" });
    expect(
      classify(
        "musubi.social",
        [{ name: "osn-social", domains: ["musubi.social"] }],
        [...apexRecords, CNAME("osn-social")],
      ),
    ).toEqual({ kind: "pages", project: "osn-social" });
    // A worker site on the apex reads free, so the precheck passes.
    const socialWorker = { ...PRODUCTION_SITE_MODES, osn_social: "worker" } as const;
    const precheck = await run(
      ["precheck"],
      {
        ...TODAY,
        projects: { ...TODAY.projects, "osn-social": ["osn-social.pages.dev"] },
        records: { "musubi.social": [...apexRecords, WORKER] },
      },
      { STACKS: "musubi", FLIP: "" },
      socialWorker,
    );
    expect(precheck.code).toBe(0);
    expect(precheck.output).toContain("osn_social musubi.social free");
    // An address record still decides.
    const address: DnsRecord = { id: "a", type: "A", content: "192.0.2.1" };
    expect(classify("musubi.social", [], [...apexRecords, address]).kind).toBe("unclear");
  });

  test("PD10: an NS below the apex delegates the name, and HTTPS or SVCB may route it: each reads unclear", () => {
    for (const record of [
      { id: "ns", type: "NS", content: "ns1.example.net" },
      { id: "https", type: "HTTPS", content: '1 . alpn="h2"' },
      { id: "svcb", type: "SVCB", content: "1 . port=443" },
    ]) {
      expect({ type: record.type, kind: classify("www.musubi.social", [], [record]).kind }).toEqual(
        { type: record.type, kind: "unclear" },
      );
    }
  });

  test("PD10: attach on an apex holding TXT, MX and CAA makes its CNAME and adds the domain; beside its CNAME it adds the domain alone", async () => {
    const records = apexRecords.filter((record) => record.type !== "NS");
    const bare = await run(["attach", "osn_social"], {
      projects: { "osn-social": ["osn-social.pages.dev"] },
      records: { "musubi.social": records },
    });
    expect(bare.code).toBe(0);
    expect(
      bare.calls
        .filter((call) => call.method === "POST")
        .map((call) => [call.url.slice(API.length), call.body]),
    ).toEqual([
      [
        "/zones/zone-musubi/dns_records",
        { type: "CNAME", name: "musubi.social", content: "osn-social.pages.dev", proxied: true },
      ],
      [`/accounts/${ACCOUNT}/pages/projects/osn-social/domains`, { name: "musubi.social" }],
    ]);
    const pointed = await run(["attach", "osn_social"], {
      projects: { "osn-social": ["osn-social.pages.dev"] },
      records: { "musubi.social": [...records, CNAME("osn-social")] },
    });
    expect(pointed.code).toBe(0);
    expect(
      pointed.calls
        .filter((call) => call.method === "POST")
        .map((call) => call.url.slice(API.length)),
    ).toEqual([`/accounts/${ACCOUNT}/pages/projects/osn-social/domains`]);
  });
});
