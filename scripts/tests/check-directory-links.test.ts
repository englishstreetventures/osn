// scripts/check-directory-links.ts: no cire site links one of the sites'
// directory pages (`/privacy`, a page the build writes as
// `privacy/index.html`) without its trailing slash. Cloudflare's asset server
// answers the slash-less address with a redirect to the slash form, so such a
// link costs every click a round trip.
//
// One case per way the guard can fail. The strings are the forms today's
// minified builds use (Solid drops attribute quotes inside its templates,
// Rolldown turns plain strings into template literals), so a guard that
// stops reading one of them goes red here.
//
// No `bun install`: this only imports `bun:test`, `node:*` and the script
// under test, like every other file under scripts/.

import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Glob } from "bun";

import { CIRE_SITES, checkDirectoryLinks, directoryLinks } from "../check-directory-links";

const ADDRESSES = new Set([
  "/privacy",
  "/privacy/hosts",
  "/privacy/guests",
  "/terms",
  "/login",
  "/claim",
]);

const slashless = (text: string): readonly string[] =>
  directoryLinks(text, ADDRESSES).slashless.map((link) => link.address);

describe("directoryLinks", () => {
  test("a quoted root-relative link to a directory page is caught", () => {
    expect(slashless(`<a href="/privacy">Privacy</a>`)).toEqual(["/privacy"]);
    expect(slashless(`<a href='/terms'>Terms</a>`)).toEqual(["/terms"]);
  });

  test("a query or a fragment after the address does not hide it", () => {
    expect(slashless("window.location.href=`/login?returnTo=${encodeURIComponent(e)}`")).toEqual([
      "/login",
    ]);
    expect(slashless(`<a href="/privacy#hosts">`)).toEqual(["/privacy"]);
  });

  test("an unquoted attribute inside a Solid template is caught", () => {
    expect(slashless("C=[`<a`,` href=/privacy target=_blank rel=noopener>`]")).toEqual([
      "/privacy",
    ]);
    expect(slashless("`<a href=/terms>Terms</a>`")).toEqual(["/terms"]);
  });

  test("a template literal opening on another site's origin is caught", () => {
    expect(slashless("k(t,`href`,`${te}/privacy/guests`)")).toEqual(["/privacy/guests"]);
  });

  test("an absolute link to a cire host is caught", () => {
    expect(slashless(`"https://cireweddings.com/terms"`)).toEqual(["/terms"]);
    expect(slashless(`"http://localhost:4323/privacy"`)).toEqual(["/privacy"]);
    expect(slashless(`"https://host.cire.localhost/login?x=1"`)).toEqual(["/login"]);
    expect(slashless(`"//vendor.cireweddings.com/claim"`)).toEqual(["/claim"]);
  });

  test("an absolute link to any other host is left alone", () => {
    expect(slashless(`"https://musubi.social/privacy"`)).toEqual([]);
    expect(slashless(`"//evil.example/login"`)).toEqual([]);
    expect(slashless(`"https://id.musubi.localhost/login"`)).toEqual([]);
  });

  test("the slash form passes, and is counted", () => {
    const links = directoryLinks(
      '<a href="/privacy/">' +
        "`/login/?returnTo=${e}`" +
        "`${te}/privacy/hosts/`" +
        "`<a href=/terms/>`" +
        `"https://cireweddings.com/privacy/guests/"`,
      ADDRESSES,
    );
    expect(links.slashless).toEqual([]);
    expect(links.slashForm).toBe(5);
  });

  test("a path that only starts or ends with an address is not one", () => {
    expect(slashless(`"/privacy-policy"`)).toEqual([]);
    expect(slashless(`"/loginx"`)).toEqual([]);
    expect(slashless("`${t.apiUrl}/api/claim`")).toEqual([]);
    expect(slashless("`${s(e,t)}/items/${encodeURIComponent(n)}/claim`")).toEqual([]);
    expect(slashless(`"/"`)).toEqual([]);
  });

  test("an address followed by an interpolation or an escaped quote is caught", () => {
    expect(slashless("`/login${q}`")).toEqual(["/login"]);
    expect(slashless(`"{\\"href\\":\\"/privacy\\"}"`)).toEqual(["/privacy"]);
  });
});

/** Writes `files` (path → content) under a fresh directory and returns it. */
async function fixture(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "check-directory-links-"));
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

const PRIVACY_PAGE = `<html><body><a href="/privacy/">Privacy</a></body></html>`;

