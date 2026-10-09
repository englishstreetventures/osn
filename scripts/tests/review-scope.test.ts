import { expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { changeClass, classifyPath, parseRawZ, reviewScope } from "../review-scope";

// --- what each path is --------------------------------------------------------

test("Markdown outside the exclusions is a doc", () => {
  expect(classifyPath("wiki/conventions/session-metrics.md")).toBe("doc");
  expect(classifyPath("README.md")).toBe("doc");
  expect(classifyPath("tools/pr-metrics/README.md")).toBe("doc");
  expect(classifyPath(".changeset/quiet-owls-sing.md")).toBe("doc");
  expect(classifyPath("docs/superpowers/plans/plan.md")).toBe("doc");
});

// MDX carries components and script, so it is source, not prose.
test("only plain Markdown counts as a doc, wherever it sits", () => {
  expect(classifyPath("docs/page.mdx")).toBe("other");
  expect(classifyPath("wiki/assets/diagram.svg")).toBe("other");
  expect(classifyPath("docs/plugin.js")).toBe("other");
});

test("test code and snapshots under tests/, or named .test./.spec., are tests", () => {
  expect(classifyPath("tools/pr-metrics/tests/backfill.test.ts")).toBe("test");
  expect(classifyPath("scripts/tests/changeset-required.test.sh")).toBe("test");
  expect(classifyPath("osn/api/tests/helpers/db.ts")).toBe("test");
  expect(classifyPath("tools/lab/widget.spec.tsx")).toBe("test");
  expect(classifyPath("shared/ui/tests/__snapshots__/button.test.tsx.snap")).toBe("test");
  expect(classifyPath("scripts/tests/fixture.mjs")).toBe("test");
});

// A fixture or config file under tests/ can be read by a build or a workflow
// as easily as by a test.
test("a tests/ file that is not test code is not a test", () => {
  expect(classifyPath("osn/api/tests/fixtures/user.json")).toBe("other");
  expect(classifyPath("cire/api/tests/wrangler.toml")).toBe("other");
  expect(classifyPath("tests/fixtures/payload.yml")).toBe("other");
});

// Each exclusion beats every class it could otherwise fall into.
test("nothing under a src/ directory qualifies, tests and Markdown included", () => {
  expect(classifyPath("osn/api/src/routes/auth.ts")).toBe("other");
  expect(classifyPath("cire/api/src/lib/claim.test.ts")).toBe("other");
  expect(classifyPath("pulse/web/src/README.md")).toBe("other");
  expect(classifyPath("src/notes.md")).toBe("other");
});

test("nothing under .github/ qualifies, Markdown included", () => {
  expect(classifyPath(".github/workflows/ci.yml")).toBe("other");
  expect(classifyPath(".github/workflows/README.md")).toBe("other");
  expect(classifyPath(".github/pull_request_template.md")).toBe("other");
  expect(classifyPath(".github/CODEOWNERS")).toBe("other");
});

test("no package.json and no lockfile qualifies, wherever it sits", () => {
  expect(classifyPath("package.json")).toBe("other");
  expect(classifyPath("osn/api/tests/package.json")).toBe("other");
  expect(classifyPath("bun.lock")).toBe("other");
  expect(classifyPath("skills-lock.json")).toBe("other");
});

// Agent instructions decide what an agent may do — a SKILL.md can widen its
// `allowed-tools`, and the review skills and prep-pr define this gate — so
// none of them is prose.
test("agent instructions are never trivial, whatever their extension", () => {
  expect(classifyPath("AGENTS.md")).toBe("other");
  expect(classifyPath("CLAUDE.md")).toBe("other");
  expect(classifyPath("osn/api/AGENTS.md")).toBe("other");
  expect(classifyPath("cire/CLAUDE.local.md")).toBe("other");
  // macOS reads `claude.md` as `CLAUDE.md`.
  expect(classifyPath("pulse/claude.md")).toBe("other");
  expect(classifyPath(".claude/skills/prep-pr/SKILL.md")).toBe("other");
  expect(classifyPath(".claude/skills/review-security/SKILL.md")).toBe("other");
  expect(classifyPath(".claude/agents/reviewer.md")).toBe("other");
  expect(classifyPath(".claude/evals/prep-pr-finding-routing/task.md")).toBe("other");
  expect(classifyPath(".claude/metrics/chore-x.json")).toBe("other");
  expect(classifyPath(".agents/skills/webgpu-threejs-tsl/SKILL.md")).toBe("other");
  expect(classifyPath("tools/lab/.claude/settings.json")).toBe("other");
});

test("an environment file is never trivial, under any name", () => {
  expect(classifyPath(".env")).toBe("other");
  expect(classifyPath("cire/api/.env.example.md")).toBe("other");
  expect(classifyPath("osn/api/tests/.env.test.ts")).toBe("other");
});

test("config, hooks and scripts are not trivial", () => {
  expect(classifyPath("lefthook.yml")).toBe("other");
  expect(classifyPath("scripts/review-scope.ts")).toBe("other");
});

// `git diff --name-only` without `-z` wraps a path holding a quote, a
// backslash or a byte outside ASCII in double quotes and escapes it.
test("a quoted path is never trivial", () => {
  expect(classifyPath('"wiki/caf\\303\\251.md"')).toBe("other");
  expect(classifyPath('"wiki/a\\"b.md"')).toBe("other");
  // The closing quote would otherwise pass for part of a test file's extension.
  expect(classifyPath('"tests/caf\\303\\251.test.ts"')).toBe("other");
});

test("a path that climbs out or names itself is never trivial", () => {
  expect(classifyPath("../wiki/x.md")).toBe("other");
  expect(classifyPath("wiki/../osn/api/x.md")).toBe("other");
  expect(classifyPath("/wiki/x.md")).toBe("other");
  expect(classifyPath("./wiki/x.md")).toBe("other");
});

// --- what each change is ------------------------------------------------------

test("a symlink, a submodule or a mode change is never trivial", () => {
  expect(changeClass({ path: "wiki/a.md", modes: ["000000", "120000"] })).toBe("other");
  expect(changeClass({ path: "wiki/a.md", modes: ["120000", "100644"] })).toBe("other");
  expect(changeClass({ path: "docs/vendor.md", modes: ["000000", "160000"] })).toBe("other");
  expect(changeClass({ path: "scripts/tests/run.test.sh", modes: ["100644", "100755"] })).toBe(
    "other",
  );
  expect(changeClass({ path: "wiki/a.md", modes: [], symlink: true })).toBe("other");
});

test("an added, edited or deleted regular file takes its path's class", () => {
  expect(changeClass({ path: "wiki/a.md", modes: ["000000", "100644"] })).toBe("doc");
  expect(changeClass({ path: "wiki/a.md", modes: ["100644", "100644"] })).toBe("doc");
  expect(changeClass({ path: "wiki/a.md", modes: ["100644", "000000"] })).toBe("doc");
  expect(changeClass({ path: "wiki/a.md", modes: [] })).toBe("doc");
});

test("parseRawZ reads `git diff --raw -z --no-renames` output", () => {
  const output = [
    ":000000 100644 0000000 1234567 A",
    "wiki/new.md",
    ":100644 120000 89abcde 7654321 T",
    "wiki/link.md",
    ":100644 100644 1111111 2222222 M",
    "wiki/line\nbreak.md",
    "",
  ].join("\0");

  expect(parseRawZ(output)).toEqual([
    { path: "wiki/new.md", modes: ["000000", "100644"] },
    { path: "wiki/link.md", modes: ["100644", "120000"] },
    { path: "wiki/line\nbreak.md", modes: ["100644", "100644"] },
  ]);
  expect(parseRawZ("")).toEqual([]);
});

// --- the verdict --------------------------------------------------------------

const file = (path: string) => ({ path, modes: ["100644", "100644"] });

test("docs alone are trivial", () => {
  expect(reviewScope([file("wiki/a.md"), file("README.md")])).toBe("trivial");
});

test("a test among docs keeps review-tests", () => {
  expect(reviewScope([file("wiki/a.md"), file("scripts/tests/x.test.ts")])).toBe("trivial-tests");
  expect(reviewScope([file("tools/pr-metrics/tests/x.test.ts")])).toBe("trivial-tests");
});

test("one change outside the list makes the whole diff full", () => {
  expect(reviewScope([file("wiki/a.md"), file(".claude/skills/prep-pr/SKILL.md")])).toBe("full");
  expect(reviewScope([file("wiki/a.md"), { path: "wiki/b.md", modes: ["000000", "120000"] }])).toBe(
    "full",
  );
});

// An empty list means the wrong range was diffed, never that nothing changed.
test("an empty list is full", () => {
  expect(reviewScope([])).toBe("full");
});

// --- the command, in a real repository ----------------------------------------

const SCRIPT = new URL("../review-scope.ts", import.meta.url).pathname;

async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "review-scope-"));
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-c", "commit.gpgsign=false", ...args], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    });

  git("init", "-q", "-b", "main");
  await mkdir(join(dir, "wiki"));
  await writeFile(join(dir, "wiki", "a.md"), "# a\n");
  await writeFile(join(dir, "run.sh"), "echo\n");
  git("add", ".");
  git("commit", "-qm", "seed");
  git("checkout", "-qb", "work");

  return { dir, git };
}

