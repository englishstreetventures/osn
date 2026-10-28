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
import { classify, type DnsRecord, runPagesDomain } from "../pages-domain";

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
  /** Zone ids the zones lookup answers per zone name, ZONE's one unless set. */
  zones?: Record<string, string[]>;
}

function fakeCloudflare(world: World) {
  const calls: { method: string; url: string; body?: unknown; auth: string | null }[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ method, url, body, auth: new Headers(init?.headers).get("authorization") });
    const path = url.slice(API.length);
    const failure = world.fail?.[`${method} ${path.split("?")[0]}`];
    if (failure !== undefined) return failure.clone();
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
    const zone = /^\/zones\?name=(.+)$/.exec(path);
    if (method === "GET" && zone !== null) {
      const name = decodeURIComponent(zone[1] ?? "");
      const listed = world.zones?.[name];
      if (listed !== undefined) return ok(listed.map((id) => ({ id })));
      const id = ZONE[name as keyof typeof ZONE];
      return ok(id === undefined ? [] : [{ id }]);
    }
    const records = /^\/zones\/[^/]+\/dns_records\?name=(.+)$/.exec(path);
    if (method === "GET" && records !== null) {
      return ok(world.records[decodeURIComponent(records[1] ?? "")] ?? []);
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
  const code = await runPagesDomain({
    args,
    env: { ...ENV, ...env },
    fetch: api.fetch,
    out: (text) => lines.push(text),
    modes,
  });
  return { code, calls: api.calls, output: lines.join("") };
}

/** Today: each Pages project holds its own host; www.musubi.social is empty. */
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
    const free = await run(["precheck"], TODAY, { STACKS: "musubi cire", FLIP: "" });
    expect(free.code).toBe(0);
    expect(free.output).toContain("musubi_landing www.musubi.social free");
    const none = await run(["precheck"], TODAY, { STACKS: "cire", FLIP: "" });
    expect(none.code).toBe(0);
    expect(none.calls).toEqual([]);
  });

  test("PD5: a worker site still on Pages is refused without a flip naming it", async () => {
    const onPages: World = {
      ...TODAY,
      projects: { ...TODAY.projects, "musubi-landing": ["www.musubi.social"] },
    };
    const refused = await run(["precheck"], onPages, { STACKS: "musubi", FLIP: "" });
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("flip: musubi_landing");
    const flipped = await run(["precheck"], onPages, { STACKS: "musubi", FLIP: "musubi_landing" });
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
      const result = await run(["precheck"], world, { STACKS: "musubi", FLIP: "" });
      expect({ reason, code: result.code }).toEqual({ reason, code: 1 });
      expect(result.output).toContain("musubi_landing www.musubi.social unclear");
      expect(result.output).toContain(reason);
      expect(result.calls.filter((call) => call.method !== "GET")).toEqual([]);
    }
  });

  test("PD5: a flip whose host is on no Pages project, or whose stack does not ship, is refused", async () => {
    const free = await run(["precheck"], TODAY, { STACKS: "musubi", FLIP: "musubi_landing" });
    expect(free.code).toBe(1);
    expect(free.output).toContain("nothing to move");
    const staged = await run(["precheck"], TODAY, { STACKS: "cire", FLIP: "cire_host" });
    expect(staged.code).toBe(1);
    expect(staged.calls).toEqual([]);
  });
});

describe("detach and attach", () => {
  test("PD6: detach refuses a site this commit still stages, before changing anything", async () => {
    const result = await run(["detach", "cire_host"], TODAY);
    expect(result.code).toBe(1);
    expect(result.output).toContain("cire_host is staged");
    expect(result.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  test("PD6: detach refuses a host not on the site's own project", async () => {
    // musubi_landing serves from its Worker, and has no Pages project at all.
    const result = await run(["detach", "musubi_landing"], TODAY);
    expect(result.code).toBe(1);
    expect(result.calls.filter((call) => call.method !== "GET")).toEqual([]);
  });

  test("PD6: detach, for a worker site on its own project, takes the domain off it and deletes only the CNAME to it", async () => {
    const flipped = { ...PRODUCTION_SITE_MODES, cire_vendor: "worker" } as const;
    const world: World = {
      ...TODAY,
      records: {
        "vendor.cireweddings.com": [
          CNAME("cire-vendor"),
          { id: "rec-txt", type: "TXT", content: "verification" },
        ],
      },
    };
    const result = await run(["detach", "cire_vendor"], world, {}, flipped);
    expect(result.code).toBe(0);
    expect(
      result.calls
        .filter((call) => call.method === "DELETE")
        .map((call) => call.url.slice(API.length)),
    ).toEqual([
      `/accounts/${ACCOUNT}/pages/projects/cire-vendor/domains/vendor.cireweddings.com`,
      "/zones/zone-cire/dns_records/rec-cire-vendor",
    ]);
    // The flip's precheck passes once the mode says worker and the host is on Pages.
    const precheck = await run(
      ["precheck"],
      TODAY,
      { STACKS: "cire", FLIP: "cire_vendor" },
      flipped,
    );
    expect(precheck.code).toBe(0);
  });

  const vendorFlipped = { ...PRODUCTION_SITE_MODES, cire_vendor: "worker" } as const;
  const nonGets = (calls: { method: string; url: string }[]) =>
    calls
      .filter((call) => call.method !== "GET")
      .map((call) => `${call.method} ${call.url.slice(API.length)}`);

  test("PD6: detach deletes no record but a CNAME to the project: a CNAME pointing elsewhere stays", async () => {
    const world: World = {
      ...TODAY,
      records: {
        "vendor.cireweddings.com": [
          { id: "rec-other", type: "CNAME", content: "elsewhere.example.net" },
        ],
      },
    };
    const result = await run(["detach", "cire_vendor"], world, {}, vendorFlipped);
    expect(result.code).toBe(0);
    expect(nonGets(result.calls)).toEqual([
      `DELETE /accounts/${ACCOUNT}/pages/projects/cire-vendor/domains/vendor.cireweddings.com`,
    ]);
    expect(result.output).toContain("deleted 0 CNAME records");
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

  test("PD4: a zone name the token sees twice fails before anything changes", async () => {
    const result = await run(
      ["detach", "cire_vendor"],
      { ...TODAY, zones: { "cireweddings.com": ["zone-cire", "zone-cire-copy"] } },
      {},
      vendorFlipped,
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain("finding the cireweddings.com zone: the token sees 2 zones");
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
