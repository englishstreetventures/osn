/**
 * The `dev-env` launcher's process contract.
 *
 * `app-env.test.ts` covers what it exports; this covers what it *is* — a
 * process that turbo and portless supervise. Both care about exit status:
 * portless deregisters the route when its child exits, and turbo reports the
 * status as the task result. Since the launcher `execve`s, the dev server keeps
 * the pid and those statuses come from the kernel rather than from code here —
 * which is exactly the thing worth pinning, because a regression to a
 * supervising wrapper would go unnoticed until Ctrl-C started orphaning dev
 * servers that hold portless's ports.
 *
 * Every case runs the real bin against a temporary package directory, so
 * nothing here depends on a dev server or a running proxy.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

const CLI = resolve(import.meta.dirname, "../src/cli.ts");

const fixtures: string[] = [];

/** A directory whose `package.json` names `pkg`, which is all `resolveSelfId` reads. */
function fixture(pkg: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "dev-env-"));
  fixtures.push(dir);
  if (pkg !== null) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: pkg }));
  }
  return dir;
}

afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

interface Run {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

async function run(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
): Promise<Run> {
  const child = Bun.spawn(["bun", CLI, ...args], {
    cwd: options.cwd ?? fixture("@cire/host"),
    // A bare env: the parent's PORTLESS_URL (if this suite ever runs inside the
    // devloop) must not leak in and turn a no-portless case into a portless one.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  return { exitCode: child.exitCode, signal: child.signalCode, stdout, stderr };
}

const PORTLESS = { PORTLESS_URL: "https://my-branch.host.cire.localhost" };

describe("dev-env exit status", () => {
  it("exits 64 with a usage line when given no command", async () => {
    const result = await run([]);
    expect(result.exitCode).toBe(64);
    expect(result.stderr).toContain("usage: dev-env");
  });

  it("exits 78 naming where to register a package it does not know", async () => {
    const result = await run(["true"], { cwd: fixture("@osn/nope") });
    expect(result.exitCode).toBe(78);
    expect(result.stderr).toContain("not in DEV_APPS");
    // The message has to say where to add it, or it is just a rejection.
    expect(result.stderr).toContain("portless");
  });

  it("exits 78 rather than throwing when there is no package.json at all", async () => {
    const result = await run(["true"], { cwd: fixture(null) });
    expect(result.exitCode).toBe(78);
    expect(result.stderr).not.toContain("at Object.");
  });

  it("exits 127 when the command does not exist", async () => {
    const result = await run(["definitely-not-a-real-binary-xyz"]);
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain("not found");
  });

  it("passes the command's own exit code through", async () => {
    const result = await run(["sh", "-c", "exit 3"]);
    expect(result.exitCode).toBe(3);
  });

  it("reports a signalled command as the signal, not as a clean exit", async () => {
    // The launcher exec'd, so this is the kernel reporting the dev server's own
    // death — 143 is 128+SIGTERM, what a shell would report.
    const result = await run(["sh", "-c", "kill -TERM $$"]);
    expect(result.exitCode === 143 || result.signal === "SIGTERM").toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  it("exits 0 when the command succeeds", async () => {
    const result = await run(["sh", "-c", "exit 0"]);
    expect(result.exitCode).toBe(0);
  });
});

describe("dev-env exit status without execve", () => {
  // `process.execve` arrived in Bun 1.3.14 and does not exist on Windows.
  // `.bun-version` pins 1.4.0, so the exec path is what normally runs — but the
  // fallback has to honour the same contract, or a Windows machine or an older
  // Bun gets a devloop that behaves differently, which is exactly the kind of
  // split nobody notices until it matters.
  const NO_EXECVE = { DEV_ENV_NO_EXECVE: "1" };

  it("passes the command's own exit code through", async () => {
    const result = await run(["sh", "-c", "exit 3"], { env: NO_EXECVE });
    expect(result.exitCode).toBe(3);
  });

  it("reports a signalled command as 128 + the signal", async () => {
    const result = await run(["sh", "-c", "kill -TERM $$"], { env: NO_EXECVE });
    expect(result.exitCode).toBe(143);
  });

  it("exits 0 when the command succeeds", async () => {
    const result = await run(["sh", "-c", "exit 0"], { env: NO_EXECVE });
    expect(result.exitCode).toBe(0);
  });

  it("still hands the derived origins to the command", async () => {
    const result = await run(["sh", "-c", "echo $PUBLIC_CIRE_API_URL"], {
      env: { ...NO_EXECVE, ...PORTLESS },
    });
    expect(result.stdout.trim()).toBe("https://my-branch.api.cire.localhost");
  });
});

describe("dev-env environment", () => {
  it("hands the derived origins to the command", async () => {
    const result = await run(["sh", "-c", "echo $PUBLIC_CIRE_API_URL,$PUBLIC_OSN_ACCOUNT_URL"], {
      env: PORTLESS,
    });
    expect(result.stdout.trim()).toBe(
      "https://my-branch.api.cire.localhost,https://my-branch.musubi.localhost",
    );
  });

  it("adds nothing without PORTLESS_URL, so the fixed-port devloop is untouched", async () => {
    const result = await run(["sh", "-c", "echo [$PUBLIC_CIRE_API_URL]"]);
    expect(result.stdout.trim()).toBe("[]");
  });

  it("keeps the rest of the environment", async () => {
    const result = await run(["sh", "-c", "echo $CARRIED"], {
      env: { ...PORTLESS, CARRIED: "yes" },
    });
    expect(result.stdout.trim()).toBe("yes");
  });

  it("wins over an inherited value, since under portless the old one is a dead host", async () => {
    const result = await run(["sh", "-c", "echo $PUBLIC_CIRE_API_URL"], {
      env: { ...PORTLESS, PUBLIC_CIRE_API_URL: "http://localhost:8787" },
    });
    expect(result.stdout.trim()).toBe("https://my-branch.api.cire.localhost");
  });

  it("announces the app and its URL on stderr, leaving stdout to the command", async () => {
    // A banner on stdout would land in the middle of whatever `dev:app` prints.
    const result = await run(["sh", "-c", "echo child-output"], { env: PORTLESS });
    expect(result.stderr).toContain("dev-env: @cire/host -> https://my-branch.host.cire.localhost");
    expect(result.stdout.trim()).toBe("child-output");
  });

  it("says nothing when it has nothing to add", async () => {
    const result = await run(["true"]);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});
