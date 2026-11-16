// scripts/version-bump.ts tells the release planner which changed files hold
// only what a release's version bump wrote. A file it wrongly sets aside is
// one a production release never ships and the dev gate never checks, so each
// case here is a change it must keep; the few it may set aside are marked.
// The planner's own tests (release-plan.test.ts, `VC`) drive real version
// commits through a whole plan.

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sharedPath, STACKS, SURFACES } from "../deploy-surfaces";
import { contentDiff, versionOnly, workspaceDirs } from "../version-bump";
import {
  AFTER,
  authUiManifest,
  BEFORE,
  CLSX_HASH,
  lockfile,
  merge,
  released,
  uiManifest,
  versionLockfile,
  versionPackages,
} from "./version-commits";

const ROOT = new URL("../..", import.meta.url).pathname;
const WORKSPACES = workspaceDirs(lockfile(AFTER));
const UI = "shared/ui/package.json";
const deps = (m: Record<string, unknown>, field = "dependencies") =>
  m[field] as Record<string, string>;
const bumped = (edit: (m: Record<string, unknown>) => void) => uiManifest(AFTER.ui, edit);
const judge = (path: string, before: string | undefined, after: string | undefined) =>
  versionOnly(path, before, after, WORKSPACES);

describe("package.json", () => {
  test("set aside: the version alone, as 355c9c2e9 changed it", () => {
    expect(judge(UI, uiManifest(BEFORE.ui), uiManifest(AFTER.ui))).toBe(true);
    expect(
      judge("osn/auth-ui/package.json", authUiManifest("6.0.0"), authUiManifest("6.0.1")),
    ).toBe(true);
  });

  test.each<[string, (m: Record<string, unknown>) => void]>([
    ["a dependency added", (m) => void (deps(m).nanoid = "^5.1.5")],
    ["a dependency removed", (m) => void delete deps(m).clsx],
    ["an external range changed", (m) => void (deps(m).clsx = "^2.1.2")],
    ["a dev dependency added", (m) => void (deps(m, "devDependencies").vite = "^8.3.3")],
    ["a peer range changed", (m) => void (deps(m, "peerDependencies")["solid-js"] = ">=2")],
    ["a script changed", (m) => void ((m.scripts as Record<string, string>).test = "true")],
    ["a bin added", (m) => void (m.bin = { ui: "./bin/ui.ts" })],
    ["the name changed", (m) => void (m.name = "@shared/ui-next")],
    [
      "an export changed",
      (m) => void ((m.exports as Record<string, string>)["./ui/button"] = "./src/b.tsx"),
    ],
    [
      "the order of an export's conditions swapped",
      (m) => {
        const exports = m.exports as Record<string, unknown>;
        exports["./ui/orb"] = { default: "./src/ui/orb.tsx", types: "./src/ui/orb-api.ts" };
      },
    ],
    [
      "an internal range moved from workspace:* to workspace:^",
      (m) => void (deps(m, "devDependencies")["@shared/design-tokens"] = "workspace:^"),
    ],
    [
      "an internal range written without workspace:, which may resolve from the registry",
      (m) => void (deps(m, "devDependencies")["@shared/design-tokens"] = "^0.16.0"),
    ],
  ])("content: the version bumped and %s", (_name, edit) => {
    expect(judge(UI, uiManifest(BEFORE.ui), bumped(edit))).toBe(false);
  });

  // Its line looks like a version line, so only the parsed check sees it.
  test("content: a dependency named version changed", () => {
    const before = uiManifest(BEFORE.ui, (m) => void (deps(m).version = "^1.0.0"));
    const after = bumped((m) => void (deps(m).version = "^1.0.1"));
    expect(judge(UI, before, after)).toBe(false);
  });

  // JSON.parse keeps the last of two equal keys; another reader may keep the
  // first. Two copies that parse alike are still two different files.
  test("content: a repeated key, though both copies parse alike", () => {
    const after = uiManifest(AFTER.ui).replace(
      '  "dependencies": {',
      '  "dependencies": {\n    "left-pad": "1.3.0"\n  },\n  "dependencies": {',
    );
    expect(JSON.stringify(JSON.parse(after))).toBe(
      JSON.stringify(JSON.parse(uiManifest(AFTER.ui))),
    );
    expect(judge(UI, uiManifest(BEFORE.ui), after)).toBe(false);
    const twice = uiManifest(AFTER.ui).replace(
      `"version": "${AFTER.ui}",`,
      `"version": "${AFTER.ui}",\n  "version": "${AFTER.ui}",`,
    );
    expect(judge(UI, uiManifest(BEFORE.ui), twice)).toBe(false);
  });

  test("content: added or deleted", () => {
    expect(judge(UI, undefined, uiManifest(AFTER.ui))).toBe(false);
    expect(judge(UI, uiManifest(BEFORE.ui), undefined)).toBe(false);
  });

  test.each([
    ["a trailing comma", `${uiManifest(AFTER.ui).trimEnd().slice(0, -1)},}`],
    ["a truncated file", uiManifest(AFTER.ui).slice(0, 40)],
    ["an array", "[]"],
    ["null", "null"],
    ["an empty file", ""],
  ])("content: either side is %s", (_name, broken) => {
    expect(judge(UI, uiManifest(BEFORE.ui), broken)).toBe(false);
    expect(judge(UI, broken, uiManifest(AFTER.ui))).toBe(false);
  });

  test("content: the same fields, reformatted", () => {
    const compact = `${JSON.stringify(JSON.parse(uiManifest(AFTER.ui)))}\n`;
    expect(judge(UI, uiManifest(BEFORE.ui), compact)).toBe(false);
  });
});

