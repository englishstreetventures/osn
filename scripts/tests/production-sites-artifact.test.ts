// scripts/production-sites-artifact.ts checks the `production-sites`
// artifact a token-holding job downloaded outside its checkout, and only
// then puts the site builds in place. These build artifact trees in a temp
// directory, with real files and links, and a temp root to place them in.

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  artifactProblems,
  LIST_FILE,
  placeProductionSites,
  SITE_DIRECTORIES,
} from "../production-sites-artifact";

/** A download directory holding `files`, and an empty root to place them under. */
function tree(files: Record<string, string>) {
  const base = mkdtempSync(join(tmpdir(), "production-sites-artifact-"));
  const download = join(base, "download");
  const root = join(base, "root");
  mkdirSync(download);
  mkdirSync(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(download, path)), { recursive: true });
    writeFileSync(join(download, path), content);
  }
  return { base, download, root };
}

function place(download: string, root: string) {
  const lines: string[] = [];
  const code = placeProductionSites({ args: [download], root, out: (text) => lines.push(text) });
  return { code, output: lines.join("") };
}

/** Every path under `dir`, `/`-separated, sorted. */
const listing = (dir: string): string[] =>
  existsSync(dir)
    ? (readdirSync(dir, { recursive: true }) as string[])
        .map((p) => p.replaceAll("\\", "/"))
        .toSorted()
    : [];

const GOOD = {
  [LIST_FILE]: "cire/host/dist\nmusubi/social/dist\n",
  "cire/host/dist/index.html": "<h1>host</h1>",
  "cire/host/dist/_headers": "/*\n  X-Frame-Options: DENY\n",
  "musubi/social/dist/index.html": "<h1>social</h1>",
  "musubi/social/dist/.well-known/apple-app-site-association": "{}",
};

describe("production-sites-artifact.ts", () => {
  test("AF1: imports only the import-free production-sites.ts and node built-ins", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "production-sites-artifact.ts"),
      "utf8",
    );
    const imports = [...source.matchAll(/^import[^;]*from "([^"]+)";/gm)].map((m) => m[1]);
    expect(imports.toSorted()).toEqual(
      ["../shared/infra/src/production-sites", "node:fs", "node:path"].toSorted(),
    );
  });

  test("AF1: the builds it allows are the five the sites job uploads", () => {
    expect(SITE_DIRECTORIES).toEqual([
      "cire/host/dist",
      "cire/vendor/dist",
      "cire/landing/dist",
      "musubi/social/dist",
      "musubi/landing/dist",
    ]);
  });

  test("AF2: places each site build the artifact holds, hidden files included, and nothing else", () => {
    const { base, download, root } = tree(GOOD);
    try {
      mkdirSync(join(root, "cire/host/dist/stale"), { recursive: true });
      writeFileSync(join(root, "cire/host/dist/stale/old.js"), "old");
      const result = place(download, root);
      expect(result.code).toBe(0);
      expect(result.output).toBe("Placed cire/host/dist\nPlaced musubi/social/dist\n");
      expect(listing(root)).toEqual(
        [
          "cire",
          "cire/host",
          "cire/host/dist",
          "cire/host/dist/_headers",
          "cire/host/dist/index.html",
          "musubi",
          "musubi/social",
          "musubi/social/dist",
          "musubi/social/dist/.well-known",
          "musubi/social/dist/.well-known/apple-app-site-association",
          "musubi/social/dist/index.html",
        ].toSorted(),
      );
      expect(readFileSync(join(root, "cire/host/dist/index.html"), "utf8")).toBe("<h1>host</h1>");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test.each([
    "cire/infra/alchemy.run.ts",
    "node_modules/alchemy/src/index.js",
    "scripts/ensure-pages-project.sh",
    "cire/host/package.json",
    "cire/host/distx/index.html",
    "pulse/landing/dist/index.html",
    ".github/workflows/production-release.yml",
  ])("AF3: refuses an artifact holding %s, placing nothing", (stray) => {
    const { base, download, root } = tree({ ...GOOD, [stray]: "planted" });
    try {
      const result = place(download, root);
      expect(result.code).toBe(1);
      expect(result.output).toContain(`refused the artifact: ${stray} is not part of a site build`);
      expect(listing(root)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("AF4: refuses a symbolic link inside a build, or a build that is one, placing nothing", () => {
    for (const [link, target] of [
      ["cire/host/dist/passwd", "/etc/passwd"],
      ["musubi/landing/dist", "../../cire/host/dist"],
    ] as const) {
      const { base, download, root } = tree(GOOD);
      try {
        mkdirSync(dirname(join(download, link)), { recursive: true });
        symlinkSync(target, join(download, link));
        const result = place(download, root);
        expect({ link, code: result.code }).toEqual({ link, code: 1 });
        expect(result.output).toContain(`${link} is a symbolic link`);
        expect(listing(root)).toEqual([]);
      } finally {
        rmSync(base, { recursive: true, force: true });
      }
    }
  });

  test("AF5: refuses a path that climbs, names itself, or starts at the root, and a build that is a file", () => {
    for (const path of ["cire/host/dist/../../../scripts/x.sh", "cire/./host/dist/a", "/etc/x"]) {
      expect(artifactProblems([{ path, kind: "file" }])).toEqual([
        `${path} is not a plain relative path`,
      ]);
    }
    expect(artifactProblems([{ path: "cire/host/dist", kind: "file" }])).toEqual([
      "cire/host/dist is not part of a site build",
    ]);
    expect(artifactProblems([{ path: "cire/host", kind: "file" }])).toEqual([
      "cire/host is not part of a site build",
    ]);
    expect(artifactProblems([{ path: "cire/host/dist/x", kind: "other" }])).toEqual([
      "cire/host/dist/x is neither a file nor a directory",
    ]);
    expect(
      artifactProblems([
        { path: LIST_FILE, kind: "file" },
        { path: "cire", kind: "directory" },
        { path: "cire/host", kind: "directory" },
        { path: "cire/host/dist", kind: "directory" },
        { path: "cire/host/dist/a/b.js", kind: "file" },
      ]),
    ).toEqual([]);
  });

  test("AF6: no directory, a missing one, or a second argument is a usage error", () => {
    const base = mkdtempSync(join(tmpdir(), "production-sites-artifact-"));
    try {
      for (const args of [[], [join(base, "missing")], [base, base]]) {
        const lines: string[] = [];
        const code = placeProductionSites({ args, root: base, out: (text) => lines.push(text) });
        expect({ args, code }).toEqual({ args, code: 2 });
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
