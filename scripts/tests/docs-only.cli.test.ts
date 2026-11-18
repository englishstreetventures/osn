// scripts/docs-only.sh decides whether CI may skip its build, test and E2E
// jobs for a change. A wrong `true` lets code reach main with those jobs never
// run and the `CI` check green; a wrong `false` only costs time. So every case
// that must run the jobs is here, one per way a path could slip through, and
// the cases that may skip are the few the classifier allows.

import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "..", "docs-only.sh");

async function classify(
  stdin: string | "terminal" | "devnull",
): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }> {
  const proc = Bun.spawn(["bash", SCRIPT], {
    stdin:
      stdin === "devnull"
        ? "ignore"
        : stdin === "terminal"
          ? "inherit"
          : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout: stdout.trim(), stderr };
}

const verdict = async (paths: readonly string[]): Promise<string> => {
  const { exitCode, stdout, stderr } = await classify(`${paths.join("\n")}\n`);
  expect(exitCode, stderr).toBe(0);
  return stdout;
};

describe("docs-only.sh", () => {
  test.each([
    ["the wiki alone, any file in it", ["wiki/index.md", "wiki/osn/sessions.md", "wiki/a.canvas"]],
    ["docs/ alone", ["docs/superpowers/plans/2026-10-16-plan.md"]],
    [
      "a README, CHANGELOG or DESIGN.md at the root or a package's root",
      ["README.md", "osn/api/README.md", "cire/host/DESIGN.md", "shared/ui/CHANGELOG.md"],
    ],
    ["a changeset with the prose it describes", [".changeset/a-change.md", "pulse/api/README.md"]],
  ])("%s: true", async (_, paths) => {
    expect(await verdict(paths)).toBe("true");
  });

  test.each([
    ["one source file among prose", ["wiki/index.md", "osn/api/src/index.ts"]],
    ["a package manifest", ["wiki/index.md", "osn/api/package.json"]],
    ["the lockfile", ["bun.lock"]],
    ["a workflow", [".github/workflows/ci.yml"]],
    ["a root config file", ["turbo.json"]],
    ["a path that only starts like wiki/", ["wikilinks.ts"]],
    ["a directory that only starts like docs/", ["docs-site/index.ts"]],
  ])("%s: false", async (_, paths) => {
    expect(await verdict(paths)).toBe("false");
  });

  // Markdown that code reads: agent instructions the script tests check, the
  // E2E suite's and the scripts' own trees, workflow templates, and any
  // markdown a package keeps beside its source or tests.
  test.each([
    ["AGENTS.md", ["AGENTS.md"]],
    ["CLAUDE.md", ["CLAUDE.md"]],
    ["a skill", [".claude/skills/prep-pr/SKILL.md"]],
    ["an agent definition", [".claude/agents/reviewer.md"]],
    ["a third-party skill", [".agents/skills/x/SKILL.md"]],
    ["a GitHub template", [".github/ISSUE_TEMPLATE/bug.md"]],
    ["markdown under scripts/", ["scripts/README.md"]],
    ["markdown under tools/", ["tools/e2e/README.md"]],
    ["markdown under a src/ directory", ["cire/landing/src/content/post.md"]],
    ["markdown under a tests/ directory", ["osn/api/tests/fixtures/mail.md"]],
  ])("markdown code may read, %s: false", async (_, paths) => {
    expect(await verdict(paths)).toBe("false");
  });

  // No paths is no evidence that the change is prose.
  test.each([
    ["no paths", []],
    ["blank lines only", ["", "  "]],
  ])("%s: false", async (_, paths) => {
    expect(await verdict(paths)).toBe("false");
  });

  // `git diff --name-only` never prints these, but a path that leaves the
  // directory it names says nothing about where the file is.
  test.each([
    ["a .. escape", ["wiki/../bun.lock"]],
    ["an absolute path", ["/wiki/index.md"]],
    ["a ./ segment", ["./README.md"]],
    ["a trailing ..", ["wiki/.."]],
  ])("%s: false", async (_, paths) => {
    expect(await verdict(paths)).toBe("false");
  });

  // Nothing piped would otherwise read as no paths, and print an answer.
  test("nothing piped in: exit 1 and no answer", async () => {
    const { exitCode, stdout } = await classify("devnull");
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
  });
});
