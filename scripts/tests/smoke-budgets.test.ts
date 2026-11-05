// scripts/smoke-budgets.ts reads the plan a release approved and names the
// sites whose smoke check may wait longer. What the production stack jobs do
// with what it writes is held by scripts/tests/deploy-workflows.test.ts
// (PW13), which runs the step as written; this holds what it refuses.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runSmokeBudgets } from "../smoke-budgets";

/** Runs the script over `content` as the record file (none when undefined). */
function run(content: string | undefined, args?: readonly string[]) {
  const dir = mkdtempSync(join(tmpdir(), "smoke-budgets-"));
  const record = join(dir, "cire.json");
  if (content !== undefined) writeFileSync(record, content);
  const output = join(dir, "github-output");
  writeFileSync(output, "");
  const lines: string[] = [];
  const code = runSmokeBudgets({
    args: args ?? [record],
    env: { GITHUB_OUTPUT: output },
    out: (text) => lines.push(text),
  });
  return { code, written: readFileSync(output, "utf8"), out: lines.join("") };
}

const NEW_HOST = { site: "cire_host", added: ["next.host.cireweddings.com"], removed: [] };

describe("SG1: a file that is not a plan guard record fails the step and writes nothing", () => {
  test.each([
    ["no file", undefined],
    ["not JSON", "{"],
    ["no domains", JSON.stringify({ stack: "cire" })],
    ["domains not a list", JSON.stringify({ domains: { cire_host: NEW_HOST } })],
    ["an entry that is not an object", JSON.stringify({ domains: [NEW_HOST, null] })],
    [
      "a site that is not one",
      JSON.stringify({ domains: [NEW_HOST, { ...NEW_HOST, site: "cire_hosts" }] }),
    ],
    [
      "added not a list of hosts",
      JSON.stringify({ domains: [{ ...NEW_HOST, added: "next.host.cireweddings.com" }] }),
    ],
    ["a host that is not a string", JSON.stringify({ domains: [{ ...NEW_HOST, added: [42] }] })],
  ])("%s", (_, content) => {
    const result = run(content);
    expect(result.code).toBe(1);
    expect(result.written).toBe("");
    expect(result.out).toStartWith("::error");
  });

  test("named no record, or more than one, it exits 2 and writes nothing", () => {
    for (const args of [[], ["a.json", "b.json"]]) {
      const result = run(JSON.stringify({ domains: [NEW_HOST] }), args);
      expect(result.code).toBe(2);
      expect(result.written).toBe("");
      expect(result.out).toStartWith("::error");
    }
  });
});
