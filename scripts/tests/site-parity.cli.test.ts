// The `import.meta.main` block of scripts/site-parity.ts: an error that stops
// the run exits with a code of its own, never 1, which the site-parity job
// reads as a difference and lets pass. A preload stands in for `fetch`, so the
// run asks no real host; the report's directory is a regular file, so writing
// the report throws.

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../site-parity.ts", import.meta.url).pathname;

test("SP10: an error that stops the run exits 4 with an error line, never 1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "site-parity-cli-"));
  try {
    const offline = join(dir, "offline.ts");
    writeFileSync(
      offline,
      'globalThis.fetch = (async () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch;\n',
    );
    const taken = join(dir, "taken");
    writeFileSync(taken, "");
    const proc = Bun.spawn(
      [
        process.execPath,
        "--preload",
        offline,
        SCRIPT,
        "--stack",
        "cire",
        "--out",
        join(taken, "report.json"),
        "--root",
        dir,
      ],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect({ exitCode, stdout, stderr }).toMatchObject({ exitCode: 4 });
    expect(stdout).toContain("::error::site-parity: stopped on an error before it finished: ");
    // The error's own words, on the same line: here, making the report's directory.
    expect(stdout).toMatch(/::error::site-parity: stopped on an error before it finished: .*mkdir/);
    expect(existsSync(join(taken, "report.json"))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
