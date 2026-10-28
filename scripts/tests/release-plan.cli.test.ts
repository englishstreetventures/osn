// Runs scripts/release-plan.ts the way production-release.yml's `plan` job
// does: a real process, a real git checkout, and GitHub's API served over
// HTTP by the fake in ./fake-github. The job's products are the lines it
// appends to $GITHUB_OUTPUT and $GITHUB_STEP_SUMMARY, and its exit code — a
// plan that failed but exited 0 would skip every deploy with nothing red.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { dev, fakeGitHub, type FakeGitHub, fullRun, REPO, TOKEN } from "./fake-github";

const SCRIPT = new URL("../release-plan.ts", import.meta.url).pathname;
const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

let github: FakeGitHub = fakeGitHub([]);
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({ port: 0, fetch: (request) => github.fetch(request) });
});

afterAll(async () => {
  await server.stop(true);
});

async function run(command: string[], cwd: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...GIT_ENV, GITHUB_OUTPUT: "", GITHUB_STEP_SUMMARY: "", ...env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { exitCode, stdout, stderr } = await run(
    ["git", "-c", "user.email=t@example.com", "-c", "user.name=T", ...args],
    cwd,
  );
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${stderr}`);
  return stdout.trim();
}

async function commit(repo: string, files: Record<string, string>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "change");
  return git(repo, "rev-parse", "HEAD");
}

async function withRepo(
  body: (repo: string, files: { output: string; summary: string }) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "release-plan-cli-"));
  try {
    const repo = join(dir, "repo");
    await mkdir(repo);
    await git(repo, "init", "--initial-branch=main", ".");
    await body(repo, { output: join(dir, "output"), summary: join(dir, "summary") });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const planEnv = (head: string, extra: Record<string, string> = {}) => ({
  GITHUB_SHA: head,
  GITHUB_REPOSITORY: REPO,
  GITHUB_TOKEN: TOKEN,
  GITHUB_API_URL: server.url.origin,
  GITHUB_SERVER_URL: "https://github.com",
  SURFACES: "",
  FORCE: "false",
  ...extra,
});

const readOr = async (path: string) => readFile(path, "utf8").catch(() => "");

test("writes one output per surface and the plan summary, and exits 0", async () => {
  await withRepo(async (repo, files) => {
    const a = await commit(repo, { "osn/api/src/index.ts": "1", "cire/host/src/App.tsx": "1" });
    const b = await commit(repo, { "osn/api/src/index.ts": "2" });
    github = fakeGitHub([
      ...fullRun("production", a, 1),
      { environment: "dev", sha: b, run: 2, job: dev("osn_api"), states: ["success"] },
      ...fullRun("dev", a, 1),
    ]);

    const { exitCode, stdout } = await run(["bun", "run", SCRIPT], repo, {
      ...planEnv(b),
      GITHUB_OUTPUT: files.output,
      GITHUB_STEP_SUMMARY: files.summary,
    });

    expect(exitCode).toBe(0);
    const output = await readFile(files.output, "utf8");
    expect(output).toContain("osn_api=true\n");
    expect(output).toContain("cire_host=false\n");
    expect(output).toContain("any=true\n");
    const summary = await readFile(files.summary, "utf8");
    expect(summary).toContain(`### Production release of [\`${b.slice(0, 7)}\`]`);
    expect(summary).toContain("osn/api/src/index.ts changed");
    expect(stdout).toContain("Ships `osn_api`");
  });
});

test("with no $GITHUB_OUTPUT the outputs go to stdout", async () => {
  await withRepo(async (repo) => {
    const a = await commit(repo, { "osn/api/src/index.ts": "1" });
    github = fakeGitHub([...fullRun("production", a, 1)]);

    const { exitCode, stdout } = await run(["bun", "run", SCRIPT], repo, planEnv(a));

    expect(exitCode).toBe(0);
    expect(stdout).toContain("osn_api=false\n");
    expect(stdout).toContain("any=false\n");
  });
});

test("an API error fails the step with an annotation and writes no outputs", async () => {
  await withRepo(async (repo, files) => {
    const a = await commit(repo, { "osn/api/src/index.ts": "1" });
    github = fakeGitHub([...fullRun("production", a, 1)]);

    const { exitCode, stderr } = await run(["bun", "run", SCRIPT], repo, {
      ...planEnv(a, { GITHUB_TOKEN: "wrong" }),
      GITHUB_OUTPUT: files.output,
      GITHUB_STEP_SUMMARY: files.summary,
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("::error::release-plan: GitHub API answered 401");
    expect(await readOr(files.output)).toBe("");
    expect(await readOr(files.summary)).toBe("");
  });
});

test("a bad dispatch input fails the step before any API call", async () => {
  await withRepo(async (repo, files) => {
    const a = await commit(repo, { "osn/api/src/index.ts": "1" });
    github = fakeGitHub([]);

    const { exitCode, stderr } = await run(["bun", "run", SCRIPT], repo, {
      ...planEnv(a, { SURFACES: "cire-api" }),
      GITHUB_OUTPUT: files.output,
    });

    expect(exitCode).toBe(1);
    expect(stderr).toContain("::error::release-plan: SURFACES names cire-api");
    expect(github.calls).toHaveLength(0);
    expect(await readOr(files.output)).toBe("");
  });
});