describe("checkDirectoryLinks", () => {
  test("an island's props, quoted as HTML entities, are read", async () => {
    const root = await fixture({
      "index.html":
        `<a href="/privacy/">x</a>` +
        `<astro-island props="{&quot;href&quot;:[0,&quot;/privacy&quot;]}"></astro-island>`,
      "privacy/index.html": PRIVACY_PAGE,
    });
    try {
      const { findings } = await checkDirectoryLinks([{ name: "site", pages: root, scan: [root] }]);
      expect(findings.map((finding) => finding.address)).toEqual(["/privacy"]);
      expect(findings[0]?.file).toBe("index.html");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a file that is no page or script is not read", async () => {
    const root = await fixture({
      "index.html": PRIVACY_PAGE,
      "privacy/index.html": PRIVACY_PAGE,
      _headers: '/privacy\n  Link: "/privacy"\n',
      "robots.txt": 'Disallow: "/privacy"\n',
    });
    try {
      const { findings } = await checkDirectoryLinks([{ name: "site", pages: root, scan: [root] }]);
      expect(findings).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a link to another site's directory page is caught", async () => {
    const landing = await fixture({
      "index.html": PRIVACY_PAGE,
      "privacy/index.html": PRIVACY_PAGE,
    });
    const host = await fixture({
      "index.html": `<a href="/login/">Sign in</a>`,
      "login/index.html": "<html></html>",
      "_astro/app.js": "c(t,`href`,`${te}/privacy`)",
    });
    try {
      const { findings } = await checkDirectoryLinks([
        { name: "landing", pages: landing, scan: [landing] },
        { name: "host", pages: host, scan: [host] },
      ]);
      expect(findings.map((finding) => [finding.site, finding.file, finding.address])).toEqual([
        ["host", "_astro/app.js", "/privacy"],
      ]);
    } finally {
      await rm(landing, { recursive: true, force: true });
      await rm(host, { recursive: true, force: true });
    }
  });

  test("a server chunk is read as a script", async () => {
    // The guest site renders some pages on the Worker, so a link may sit only
    // in `dist/server/chunks/*.mjs`.
    const root = await fixture({
      "index.html": PRIVACY_PAGE,
      "privacy/index.html": PRIVACY_PAGE,
      "chunks/NotFoundDocument_x.mjs": 'const t=`<a href="${e}">`,n="/privacy";',
    });
    try {
      const { findings } = await checkDirectoryLinks([{ name: "site", pages: root, scan: [root] }]);
      expect(findings.map((finding) => [finding.file, finding.address])).toEqual([
        ["chunks/NotFoundDocument_x.mjs", "/privacy"],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a missing directory is a finding, not a pass", async () => {
    const root = await fixture({ "index.html": PRIVACY_PAGE, "privacy/index.html": PRIVACY_PAGE });
    const missing = join(root, "no-such-dist");
    try {
      const pagesGone = await checkDirectoryLinks([{ name: "a", pages: missing, scan: [root] }]);
      expect(pagesGone.findings.map((finding) => finding.site)).toEqual(["a"]);
      expect(pagesGone.findings[0]?.problem).toContain(missing);

      const scanGone = await checkDirectoryLinks([{ name: "b", pages: root, scan: [missing] }]);
      expect(scanGone.findings.map((finding) => finding.site)).toEqual(["b"]);
      expect(scanGone.findings[0]?.problem).toContain(missing);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a site with no page at all is a finding", async () => {
    const root = await fixture({ "_astro/app.js": "`/privacy/`" });
    try {
      const { findings } = await checkDirectoryLinks([{ name: "site", pages: root, scan: [root] }]);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.problem).toContain("no index.html");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a site served from the server at its root, with directory pages below, passes", async () => {
    // The guest site's shape: `/` is rendered by the Worker, so `dist/client`
    // holds `privacy/index.html` and `terms/index.html` but no root page.
    const root = await fixture({
      "privacy/index.html": `<a href="/privacy/">Privacy</a> <a href="/terms/">Terms</a>`,
      "terms/index.html": `<a href="/privacy/">Privacy</a>`,
    });
    try {
      const { findings, reports } = await checkDirectoryLinks([
        { name: "guest", pages: root, scan: [root] },
      ]);
      expect(findings).toEqual([]);
      expect(reports).toEqual([{ site: "guest", pages: 2, files: 2, slashForm: 3 }]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a site whose files link no directory page in the slash form is a finding", async () => {
    // The scan stopped reading this build's links, or the build stopped
    // linking its own pages. Either way a pass would mean nothing.
    const root = await fixture({
      "index.html": `<a href="https://example.com/">x</a>`,
      "privacy/index.html": "<html></html>",
    });
    try {
      const { findings } = await checkDirectoryLinks([{ name: "site", pages: root, scan: [root] }]);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.problem).toContain("no link to a directory page");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("CIRE_SITES", () => {
  // CI runs the guard with no arguments, so this list is all it checks. It is
  // read against the repository, not a copy of itself: a cire Astro site added,
  // dropped or switched to server output fails here until the list follows.
  test("names every cire Astro site, with its pages and, for a server site, its chunks", async () => {
    const repo = resolve(import.meta.dir, "../..");
    const expected = [];
    for await (const config of new Glob("cire/*/astro.config.*").scan({ cwd: repo })) {
      const dir = dirname(config);
      const source = await Bun.file(join(repo, config)).text();
      const server = /\boutput:\s*["']server["']/.test(source);
      const pages = join(repo, dir, server ? "dist/client" : "dist");
      const scan = server ? [pages, join(repo, dir, "dist/server/chunks")] : [pages];
      expected.push({ name: dir, pages, scan });
    }
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    expect(expected.length).toBeGreaterThanOrEqual(4);
    expect(CIRE_SITES.toSorted(byName)).toEqual(expected.toSorted(byName));
  });
});
