// Runs scripts/deploy-surfaces.ts the way deploy.yml's `changes` job does, in
// real git repositories: a push diff, a dispatch, and a base git cannot diff
// against. The step's only product is the lines it appends to $GITHUB_OUTPUT,
// so that file is what these read.

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { changedFiles } from "../deploy-surfaces";

const SCRIPT = new URL("../deploy-surfaces.ts", import.meta.url).pathname;
const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

async function run(command: string[], cwd: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...GIT_ENV, GITHUB_OUTPUT: "", ...env },
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

/** Write `files`, commit them, and return the new commit's SHA. */
async function commit(repo: string, files: Record<string, string>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  await git(repo, "add", "-A");
  await git(repo, "commit", "-m", "change");
  return git(repo, "rev-parse", "HEAD");
}

async function withRepo(body: (repo: string, output: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "deploy-surfaces-cli-"));
  try {
    const repo = join(dir, "repo");
    await mkdir(repo);
    await git(repo, "init", "--initial-branch=main", ".");
    await body(repo, join(dir, "github-output"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function parseOutput(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => line.split("=") as [string, string]),
  );
}

const DEV_KEYS = [
  "cire_api",
  "cire_invites",
  "cire_host",
  "cire_vendor",
  "cire_landing",
  "osn_api",
  "osn_social",
];

test("a push deploys the dev surfaces its diff touches, and writes only dev keys", async () => {
  await withRepo(async (repo, output) => {
    const before = await commit(repo, {
      "cire/api/src/a.ts": "1",
      "cire/landing/src/a.astro": "1",
    });
    await commit(repo, { "cire/landing/src/a.astro": "2", "zap/api/src/a.ts": "1" });

    const { exitCode, stdout } = await run(
      ["bun", "run", SCRIPT, "--event", "push", "--base", before],
      repo,
      { GITHUB_OUTPUT: output },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("cire/landing/src/a.astro");
    const written = parseOutput(await readFile(output, "utf8"));
    expect(Object.keys(written)).toEqual(DEV_KEYS);
    expect(written.cire_landing).toBe("true");
    expect(written.cire_api).toBe("false");
    expect(written.zap_api).toBeUndefined();
  });
});

test("a dispatch deploys every dev surface without diffing", async () => {
  await withRepo(async (repo, output) => {
    await commit(repo, { "README.md": "1" });

    const { exitCode } = await run(["bun", "run", SCRIPT, "--event", "workflow_dispatch"], repo, {
      GITHUB_OUTPUT: output,
    });

    expect(exitCode).toBe(0);
    const written = parseOutput(await readFile(output, "utf8"));
    expect(Object.values(written)).toEqual(DEV_KEYS.map(() => "true"));
  });
});

test("a push whose base cannot be diffed deploys every dev surface", async () => {
  await withRepo(async (repo, output) => {
    await commit(repo, { "README.md": "1" });

    const { exitCode, stdout } = await run(
      [
        "bun",
        "run",
        SCRIPT,
        "--event",
        "push",
        "--base",
        "0000000000000000000000000000000000000000",
      ],
      repo,
      { GITHUB_OUTPUT: output },
    );

    expect(exitCode).toBe(0);
    expect(stdout).toContain("cannot diff");
    const written = parseOutput(await readFile(output, "utf8"));
    expect(Object.values(written)).toEqual(DEV_KEYS.map(() => "true"));
  });
});

test("with no $GITHUB_OUTPUT the lines go to stdout", async () => {
  await withRepo(async (repo) => {
    await commit(repo, { "README.md": "1" });
    const { exitCode, stdout } = await run(
      ["bun", "run", SCRIPT, "--event", "workflow_dispatch"],
      repo,
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("cire_api=true\n");
  });
});

test("a push with no --base is refused", async () => {
  await withRepo(async (repo) => {
    await commit(repo, { "README.md": "1" });
    const { exitCode, stderr } = await run(["bun", "run", SCRIPT, "--event", "push"], repo);
    expect(exitCode).toBe(2);
    expect(stderr).toContain("--base is required");
  });
});

test("changedFiles compares trees, in either direction", async () => {
  await withRepo(async (repo) => {
    const a = await commit(repo, { "x/a.ts": "1" });
    const b = await commit(repo, { "y/b.ts": "1" });
    expect(changedFiles(a, b, repo)).toEqual(["y/b.ts"]);
    expect(changedFiles(b, a, repo)).toEqual(["y/b.ts"]);
    expect(changedFiles(b, b, repo)).toEqual([]);
  });
});

test("changedFiles refuses a revision git could read as an option", async () => {
  await withRepo(async (repo) => {
    const a = await commit(repo, { "x/a.ts": "1" });
    expect(changedFiles("--output=/tmp/x", a, repo)).toBeUndefined();
    expect(changedFiles(a, "--stat", repo)).toBeUndefined();
  });
});
