import { expect, test } from "bun:test";

import { classifyPath, reviewScope } from "../review-scope";

test("Markdown anywhere outside a src/ directory is a doc", () => {
  expect(classifyPath("wiki/conventions/session-metrics.md")).toBe("doc");
  expect(classifyPath("AGENTS.md")).toBe("doc");
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

test("Markdown under .claude/skills/ is a skill", () => {
  expect(classifyPath(".claude/skills/prep-pr/SKILL.md")).toBe("skill");
  expect(classifyPath(".claude/skills/prep-pr/references/workflow-steps.md")).toBe("skill");
});

// A script under a skill runs, and `.claude/skills/webgpu-threejs-tsl` is a
// tracked symlink into `.agents/`; `git diff --name-only` cannot tell either
// from text, so only Markdown qualifies.
test("a script or a symlink under .claude/skills/ is not trivial", () => {
  expect(classifyPath(".claude/skills/prep-pr/scripts/run.sh")).toBe("other");
  expect(classifyPath(".claude/skills/webgpu-threejs-tsl")).toBe("other");
});

test("a tests/ directory or a .test./.spec. name is a test", () => {
  expect(classifyPath("tools/pr-metrics/tests/backfill.test.ts")).toBe("test");
  expect(classifyPath("scripts/tests/changeset-required.test.sh")).toBe("test");
  expect(classifyPath("osn/api/tests/fixtures/user.json")).toBe("test");
  expect(classifyPath("tools/lab/widget.spec.ts")).toBe("test");
});

// Each exclusion beats every class it could otherwise fall into.
test("nothing under a src/ directory qualifies, tests and Markdown included", () => {
  expect(classifyPath("osn/api/src/routes/auth.ts")).toBe("other");
  expect(classifyPath("cire/api/src/lib/claim.test.ts")).toBe("other");
  expect(classifyPath("pulse/web/src/README.md")).toBe("other");
  expect(classifyPath("src/notes.md")).toBe("other");
});

test("nothing under .github/workflows/ qualifies, Markdown included", () => {
  expect(classifyPath(".github/workflows/ci.yml")).toBe("other");
  expect(classifyPath(".github/workflows/README.md")).toBe("other");
});

test("no package.json and no lockfile qualifies, wherever it sits", () => {
  expect(classifyPath("package.json")).toBe("other");
  expect(classifyPath("osn/api/tests/fixtures/package.json")).toBe("other");
  expect(classifyPath(".claude/skills/prep-pr/package.json")).toBe("other");
  expect(classifyPath("bun.lock")).toBe("other");
  expect(classifyPath("skills-lock.json")).toBe("other");
});

// Third-party skill text is installed from outside the repository; its own
// Markdown is not this repository's prose.
test("third-party skills under .agents/ are not trivial, Markdown included", () => {
  expect(classifyPath(".agents/skills/webgpu-threejs-tsl/SKILL.md")).toBe("other");
});

// Agent definitions set each agent's tools and model, and session-metrics cards
// are public records with their own rules about what may reach them.
test("agent definitions and session-metrics cards are not trivial", () => {
  expect(classifyPath(".claude/agents/reviewer.md")).toBe("other");
  expect(classifyPath(".claude/metrics/chore-x.json")).toBe("other");
});

test("config, hooks and scripts are not trivial", () => {
  expect(classifyPath("lefthook.yml")).toBe("other");
  expect(classifyPath(".claude/settings.json")).toBe("other");
  expect(classifyPath("scripts/review-scope.ts")).toBe("other");
  expect(classifyPath(".claude/evals/prep-pr-finding-routing/setup.sh")).toBe("other");
});

test("a path that climbs out or names itself is never trivial", () => {
  expect(classifyPath("../wiki/x.md")).toBe("other");
  expect(classifyPath("wiki/../osn/api/x.md")).toBe("other");
  expect(classifyPath("/wiki/x.md")).toBe("other");
  expect(classifyPath("./wiki/x.md")).toBe("other");
});

test("docs and skills alone are trivial", () => {
  expect(reviewScope(["wiki/a.md", ".claude/skills/prep-pr/SKILL.md"])).toBe("trivial");
});

test("a test among docs and skills keeps review-tests", () => {
  expect(reviewScope(["wiki/a.md", "scripts/tests/x.test.ts"])).toBe("trivial-tests");
  expect(reviewScope(["tools/pr-metrics/tests/x.test.ts"])).toBe("trivial-tests");
});

test("one path outside the list makes the whole diff full", () => {
  expect(reviewScope(["wiki/a.md", "scripts/tests/x.test.ts", "osn/api/src/a.ts"])).toBe("full");
});

// An empty list means the wrong range was diffed, never that nothing changed.
test("an empty list is full", () => {
  expect(reviewScope([])).toBe("full");
  expect(reviewScope(["", "  "])).toBe("full");
});

const SCRIPT = new URL("../review-scope.ts", import.meta.url).pathname;

async function runCli(stdin: string): Promise<{ exitCode: number; stdout: string }> {
  const proc = Bun.spawn(["bun", "run", SCRIPT], {
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  return { exitCode, stdout };
}

test("the CLI prints one word for the list on stdin", async () => {
  expect(await runCli("wiki/a.md\n.claude/skills/x/SKILL.md\n")).toEqual({
    exitCode: 0,
    stdout: "trivial\n",
  });
  expect(await runCli("wiki/a.md\nscripts/tests/a.test.ts")).toEqual({
    exitCode: 0,
    stdout: "trivial-tests\n",
  });
  expect(await runCli("wiki/a.md\nosn/api/src/a.ts\n")).toEqual({ exitCode: 0, stdout: "full\n" });
  expect(await runCli("")).toEqual({ exitCode: 0, stdout: "full\n" });
});