describe("bun.lock", () => {
  test("set aside: each workspace's version line, as 9689d29c9 changed them", () => {
    expect(judge("bun.lock", lockfile(BEFORE), lockfile(AFTER))).toBe(true);
  });

  test.each([
    ["an external package's integrity hash", lockfile(AFTER).replace(CLSX_HASH, "sha512-x==")],
    [
      "a workspace dependency added",
      lockfile(AFTER, { uiDependencies: '\n        "nanoid": "^5.1.5",' }),
    ],
    [
      "a package entry added",
      lockfile(AFTER, { packages: '\n    "nanoid": ["nanoid@5.1.5", "", {}, "sha512-y=="],' }),
    ],
    [
      "a repeated package entry whose last copy is the original",
      lockfile(AFTER).replace(
        '    "clsx": [',
        '    "clsx": ["clsx@2.1.1", "https://example.test/clsx.tgz", {}, "sha512-z=="],\n    "clsx": [',
      ),
    ],
    ["a workspace removed", lockfile(AFTER).replace(/\n {4}"musubi\/infra": \{[^]*?\n {4}\},/, "")],
    [
      "the lockfile version",
      lockfile(AFTER).replace('"lockfileVersion": 1', '"lockfileVersion": 2'),
    ],
    ["an override", lockfile(AFTER).replace('"^5.0.11"', '"^5.0.12"')],
    [
      "a workspace's name",
      lockfile(AFTER).replace('"name": "@shared/ui"', '"name": "@shared/ui-next"'),
    ],
  ])("content: the versions bumped and %s", (_name, after) => {
    expect(judge("bun.lock", lockfile(BEFORE), after)).toBe(false);
  });

  test.each([
    ["unparsable", "{ nope"],
    ["an array", "[]"],
    ["without workspaces", '{ "lockfileVersion": 1 }'],
    ["with workspaces that is not an object", '{ "lockfileVersion": 1, "workspaces": [] }'],
  ])("content: either side is %s", (_name, broken) => {
    expect(judge("bun.lock", lockfile(BEFORE), broken)).toBe(false);
    expect(judge("bun.lock", broken, lockfile(AFTER))).toBe(false);
  });

  test("content: a bun.lock anywhere but the root", () => {
    expect(judge("tools/x/bun.lock", lockfile(BEFORE), lockfile(AFTER))).toBe(false);
  });
});

describe("CHANGELOG.md", () => {
  test("set aside: one in a workspace's directory, added or edited", () => {
    expect(judge("shared/ui/CHANGELOG.md", "# a\n", "# b\n")).toBe(true);
    expect(judge("musubi/infra/CHANGELOG.md", undefined, "# b\n")).toBe(true);
  });

  test("content: one in a directory no workspace owns, as a site's public/ would serve", () => {
    expect(judge("cire/landing/public/CHANGELOG.md", "# a\n", "# b\n")).toBe(false);
    expect(judge("shared/ui/src/CHANGELOG.md", "# a\n", "# b\n")).toBe(false);
  });

  test("content: every CHANGELOG when the lockfile names no workspaces", () => {
    expect(workspaceDirs("{ nope")).toEqual(new Set());
    expect(versionOnly("shared/ui/CHANGELOG.md", "a", "b", workspaceDirs("{ nope"))).toBe(false);
  });
});

test.each([
  "shared/ui/package.json.bak",
  "shared/ui/CHANGELOG.mdx",
  "shared/ui/changelog.md",
  "bun.lockb",
  "shared/ui/src/ui/button.tsx",
])("content: %s, whose path only looks like one", (path) => {
  expect(judge(path, "a", "b")).toBe(false);
});

// ── against git ─────────────────────────────────────────────────────────────

const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

