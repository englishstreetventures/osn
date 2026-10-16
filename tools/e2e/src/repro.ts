/**
 * `bun run test:e2e:repro`: runs the whole suite twice from a clean state and
 * fails unless both runs wrote the same `results.json`, byte for byte.
 *
 * Each run clears `e2e-artifacts/`, so run 1's file is copied out first. The
 * artifacts left behind are run 2's.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { RESULTS_FILE } from "./config";

const LAUNCHER = resolve(import.meta.dirname, "launcher.ts");

const say = (line: string): void => {
  process.stderr.write(`e2e repro: ${line}\n`);
};

/** First differing line of two texts, 1-based, or null when they are equal. */
export function firstDifference(
  a: string,
  b: string,
): { line: number; a: string; b: string } | null {
  if (a === b) return null;
  const left = a.split("\n");
  const right = b.split("\n");
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    if (left[i] !== right[i]) return { line: i + 1, a: left[i] ?? "<end>", b: right[i] ?? "<end>" };
  }
  return { line: left.length, a: "<same lines, different bytes>", b: "" };
}

function run(label: string): boolean {
  say(`${label}`);
  const result = spawnSync("bun", [LAUNCHER], { stdio: "inherit" });
  return result.status === 0 && existsSync(RESULTS_FILE);
}

function main(): number {
  const keep = join(mkdtempSync(join(tmpdir(), "e2e-repro-")), "run-1.json");
  if (!run("run 1 of 2")) return 1;
  copyFileSync(RESULTS_FILE, keep);
  if (!run("run 2 of 2")) return 1;

  const diff = firstDifference(readFileSync(keep, "utf8"), readFileSync(RESULTS_FILE, "utf8"));
  if (diff) {
    say(`results.json differs between runs at line ${diff.line}`);
    say(`  run 1: ${diff.a}`);
    say(`  run 2: ${diff.b}`);
    return 1;
  }
  say("results.json is byte-identical across both runs");
  return 0;
}

if (import.meta.main) {
  process.exitCode = main();
}
