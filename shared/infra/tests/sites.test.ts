import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, describe, expect, test } from "vitest";

import { assertSiteBuiltFor, SiteBuildError } from "../src/sites";

const API = "https://api.cire.example.test";
const SITE = "https://invite.cire.example.test";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A fresh directory beside nothing else, holding each file of `files` at its relative path. */
function directoryWith(files: Readonly<Record<string, string | Uint8Array>>): string {
  const root = mkdtempSync(join(tmpdir(), "infra-sites-"));
  roots.push(root);
  const dist = join(root, "dist");
  mkdirSync(dist);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dist, path)), { recursive: true });
    writeFileSync(join(dist, path), content);
  }
  return dist;
}

/** The SiteBuildError `run` throws; fails the test when it throws nothing or anything else. */
function refusalOf(run: () => void): SiteBuildError {
  try {
    run();
  } catch (error) {
    if (error instanceof SiteBuildError) return error;
    throw error;
  }
  throw new Error("expected a SiteBuildError");
}

describe("assertSiteBuiltFor", () => {
  test("SB1: a directory that does not exist is refused, naming the site and every origin", () => {
    const directory = join(directoryWith({}), "missing");
    const refused = refusalOf(() =>
      assertSiteBuiltFor({ site: "@cire/host", directory, origins: [API, SITE] }),
    );
    expect(refused).toMatchObject({ site: "@cire/host", directory, missing: [API, SITE] });
    expect(refused.message).toContain("@cire/host");
    expect(refused.message).toContain(directory);
  });

  test("SB2: an origin no text file holds is refused, naming the site and that origin alone", () => {
    const directory = directoryWith({
      "index.html": `<a href="${API}/api/x">`,
      "_astro/app.js": 'fetch("https://api.cire.other.test")',
    });
    const refused = refusalOf(() =>
      assertSiteBuiltFor({ site: "@cire/host", directory, origins: [API, SITE] }),
    );
    expect(refused).toMatchObject({ site: "@cire/host", missing: [SITE] });
    expect(refused.message).toContain(SITE);
    expect(refused.message).not.toContain(API);
  });

  test("SB3: passes when every origin is in some text file, one of them in a nested .js file", () => {
    const directory = directoryWith({
      "index.html": `<link rel="canonical" href="${SITE}/">`,
      "_astro/chunks/osn.js": `const api="${API}";`,
    });
    expect(() =>
      assertSiteBuiltFor({ site: "@cire/host", directory, origins: [API, SITE] }),
    ).not.toThrow();
  });

  test("SB3: each text kind counts: html, js, mjs, css, json, xml and txt", () => {
    for (const name of ["a.html", "a.js", "a.mjs", "a.css", "a.json", "a.xml", "a.txt"]) {
      const directory = directoryWith({ [name]: `"${API}"` });
      expect(() => assertSiteBuiltFor({ site: name, directory, origins: [API] })).not.toThrow();
    }
  });

  test("SB4: an origin only a binary file holds is not found", () => {
    const directory = directoryWith({
      "index.html": "<!doctype html>",
      "fonts/a.woff2": new TextEncoder().encode(`\u0000${API}\u0000`),
      "a.map": `{"sources":["${API}"]}`,
    });
    const refused = refusalOf(() =>
      assertSiteBuiltFor({ site: "@cire/host", directory, origins: [API] }),
    );
    expect(refused.missing).toEqual([API]);
  });

  test("SB5: an origin followed by more of a host name, or by a port, is not that origin", () => {
    for (const text of [`${API}.evil.test/x`, `${API}ing/x`, `${API}-2/x`, `${API}:8443/x`]) {
      const directory = directoryWith({ "a.js": `"${text}"` });
      expect({
        text,
        missing: refusalOf(() => assertSiteBuiltFor({ site: "a", directory, origins: [API] }))
          .missing,
      }).toEqual({ text, missing: [API] });
    }
  });

  test("SB5: an origin followed by a path, a quote, a space, a full stop or the end of the file is found", () => {
    for (const text of [`${API}/x`, `"${API}"`, `${API} 'self'`, `see ${API}.`, API]) {
      const directory = directoryWith({ "a.txt": text });
      expect(() => assertSiteBuiltFor({ site: "a", directory, origins: [API] })).not.toThrow();
    }
  });

  test("SB6: never follows a link out of the directory", () => {
    const outside = directoryWith({ "secret.js": `"${API}"`, "nested/b.js": `"${API}"` });
    const directory = directoryWith({ "index.html": "<!doctype html>" });
    symlinkSync(join(outside, "secret.js"), join(directory, "linked.js"));
    symlinkSync(join(outside, "nested"), join(directory, "linked-dir"));
    const refused = refusalOf(() =>
      assertSiteBuiltFor({ site: "@cire/host", directory, origins: [API] }),
    );
    expect(refused.missing).toEqual([API]);
  });

  test("SB7: Cloudflare's _headers counts as text", () => {
    const directory = directoryWith({
      _headers: `/*\n  Content-Security-Policy: connect-src 'self' ${API}\n`,
    });
    expect(() =>
      assertSiteBuiltFor({ site: "@cire/invites client", directory, origins: [API] }),
    ).not.toThrow();
  });

  test("SB8: a file in place of the directory is refused", () => {
    const directory = join(directoryWith({ "index.html": `"${API}"` }), "index.html");
    const refused = refusalOf(() =>
      assertSiteBuiltFor({ site: "@cire/host", directory, origins: [API] }),
    );
    expect(refused.missing).toEqual([API]);
  });

  test("SB8: a site with no origins is refused: nothing would tie its build to the stage", () => {
    const directory = directoryWith({ "index.html": `"${API}"` });
    const refused = refusalOf(() =>
      assertSiteBuiltFor({ site: "@cire/host", directory, origins: [] }),
    );
    expect(refused).toMatchObject({ site: "@cire/host", missing: [] });
  });
});
