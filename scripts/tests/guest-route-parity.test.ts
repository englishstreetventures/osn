// The comparison rules of scripts/guest-route-parity.ts and the relay that
// carries the Wrangler side's calls to cire-api, one test per way they can
// fail (NEW-FEAT.md, PF1–PF13, PF15, PF17, PF20, PF21, PF29–PF31, PF36,
// PF37). The run itself — the reference started, both sides probed, the
// report written — is in guest-route-parity.cli.test.ts.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  allowancesUsed,
  assetProbes,
  compare,
  EMULATION_ALLOWANCES,
  expectedApiStatus,
  GUEST_SEED,
  observe,
  probePaths,
  referenceEnv,
  relayRefusals,
  relayRequest,
  renderReport,
  routeFor,
  routesFromPages,
  routesInBuild,
  SEEDED_PROBES,
  seedRendered,
  blockedReason,
  startRelay,
  uncoveredRoutes,
  UNKNOWN_SLUG_PROBES,
  type FetchLike,
  type Observation,
  type RelayedCall,
} from "../guest-route-parity";
import { RELAY_TOKEN_HEADER, WORKER_UA_HEADER } from "../guest-route-parity-reference.js";
import { CI_USER_AGENT } from "../smoke-check";

const ROOT = join(import.meta.dir, "..", "..");
const PAGES = join(ROOT, "cire", "invites", "src", "pages");
const PUBLIC = join(ROOT, "cire", "invites", "public");
const SEED = join(ROOT, "cire", "db", "seed", "dev-seed.sql");

/** The routes Astro adds beside the pages in this app's manifest: its image endpoint and server islands. */
const BUILT_IN_ROUTES = ["/_image", "/_server-islands/[name]"];

function tree(files: Readonly<Record<string, string>>): string {
  const dir = mkdtempSync(join(tmpdir(), "guest-route-parity-"));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  return dir;
}

const OWN = "https://invite.cire.example.test";
const LOCAL = "http://127.0.0.1:54321";

