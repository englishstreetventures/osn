#!/usr/bin/env bun
/**
 * Entry point of every cire package's `test:mutation` script. The command
 * itself is in `app.ts`.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { run } from "@stricli/core";

import { app } from "./app.ts";

const repoRoot = resolve(import.meta.dir, "../../..");

await run(app, process.argv.slice(2), {
  process,
  cwd: process.cwd(),
  repoRoot,
  exists: existsSync,
  git: (args) => {
    const proc = Bun.spawnSync(["git", ...args], { cwd: repoRoot, stderr: "inherit" });
    return proc.exitCode === 0 ? proc.stdout.toString() : undefined;
  },
  spawn: (cmd, cwd) =>
    Bun.spawn([...cmd], { cwd, stdio: ["inherit", "inherit", "inherit"] }).exited,
});
