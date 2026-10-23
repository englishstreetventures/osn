// The comparison rules of scripts/guest-route-parity.ts, one test per way
// they can fail (NEW-FEAT.md, PF1–PF13, PF15). The run itself — wrangler
// started, both sides probed, the report written — is in
// guest-route-parity.cli.test.ts.

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  allowancesUsed,
  compare,
  EMULATION_ALLOWANCES,
  GUEST_SEED,
  observe,
  probePaths,
  referenceEnv,
  renderReport,
  routeFor,
  routesFromPages,
  routesInBuild,
  SEEDED_PROBES,
  seedRendered,
  blockedReason,
  uncoveredRoutes,
  type Observation,
} from "../guest-route-parity";

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

  test("probes the first built script, stylesheet and font by name", () => {
    const client = tree({
      "_astro/b.js": "",
      "_astro/a.js": "",
      "_astro/z.css": "",
      "_astro/f.woff2": "",
    });
    expect(probePaths(client, PUBLIC).filter((path) => path.startsWith("/_astro/"))).toEqual([
      "/_astro/route-parity-missing.js",
      "/_astro/a.js",
      "/_astro/z.css",
      "/_astro/f.woff2",
    ]);
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

  test("PF13: wrangler dev runs with no Cloudflare credential, no Access token and telemetry off", () => {
    expect(
      referenceEnv({
        PATH: "/usr/bin",
        HOME: "/home/runner",
        TMPDIR: "/tmp",
        CLOUDFLARE_API_TOKEN: "token",
        CLOUDFLARE_ACCOUNT_ID: "account",
        CF_ACCESS_CLIENT_ID: "id",
        CF_ACCESS_CLIENT_SECRET: "secret",
        GITHUB_TOKEN: "gh",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/runner",
      TMPDIR: "/tmp",
      DO_NOT_TRACK: "1",
      WRANGLER_SEND_METRICS: "false",
    });
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
      });
    };
    const first = await report("http://127.0.0.1:1111");
    expect(first).toBe(await report("http://127.0.0.1:2222"));
    expect(first).not.toContain("127.0.0.1");
    const keys = Object.keys(JSON.parse(first) as object);
    expect(keys).toEqual(keys.toSorted());
  });
});