const html = (body: string): Response =>
  new Response(`<!doctype html><html lang="en"><head>${body}</head></html>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

const page = async (head: string, origin = OWN): Promise<Observation> =>
  observe(html(head), origin);

describe("routes and probes", () => {
  test("PF1: reads every route from the build's manifest, in .js and .mjs chunks alike, and lists a route no probe reaches", () => {
    const server = tree({
      "chunks/entrypoints_X.mjs": 'x={"route":"/","type":"page"},{"route":"/[slug]"}',
      "chunks/other.js": '{"route":"/brand-new"}',
      "entry.mjs.map": '{"route":"/from-a-map"}',
    });
    const routes = routesInBuild(server);
    expect(routes).toEqual(["/", "/[slug]", "/brand-new"]);
    expect(routesInBuild(tree({ "entry.mjs": "export default {}" }))).toEqual([]);
    expect(uncoveredRoutes(routes, ["/", `/${GUEST_SEED.slug}`])).toEqual(["/brand-new"]);
  });

  test("PF1: a probe reaches the route Astro would answer it with, a static route before a dynamic one", () => {
    const routes = ["/[slug]", "/[slug]/registry", "/cire/registry", "/privacy"];
    expect(routeFor("/privacy/", routes)).toBe("/privacy");
    expect(routeFor("/cire/registry?slug=x", routes)).toBe("/cire/registry");
    expect(routeFor("/x/registry", routes)).toBe("/[slug]/registry");
    expect(routeFor("/privacy/index.html", routes)).toBeUndefined();
    // So the query route does not stand in for the path route.
    expect(uncoveredRoutes(routes, ["/privacy", "/cire/registry?slug=x"])).toEqual([
      "/[slug]",
      "/[slug]/registry",
    ]);
  });

  test("PF1: every route the guest site's pages define, and the two Astro adds, has a probe", () => {
    const routes = [...routesFromPages(PAGES), ...BUILT_IN_ROUTES];
    expect(routes).toContain("/[slug]/registry");
    expect(uncoveredRoutes(routes, probePaths(tree({}), PUBLIC))).toEqual([]);
  });

  test("PF2: every file the guest site serves from public/ has a probe at its served path", () => {
    const probes = probePaths(tree({}), PUBLIC);
    const served = ["_headers", "favicon.ico", "favicon.svg", "robots.txt"];
    for (const file of served) expect(probes).toContain(`/${file}`);
  });

  test("PF3: the seeded slug and hero title are what cire/db's dev seed inserts for the sample wedding", () => {
    const sql = readFileSync(SEED, "utf8");
    expect(sql).toMatch(new RegExp(`'wed_bootstrap',\\s*'${GUEST_SEED.slug}'`));
    expect(sql).toMatch(
      new RegExp(
        `INTO wedding_invite_customisations[\\s\\S]*?VALUES \\(\\s*'wed_bootstrap',\\s*'${GUEST_SEED.heroTitle}'`,
      ),
    );
    expect(SEEDED_PROBES.every((path) => path.includes(GUEST_SEED.slug))).toBe(true);
  });

  test("PF29: probes the first built file of every extension, by name, and never a platform file or one .assetsignore keeps out", () => {
    const client = tree({
      "_astro/b.js": "",
      "_astro/a.js": "",
      "_astro/z.css": "",
      "_astro/y.css": "",
      "_astro/f.woff2": "",
      "favicon.ico": "",
      "robots.txt": "",
      "img/hero.webp": "",
      README: "",
      _headers: "/*\n  X-Frame-Options: DENY\n",
      _redirects: "/old /new 301\n",
      ".assetsignore": "wrangler.json\n.dev.vars\n# a comment\nprivate/\n",
      "wrangler.json": "{}",
      ".dev.vars": "SECRET=x\n",
      "private/a.txt": "",
      "private/b.json": "{}",
    });
    expect(assetProbes(client)).toEqual([
      "/README",
      "/_astro/a.js",
      "/_astro/f.woff2",
      "/_astro/y.css",
      "/favicon.ico",
      "/img/hero.webp",
      "/robots.txt",
    ]);
    const probes = probePaths(client, PUBLIC);
    for (const path of assetProbes(client)) expect(probes).toContain(path);
    // The fixed probes stay: the platform files and what `.assetsignore` keeps out.
    for (const path of ["/_headers", "/.assetsignore", "/wrangler.json", "/.dev.vars"]) {
      expect(probes).toContain(path);
    }
    expect(probes).not.toContain("/private/b.json");
    // A file both public/ and the build hold is asked once.
    expect(new Set(probes).size).toBe(probes.length);
  });
});

describe("compare", () => {
  const base: Observation = {
    status: 200,
    headers: { "content-type": "text/plain", "x-frame-options": "DENY" },
    body: { kind: "bytes", sha256: "a" },
  };

  test("PF4: reports a status difference", () => {
    expect(compare("/x", { ...base, status: 404 }, base)).toEqual([
      "status: 404 on the Alchemy upload, 200 on Wrangler",
    ]);
  });

  test("PF5: reports a compared header present on one side only", () => {
    const withCsp = { ...base, headers: { ...base.headers, "content-security-policy": "x" } };
    expect(compare("/x", base, withCsp)).toEqual([
      "content-security-policy: (none) on the Alchemy upload, x on Wrangler",
    ]);
    expect(compare("/x", withCsp, base)).toHaveLength(1);
  });

  test("PF6: a Location that differs only by each side's own origin matches; one that differs in its path does not", async () => {
    const redirect = (to: string) => new Response(null, { status: 307, headers: { location: to } });
    const edge = await observe(redirect(`${OWN}/privacy/`), OWN);
    const local = await observe(redirect(`${LOCAL}/privacy/`), LOCAL);
    expect(compare("/x", edge, local)).toEqual([]);
    const elsewhere = await observe(redirect(`${LOCAL}/terms/`), LOCAL);
    expect(compare("/x", edge, elsewhere)).toEqual([
      "location: /privacy/ on the Alchemy upload, /terms/ on Wrangler",
    ]);
  });

  test("PF7: an allowance covers only its paths, its exact local value and its exact edge value, and the report names each use", () => {
    const allowance = EMULATION_ALLOWANCES.find((one) => one.paths.test("/privacy/"));
    if (allowance === undefined) throw new Error("no allowance for /privacy/ to test");
    const withType = (value: string | undefined): Observation => ({
      ...base,
      headers: value === undefined ? {} : { [allowance.header]: value },
    });
    const edge = withType(allowance.edgeValue);
    const local = withType(allowance.localValue);
    expect(compare("/privacy/", edge, local)).toEqual([]);
    expect(allowancesUsed("/privacy/", edge, local)).toEqual([
      `${allowance.header}: ${allowance.reason}`,
    ]);
    // Another path, another local value, another edge value: each reported.
    expect(compare("/cire-wedding", edge, local)).toHaveLength(1);
    expect(compare("/privacy/", edge, withType("text/plain"))).toHaveLength(1);
    expect(compare("/privacy/", withType("text/plain"), local)).toHaveLength(1);
    expect(compare("/privacy/", withType(undefined), local)).toHaveLength(1);
    expect(allowancesUsed("/privacy/", local, local)).toEqual([]);
  });

  test("PF30: the plain-text allowance covers only its exact values, on .txt paths", () => {
    const withType = (value: string | undefined): Observation => ({
      ...base,
      headers: value === undefined ? {} : { "content-type": value },
    });
    const edge = withType("text/plain");
    const local = withType("text/plain; charset=utf-8");
    expect(compare("/robots.txt", edge, local)).toEqual([]);
    expect(allowancesUsed("/robots.txt", edge, local)).toHaveLength(1);
    expect(compare("/notes/a.txt", edge, local)).toEqual([]);
    // Another path, another local value, another edge value: each reported.
    expect(compare("/robots.txt.bak", edge, local)).toHaveLength(1);
    expect(compare("/_astro/a.css", edge, local)).toHaveLength(1);
    expect(compare("/robots.txt", edge, withType("text/plain; charset=latin1"))).toHaveLength(1);
    expect(compare("/robots.txt", withType("text/html"), local)).toHaveLength(1);
    expect(compare("/robots.txt", withType(undefined), local)).toHaveLength(1);
  });

  test("PF8: reports each page landmark that differs", async () => {
    const head =
      '<title>Ada &amp; Kit — You\'re Invited</title><meta name="robots" content="noindex">' +
      '<link rel="stylesheet" href="/_astro/a.css"><script src="/_astro/a.js"></script>';
    const one = await page(`${head}<astro-island component-url="/_astro/I.js"></astro-island>`);
    const same = await page(
      `${head}<astro-island component-url="/_astro/I.js"></astro-island>`,
      LOCAL,
    );
    expect(compare("/x", one, same)).toEqual([]);
    const other = await page(
      head.replace("Ada", "Bea") + '<astro-island component-url="/_astro/J.js"></astro-island>',
    );
    expect(compare("/x", one, other).map((line) => line.split(":")[0])).toEqual([
      "page title",
      "page islands",
    ]);
    const noH1 = await page("<title>x</title>");
    const h1 = await observe(
      new Response("<html><body><h1> Page   not found </h1></body></html>", {
        headers: { "content-type": "text/html" },
      }),
      OWN,
    );
    expect(h1.body).toMatchObject({ landmarks: { h1: ["Page not found"] } });
    expect(compare("/x", noH1, h1)).toContain(
      'page h1: [] on the Alchemy upload, ["Page not found"] on Wrangler',
    );
  });

  test("PF8: reads every landmark, without the page's own origin, and reports each one that differs alone", async () => {
    const full =
      `<title>Ada &amp; Kit</title><meta name="robots" content="noindex, nofollow">` +
      `<link rel="canonical" href="${OWN}/cire-wedding"><meta property="og:url" content="${OWN}/cire-wedding">` +
      `<link rel="stylesheet" href="/_astro/b.css"><link rel="stylesheet" href="/_astro/a.css">` +
      `<script src="${OWN}/_astro/b.js"></script><script src="/_astro/a.js"></script>` +
      `</head><body><h1>Ada &amp; Kit</h1><h1>Details</h1>` +
      `<astro-island component-url="/_astro/I.js"></astro-island><head>`;
    const observed = await page(full);
    expect(observed.body).toEqual({
      kind: "html",
      landmarks: {
        title: "Ada & Kit",
        lang: "en",
        robots: "noindex, nofollow",
        canonical: "/cire-wedding",
        ogUrl: "/cire-wedding",
        h1: ["Ada & Kit", "Details"],
        scripts: ["/_astro/a.js", "/_astro/b.js"],
        stylesheets: ["/_astro/a.css", "/_astro/b.css"],
        islands: ["/_astro/I.js"],
      },
    });
    const changes: Readonly<Record<string, [string, string]>> = {
      title: ["<title>Ada &amp; Kit</title>", "<title>Bea</title>"],
      robots: ['content="noindex, nofollow"', 'content="index"'],
      canonical: ['rel="canonical" href="' + OWN + '/cire-wedding"', 'rel="canonical" href="/x"'],
      ogUrl: ['content="' + OWN + '/cire-wedding"', 'content="/x"'],
      h1: ["<h1>Details</h1>", ""],
      scripts: ['<script src="/_astro/a.js"></script>', ""],
      stylesheets: ['<link rel="stylesheet" href="/_astro/a.css">', ""],
      islands: ['component-url="/_astro/I.js"', 'component-url="/_astro/J.js"'],
    };
    for (const [key, [from, to]] of Object.entries(changes)) {
      const changed = await page(full.replace(from, to));
      expect(compare("/x", observed, changed).map((line) => line.split(":")[0])).toEqual([
        `page ${key}`,
      ]);
    }
    const otherLang = await observe(
      new Response(`<!doctype html><html lang="fr"><head>${full}</head></html>`, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
      OWN,
    );
    expect(compare("/x", observed, otherLang).map((line) => line.split(":")[0])).toEqual([
      "page lang",
    ]);
  });

  test("PF9: reports a body difference in any answer that is not a page", async () => {
    const a = await observe(
      new Response("one", { headers: { "content-type": "text/plain" } }),
      OWN,
    );
    const b = await observe(
      new Response("two", { headers: { "content-type": "text/plain" } }),
      OWN,
    );
    expect(compare("/x", a, b)).toHaveLength(1);
    expect(compare("/x", a, b)[0]).toStartWith("body: sha256 ");
  });
});

describe("refusals", () => {
  test("PF10: Cloudflare answering in the Worker's place on the dev host is named, never compared", () => {
    const url = `${OWN}/`;
    const at = (status: number, headers: Record<string, string> = {}) =>
      blockedReason(url, new Response(null, { status, headers }), "");
    expect(at(302, { location: "https://team.cloudflareaccess.com/login" })).toContain("Access");
    expect(at(403, { "cf-mitigated": "challenge" })).toContain("cf-mitigated");
    expect(at(429)).toContain("429");
    expect(at(401)).toContain("Access");
    expect(at(404)).toBeUndefined();
    expect(at(302, { location: "https://cire.example.test" })).toBeUndefined();
  });

  test("PF12: the seeded wedding counts as rendered only as a 200 page titled with its hero title", async () => {
    const titled = (title: string, status = 200) =>
      observe(
        new Response(`<html><head><title>${title}</title></head></html>`, {
          status,
          headers: { "content-type": "text/html" },
        }),
        OWN,
      );
    expect(seedRendered(await titled("Ada &amp; Kit — You're Invited"))).toBe(true);
    // cire-api failing renders the shell with the built-in title.
    expect(seedRendered(await titled("You're Invited"))).toBe(false);
    expect(seedRendered(await titled("Ada &amp; Kit — You're Invited", 404))).toBe(false);
    expect(seedRendered(undefined)).toBe(false);
  });

  test("PF13: the reference runs with no Cloudflare credential, no Access token, a home of its own, telemetry off and the run's relay token", () => {
    expect(
      referenceEnv(
        {
          PATH: "/usr/bin",
          HOME: "/home/runner",
          XDG_CONFIG_HOME: "/home/runner/.config",
          TMPDIR: "/tmp",
          CLOUDFLARE_API_TOKEN: "token",
          CLOUDFLARE_ACCOUNT_ID: "account",
          CF_ACCESS_CLIENT_ID: "id",
          CF_ACCESS_CLIENT_SECRET: "secret",
          GITHUB_TOKEN: "gh",
          PARITY_RELAY_TOKEN: "from-the-parent-env",
        },
        "/tmp/run/home",
        "run-token",
      ),
    ).toEqual({
      PATH: "/usr/bin",
      TMPDIR: "/tmp",
      HOME: "/tmp/run/home",
      XDG_CONFIG_HOME: "/tmp/run/home",
      DO_NOT_TRACK: "1",
      WRANGLER_SEND_METRICS: "false",
      PARITY_RELAY_TOKEN: "run-token",
    });
  });

  test("PF31: cire-api's expected answer is 200 for each seeded probe and 404 for each probe of a slug no wedding has; a relayed answer that differs is reported", () => {
    expect(SEEDED_PROBES.map(expectedApiStatus)).toEqual([200, 200, 200, 200]);
    expect(UNKNOWN_SLUG_PROBES).toEqual([
      "/route-parity-no-such-wedding",
      "/wrangler.json",
      "/.dev.vars",
      "/.assetsignore",
    ]);
    expect(UNKNOWN_SLUG_PROBES.map(expectedApiStatus)).toEqual([404, 404, 404, 404]);
    expect(expectedApiStatus("/privacy/")).toBeUndefined();
    const probes = probePaths(tree({}), PUBLIC);
    for (const path of [...SEEDED_PROBES, ...UNKNOWN_SLUG_PROBES]) expect(probes).toContain(path);
    const call = (probe: string, status: number | undefined, extra: Partial<RelayedCall> = {}) => ({
      probe,
      expected: expectedApiStatus(probe),
      method: "GET",
      path: "/api/invite/x",
      status,
      workerUserAgent: "absent" as const,
      ...extra,
    });
    expect(
      relayRefusals([
        call("/cire-wedding", 200),
        call("/wrangler.json", 404),
        call("/privacy/", 500),
      ]),
    ).toEqual([]);
    const refusals = relayRefusals([
      call("/cire-wedding", 500),
      call("/wrangler.json", 200),
      call("/cire-wedding/registry", 403, { blocked: "Cloudflare answered 403 (cf-mitigated)" }),
      call("/.dev.vars", undefined, { error: "Unable to connect" }),
    ]);
    expect(refusals).toHaveLength(4);
    expect(refusals[0]).toContain("/cire-wedding: cire-api answered the Wrangler side 500");
    expect(refusals[0]).toContain("expected 200");
    expect(refusals[1]).toContain("expected 404");
    expect(refusals[2]).toContain("cf-mitigated");
    expect(refusals[3]).toContain("Unable to connect");
  });
});

// ── the relay ──────────────────────────────────────────────────────────────

const API = "https://api.cire.example.test";

/** A stand-in for cire-api: every request it is handed, and one answer. */
function upstream(answer: () => Response = () => Response.json({ ok: true })): {
  readonly sent: { readonly url: string; readonly init: RequestInit }[];
  readonly fetchImpl: FetchLike;
} {
  const sent: { url: string; init: RequestInit }[] = [];
  return {
    sent,
    fetchImpl: (url, init = {}) => {
      sent.push({ url, init });
      return Promise.resolve(answer());
    },
  };
}

/** A loopback port nothing listens on. */
function closedPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

describe("the relay", () => {
  test("PF17: a relayed call reaches cire-api with the CI user agent in place of the Worker's, and without the relay's own headers, CF-Worker or the Worker's host", async () => {
    const api = upstream();
    const calls: RelayedCall[] = [];
    const request = new Request("http://127.0.0.1:4444/api/invite/cire-wedding?from=x", {
      headers: {
        "user-agent": "the-worker",
        accept: "application/json",
        [WORKER_UA_HEADER]: "present",
        [RELAY_TOKEN_HEADER]: "run-token",
        "cf-worker": "127.0.0.1:5555",
        host: "127.0.0.1:4444",
      },
    });
    const response = await relayRequest(request, API, api.fetchImpl, (one) => calls.push(one));
    expect(response.status).toBe(200);
    expect(api.sent.map((one) => one.url)).toEqual([`${API}/api/invite/cire-wedding?from=x`]);
    const sent = new Headers(api.sent[0]?.init.headers);
    expect(sent.get("user-agent")).toBe(CI_USER_AGENT);
    expect(sent.get("accept")).toBe("application/json");
    for (const name of [WORKER_UA_HEADER, RELAY_TOKEN_HEADER, "cf-worker", "host"]) {
      expect({ [name]: sent.get(name) }).toEqual({ [name]: null });
    }
    expect(calls).toEqual([
      {
        method: "GET",
        path: "/api/invite/cire-wedding?from=x",
        status: 200,
        workerUserAgent: "present",
      },
    ]);
    // A Worker request with no user agent of its own is recorded as such.
    await relayRequest(
      new Request("http://127.0.0.1:4444/api/invite/x", {
        headers: { [WORKER_UA_HEADER]: "absent" },
      }),
      API,
      api.fetchImpl,
      (one) => calls.push(one),
    );
    expect(calls[1]?.workerUserAgent).toBe("absent");
  });

  test("PF20: the method, a JSON body, the status and the answer's body pass through, and a redirect is handed back, not followed", async () => {
    const api = upstream(() =>
      Response.json({ slug: "cire-wedding" }, { status: 201, headers: { "x-kept": "yes" } }),
    );
    const calls: RelayedCall[] = [];
    const body = JSON.stringify({ slug: "cire-wedding" });
    const response = await relayRequest(
      new Request("http://127.0.0.1:4444/api/invite/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      }),
      API,
      api.fetchImpl,
      (one) => calls.push(one),
    );
    const init = api.sent[0]?.init;
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    expect(new TextDecoder().decode(init?.body as ArrayBuffer)).toBe(body);
    expect(new Headers(init?.headers).get("content-type")).toBe("application/json");
    expect(response.status).toBe(201);
    expect(response.headers.get("x-kept")).toBe("yes");
    expect(await response.json()).toEqual({ slug: "cire-wedding" });
    expect(calls[0]).toMatchObject({ method: "POST", path: "/api/invite/resolve", status: 201 });

    const moved = upstream(
      () => new Response(null, { status: 302, headers: { location: `${API}/elsewhere` } }),
    );
    const redirect = await relayRequest(
      new Request("http://127.0.0.1:4444/api/invite/x"),
      API,
      moved.fetchImpl,
      () => {},
    );
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBe(`${API}/elsewhere`);
    expect(moved.sent).toHaveLength(1);

    // cire-api is not behind Access: its own 403 is its status, not Cloudflare's.
    const refused = upstream(() => new Response("no", { status: 403 }));
    await relayRequest(
      new Request("http://127.0.0.1:4444/api/invite/x"),
      API,
      refused.fetchImpl,
      (one) => calls.push(one),
    );
    expect(calls.at(-1)).toEqual({
      method: "GET",
      path: "/api/invite/x",
      status: 403,
      workerUserAgent: "absent",
    });
  });

  test("PF21: cire-api refusing the connection answers the Worker 502, once, and the record names the error without a loopback port", async () => {
    const port = await closedPort();
    let tries = 0;
    const counted: FetchLike = (url, init) => {
      tries += 1;
      return fetch(url, init);
    };
    const calls: RelayedCall[] = [];
    const response = await relayRequest(
      new Request("http://127.0.0.1:4444/api/invite/cire-wedding"),
      `http://127.0.0.1:${port}`,
      counted,
      (one) => calls.push(one),
    );
    expect(response.status).toBe(502);
    expect(tries).toBe(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.status).toBeUndefined();
    expect(calls[0]?.error).toBeString();
    expect(calls[0]?.error).not.toContain(String(port));
    expect(calls[0]?.error).not.toMatch(/(127\.0\.0\.1|localhost|\[::1\]):\d/);
    // An error that names the address, as Node's does, loses its port.
    await relayRequest(
      new Request("http://127.0.0.1:4444/api/invite/cire-wedding"),
      `http://127.0.0.1:${port}`,
      () => Promise.reject(new TypeError(`connect ECONNREFUSED 127.0.0.1:${port}\nmore`)),
      (one) => calls.push(one),
    );
    expect(calls[1]?.error).toBe("connect ECONNREFUSED 127.0.0.1");
  });

  test("PF36: a compressed answer reaches the Worker decoded, with no content-encoding and no stale content-length", async () => {
    const json = JSON.stringify({ slug: "cire-wedding", title: "Ada & Kit".repeat(50) });
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(Bun.gzipSync(json), {
          headers: { "content-type": "application/json", "content-encoding": "gzip" },
        }),
    });
    try {
      const response = await relayRequest(
        new Request("http://127.0.0.1:4444/api/invite/cire-wedding"),
        `http://127.0.0.1:${server.port}`,
        (url, init) => fetch(url, init),
        () => {},
      );
      expect(response.headers.get("content-encoding")).toBeNull();
      const length = response.headers.get("content-length");
      expect(length === null || Number(length) === new TextEncoder().encode(json).length).toBe(
        true,
      );
      expect(await response.text()).toBe(json);
    } finally {
      void server.stop(true);
    }
  });

  test("PF37: a request to the relay without the run's token is refused 403 and sends nothing upstream", async () => {
    const api = upstream();
    const relay = startRelay(API, "run-token", api.fetchImpl, () => {});
    try {
      const at = `http://127.0.0.1:${relay.port}/api/invite/cire-wedding`;
      const without = await fetch(at);
      expect(without.status).toBe(403);
      const wrong = await fetch(at, { headers: { [RELAY_TOKEN_HEADER]: "another" } });
      expect(wrong.status).toBe(403);
      expect(api.sent).toHaveLength(0);
      const right = await fetch(at, { headers: { [RELAY_TOKEN_HEADER]: "run-token" } });
      expect(right.status).toBe(200);
      expect(api.sent).toHaveLength(1);
    } finally {
      relay.stop();
    }
  });
});

describe("the report", () => {
  test("PF11: is the same for the same answers, whatever port Wrangler took, with its keys sorted", async () => {
    const report = async (origin: string) => {
      const observation = await observe(
        new Response(null, { status: 302, headers: { location: `${origin}/next` } }),
        origin,
      );
      return renderReport({
        result: "match",
        refusals: [],
        routes: ["/"],
        reference: "wrangler dev",
        alchemy: OWN,
        probes: [
          { path: "/", wrangler: observation, alchemy: observation, differences: [], allowed: [] },
        ],
        cireApi: { control: [], relayed: [] },
      });
    };
    const first = await report("http://127.0.0.1:1111");
    expect(first).toBe(await report("http://127.0.0.1:2222"));
    expect(first).not.toContain("127.0.0.1");
    const keys = Object.keys(JSON.parse(first) as object);
    expect(keys).toEqual(keys.toSorted());
  });
});
