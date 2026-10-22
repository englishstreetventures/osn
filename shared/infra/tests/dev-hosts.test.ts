import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

const SCRIPT = fileURLToPath(new URL("../scripts/dev-hosts.ts", import.meta.url));

interface Run {
  readonly exitCode: number;
  readonly stdout: string;
  readonly output: string;
  readonly summary: string;
}

/** Runs the CLI with `env` and fresh GitHub output and step summary files. */
function run(args: readonly string[], env: Readonly<Record<string, string>>): Run {
  const dir = mkdtempSync(join(tmpdir(), "dev-hosts-"));
  const output = join(dir, "output");
  const summary = join(dir, "summary.md");
  writeFileSync(output, "");
  writeFileSync(summary, "");
  const result = Bun.spawnSync(["bun", SCRIPT, ...args], {
    env: { PATH: process.env.PATH, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: summary, ...env },
  });
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    output: readFileSync(output, "utf8"),
    summary: readFileSync(summary, "utf8"),
  };
}

describe("dev-hosts", () => {
  test("C1: without a valid DEV_DOMAIN or stage it exits 2 and writes no output", () => {
    for (const [args, env] of [
      [["--stage", "dev"], {}],
      [["--stage", "dev"], { DEV_DOMAIN: "" }],
      [["--stage", "dev"], { DEV_DOMAIN: "musubi.social" }],
      [["--stage", "production"], { DEV_DOMAIN: "example.dev" }],
      [[], { DEV_DOMAIN: "example.dev" }],
    ] as const) {
      const result = run(args, env);
      expect({ args, env, exitCode: result.exitCode }).toEqual({ args, env, exitCode: 2 });
      expect(result.stdout).toBe("");
      expect(result.output).toBe("");
      expect(result.summary).toBe("");
    }
    // The same harness with a valid domain does write, so the refusals above are the CLI's.
    const valid = run(["--", "--stage", "dev"], { DEV_DOMAIN: "example.dev" });
    expect(valid.exitCode).toBe(0);
    expect(valid.output).toContain("osn_api_origin=https://id.musubi.example.dev\n");
  });
});