function git(cwd: string, ...args: string[]): string {
  const proc = Bun.spawnSync(
    ["git", "-c", "user.email=t@example.com", "-c", "user.name=T", ...args],
    {
      cwd,
      env: { ...process.env, ...GIT_ENV },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
  return proc.stdout.toString().trim();
}

async function commit(repo: string, files: Record<string, string | null>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) await rm(join(repo, path));
    else await Bun.write(join(repo, path), content);
  }
  git(repo, "add", "-A");
  git(repo, "commit", "-m", "change");
  return git(repo, "rev-parse", "HEAD");
}

describe("contentDiff and the CLI", () => {
  test("undefined when git cannot compare the commits, as changedFiles is", async () => {
    const dir = await mkdtemp(join(tmpdir(), "version-bump-"));
    try {
      git(dir, "init", "--initial-branch=main", ".");
      const a = await commit(dir, { x: "1" });
      expect(contentDiff(a, dir)("f".repeat(40))).toBeUndefined();
      expect(contentDiff(a, dir)("not-a-sha")).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("the CLI lists what the planner keeps and what it sets aside", async () => {
    const dir = await mkdtemp(join(tmpdir(), "version-bump-"));
    try {
      git(dir, "init", "--initial-branch=main", ".");
      await commit(dir, released());
      const m = await commit(dir, merge());
      await commit(dir, versionPackages());
      const v2 = await commit(dir, versionLockfile());
      const proc = Bun.spawnSync(["bun", join(ROOT, "scripts/version-bump.ts"), m, v2], {
        cwd: dir,
        env: { ...process.env, ...GIT_ENV },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode).toBe(0);
      const out = proc.stdout.toString();
      expect(out).toContain("kept, for the surface map to judge (2):\n");
      expect(out).toContain("  .changeset/shared-button-press.md\n");
      expect(out).toContain("  scripts/lint-warning-ceiling.txt\n");
      expect(out).toContain("set aside, a release's version bump (9):\n");
      expect(out).toContain("  bun.lock\n");
      expect(out).toContain("  shared/ui/package.json\n");
      expect(out).toContain("  musubi/infra/CHANGELOG.md\n");
      const bad = Bun.spawnSync(
        ["bun", join(ROOT, "scripts/version-bump.ts"), "f".repeat(40), v2],
        {
          cwd: dir,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      expect(bad.exitCode).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── what the rule rests on ──────────────────────────────────────────────────

// Setting a version bump aside is safe only while no surface is built from a
// package's version or changelog. A file any surface, stack or shared path
// counts that reads a package.json, an npm_package_* variable or a CHANGELOG,
// or a deploy that sets the service version, makes a version bump content:
// change scripts/version-bump.ts before adding one here.
describe("no surface is built from a package version or a changelog", () => {
  const READS = [
    { what: "a package.json", pattern: /["'][^"'\n]*package\.json["']/ },
    { what: "an npm_package_ variable", pattern: /npm_package_/ },
    { what: "a CHANGELOG", pattern: /["'][^"'\n]*CHANGELOG[^"'\n]*["']/ },
  ];
  /** Each file allowed a read, and what it reads. */
  const ALLOWED: ReadonlyMap<string, string> = new Map([
    // The local devloop's launcher reads the app's `name`, never its version,
    // and no build runs it.
    ["shared/dev-urls/src/cli.ts", "a package.json"],
  ]);

  const tracked = git(ROOT, "ls-files", "-z").split("\0");
  const counted = (file: string) =>
    SURFACES.some((s) => s.paths.test(file)) ||
    STACKS.some((s) => s.paths.test(file)) ||
    sharedPath(file, "production");

  test("no file a surface or stack builds from reads one", async () => {
    const source = tracked.filter(
      (file) =>
        counted(file) &&
        /\.(ts|tsx|js|jsx|mjs|cjs|astro|toml|jsonc)$/.test(file) &&
        !/(^|\/)tests?\//.test(file),
    );
    expect(source.length).toBeGreaterThan(500);
    const found: string[] = [];
    for (const file of source) {
      const text = await readFile(join(ROOT, file), "utf8");
      for (const { what, pattern } of READS) {
        if (pattern.test(text) && ALLOWED.get(file) !== what) found.push(`${file}: ${what}`);
      }
    }
    expect(found).toEqual([]);
  });

  test("nothing sets the service version a trace reports", async () => {
    const setters = tracked.filter(
      (file) =>
        /\.(ts|tsx|js|mjs|toml|jsonc|ya?ml|json)$/.test(file) &&
        !file.startsWith("shared/observability/") &&
        !file.startsWith("scripts/tests/"),
    );
    const found: string[] = [];
    for (const file of setters) {
      if ((await readFile(join(ROOT, file), "utf8")).includes("OSN_SERVICE_VERSION"))
        found.push(file);
    }
    expect(found).toEqual([]);
  });
});