async function scope(dir: string, args: string[] = ["main"]) {
  const proc = Bun.spawn(["bun", "run", SCRIPT, ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, exitCode };
}

test("the command sizes committed, uncommitted and untracked work together", async () => {
  const { dir, git } = await repo();
  try {
    await writeFile(join(dir, "wiki", "a.md"), "# a, edited\n");
    git("commit", "-qam", "doc");
    expect(await scope(dir)).toEqual({ stdout: "trivial\n", stderr: "", exitCode: 0 });

    // Uncommitted test code joins the committed doc change.
    await mkdir(join(dir, "tests"));
    await writeFile(join(dir, "tests", "a.test.ts"), "export {};\n");
    expect((await scope(dir)).stdout).toBe("trivial-tests\n");

    // And an untracked source file outweighs both.
    await writeFile(join(dir, "app.ts"), "export {};\n");
    expect((await scope(dir)).stdout).toBe("full\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the command finds a committed symlink with a Markdown name", async () => {
  const { dir, git } = await repo();
  try {
    await symlink("../run.sh", join(dir, "wiki", "link.md"));
    git("add", ".");
    git("commit", "-qm", "link");

    expect((await scope(dir)).stdout).toBe("full\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the command finds an untracked symlink with a Markdown name", async () => {
  const { dir } = await repo();
  try {
    await symlink("../run.sh", join(dir, "wiki", "link.md"));

    expect((await scope(dir)).stdout).toBe("full\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the command finds a file made executable", async () => {
  const { dir, git } = await repo();
  try {
    await chmod(join(dir, "wiki", "a.md"), 0o755);
    git("commit", "-qam", "mode");

    expect((await scope(dir)).stdout).toBe("full\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Without `-z` git would print this name quoted; with it, the name arrives
// whole and is judged as it is.
test("the command reads a path with a quote and a newline whole", async () => {
  const { dir, git } = await repo();
  try {
    await writeFile(join(dir, "wiki", 'say "hi"\nthere.md'), "# hi\n");
    git("add", ".");
    git("commit", "-qm", "odd name");

    expect((await scope(dir)).stdout).toBe("trivial\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the command refuses to run without a base", async () => {
  const { dir } = await repo();
  try {
    const run = await scope(dir, []);

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("base");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the command fails rather than answering when git cannot diff", async () => {
  const { dir } = await repo();
  try {
    const run = await scope(dir, ["no-such-ref"]);

    expect(run.exitCode).toBe(1);
    expect(run.stdout).toBe("");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
