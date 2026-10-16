#!/usr/bin/env bun
/**
 * Writes every dev host a stage serves, derived from `DEV_DOMAIN`:
 * `bun run dev-hosts -- --stage <stage>`. Writes one `key=value` line per
 * value to `$GITHUB_OUTPUT` (stdout when unset) and appends a table of them
 * to `$GITHUB_STEP_SUMMARY` when set. Exits 2, writing nothing, when the
 * domain or the stage is missing or refused.
 */
import { appendFileSync } from "node:fs";

import { devHostOutputs, readDevDomain } from "../src/hosts";

function stageArgument(argv: readonly string[]): string {
  const at = argv.indexOf("--stage");
  const value = at === -1 ? undefined : argv[at + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new Error("pass --stage <stage>: the stage whose hosts to derive");
  }
  return value;
}

let outputs: ReadonlyMap<string, string>;
try {
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  outputs = devHostOutputs(readDevDomain(process.env), stageArgument(args));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(2);
}

const lines = [...outputs].map(([key, value]) => `${key}=${value}\n`).join("");
const outputFile = process.env.GITHUB_OUTPUT ?? "";
if (outputFile === "") process.stdout.write(lines);
else appendFileSync(outputFile, lines);

const summaryFile = process.env.GITHUB_STEP_SUMMARY ?? "";
if (summaryFile !== "") {
  const rows = [...outputs].map(([key, value]) => `| \`${key}\` | ${value} |\n`).join("");
  appendFileSync(summaryFile, `### Dev hosts\n\n| Output | Value |\n|---|---|\n${rows}\n`);
}
