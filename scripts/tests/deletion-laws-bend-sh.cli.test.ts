// tools/deletion-laws/bend.sh, one test per way it can let a broken proof or
// a stale model through, or block someone it should not. CI's `bend-proofs`
// job runs `bend.sh check` and lefthook's `bend-proofs` step runs `bend.sh
// hook`. Each test copies the script into a scratch repository beside a copy
// of the real bend.env and puts a stub `bend` on the PATH that answers
// `version`, proves or fails as the world says, and builds the world's model.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REAL = join(import.meta.dir, "..", "..", "tools", "deletion-laws");
const PINNED = /^BEND_VERSION=(.+)$/m.exec(readFileSync(join(REAL, "bend.env"), "utf8"))![1]!;
const COMMITTED = "export default { built: 1 };\n";

const scratch = mkdtempSync(join(tmpdir(), "deletion-laws-bend-sh-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface World {
  readonly repo: string;
  readonly laws: string;
  readonly bin: string;
  readonly log: string;
}

let next = 0;

/** A git repository holding the script, the real pin and a committed model.mjs. */
function world(): World {
  next += 1;
  const dir = mkdtempSync(join(scratch, `case-${next}-`));
  const repo = join(dir, "repo");
  const laws = join(repo, "tools", "deletion-laws");
  const bin = join(dir, "bin");
  mkdirSync(laws, { recursive: true });
  mkdirSync(bin);
  for (const file of ["bend.sh", "bend.env"]) copyFileSync(join(REAL, file), join(laws, file));
  writeFileSync(join(laws, "PROOF.bend"), "");
  writeFileSync(join(laws, "model.bend"), "");
  writeFileSync(join(laws, "model.mjs"), COMMITTED);
  for (const args of [
    ["init", "-q"],
    ["add", "-A"],
    ["-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "fixture"],
  ]) {
    const done = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
    expect(done.status, done.stderr).toBe(0);
  }
  const log = join(dir, "bend.log");
  return { repo, laws, bin, log };
}

/** A stub bend: `version`, `PROOF.bend` and `model.bend -o <out>`, logging each call's telemetry setting. */
function stubBend(w: World, opts: { version?: string; proves?: boolean; builds?: string } = {}) {
  const { version = `bend ${PINNED}`, proves = true, builds = COMMITTED } = opts;
  writeFileSync(join(w.bin, "model.out"), builds);
  writeFileSync(
    join(w.bin, "bend"),
    [
      "#!/usr/bin/env bash",
      `printf '%s %s\\n' "\${BEND_NO_TELEMETRY:-unset}" "$1" >> "${w.log}"`,
      'case "$1" in',
      `  version) echo "${version}" ;;`,
      proves
        ? '  PROOF.bend) echo "ALL PROOFS CHECK" ;;'
        : '  PROOF.bend) echo "SOME PROOFS FAIL"; exit 1 ;;',
      `  model.bend) cp "${join(w.bin, "model.out")}" "$3" ;;`,
      "esac",
    ].join("\n"),
  );
  chmodSync(join(w.bin, "bend"), 0o755);
}

function bendSh(w: World, command: string, onPath = true) {
  const result = spawnSync("bash", [join(w.laws, "bend.sh"), command], {
    cwd: w.repo,
    encoding: "utf8",
    env: {
      PATH: `${onPath ? `${w.bin}:` : ""}/usr/bin:/bin`,
      HOME: join(w.repo, "..", "home"),
    },
  });
  const calls = existsSync(w.log) ? readFileSync(w.log, "utf8").split("\n").filter(Boolean) : [];
  return { status: result.status, output: `${result.stdout}${result.stderr}`, calls };
}

const model = (w: World) => readFileSync(join(w.laws, "model.mjs"), "utf8");
const staged = (w: World) =>
  spawnSync("git", ["diff", "--cached", "--name-only"], { cwd: w.repo, encoding: "utf8" }).stdout;

describe("bend.sh", () => {
  test("check passes when every law is proved and model.mjs is what model.bend builds, with telemetry off", () => {
    const w = world();
    stubBend(w);
    const run = bendSh(w, "check");
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("ALL PROOFS CHECK");
    expect(run.calls.length).toBeGreaterThan(0);
    expect(run.calls.every((call) => call.startsWith("1 "))).toBe(true);
  });

  test("check fails on a model.mjs that is not what model.bend builds, and leaves the committed file alone", () => {
    const w = world();
    stubBend(w, { builds: "export default { built: 2 };\n" });
    const run = bendSh(w, "check");
    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(
      /^::error::tools\/deletion-laws\/model\.mjs is not what model\.bend builds/m,
    );
    expect(model(w)).toBe(COMMITTED);
  });

  test("check fails when a proof fails, before it builds anything", () => {
    const w = world();
    stubBend(w, { proves: false });
    const run = bendSh(w, "check");
    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toContain("SOME PROOFS FAIL");
    expect(run.calls.some((call) => call.endsWith(" model.bend"))).toBe(false);
  });

  test.each([
    ["a newer release", `bend ${PINNED}1`],
    ["a release that only starts the same", `bend ${PINNED}.1`],
    ["an older release", "bend 2.0.39"],
    ["no version at all", ""],
  ])("prove refuses %s and names the pinned version", (_, version) => {
    const w = world();
    stubBend(w, { version });
    const run = bendSh(w, "prove");
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain(`not the pinned ${PINNED}`);
    expect(run.calls.some((call) => call.endsWith(" PROOF.bend"))).toBe(false);
  });

  test("prove takes the pinned version with a build suffix", () => {
    const w = world();
    stubBend(w, { version: `bend ${PINNED}+abc123` });
    const run = bendSh(w, "prove");
    expect(run.status, run.output).toBe(0);
  });

  test("with no bend installed, prove fails and says how to install it", () => {
    const w = world();
    const run = bendSh(w, "prove", false);
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("bend.sh install");
  });

  test.each([
    ["no bend installed", undefined],
    ["another version installed", "bend 2.0.39"],
  ])("hook passes with one line when there is %s", (_, version) => {
    const w = world();
    if (version !== undefined) stubBend(w, { version, proves: false });
    const run = bendSh(w, "hook", version !== undefined);
    expect(run.status, run.output).toBe(0);
    expect(run.output.trim().split("\n")).toHaveLength(1);
    expect(run.output).toContain("bend-proofs: skipped");
  });

  test("hook fails when a proof fails", () => {
    const w = world();
    stubBend(w, { proves: false });
    const run = bendSh(w, "hook");
    expect(run.status, run.output).not.toBe(0);
  });

  test("hook rebuilds a stale model.mjs, fails asking for it to be staged, and stages nothing itself", () => {
    const w = world();
    stubBend(w, { builds: "export default { built: 2 };\n" });
    const run = bendSh(w, "hook");
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("stage tools/deletion-laws/model.mjs");
    expect(model(w)).toBe("export default { built: 2 };\n");
    expect(staged(w)).toBe("");
  });

  test("hook passes when the proofs check and model.mjs is already what model.bend builds", () => {
    const w = world();
    stubBend(w);
    const run = bendSh(w, "hook");
    expect(run.status, run.output).toBe(0);
    expect(model(w)).toBe(COMMITTED);
  });

  test("an unknown command is a usage error", () => {
    const w = world();
    stubBend(w);
    const run = bendSh(w, "verify");
    expect(run.status, run.output).toBe(2);
    expect(run.output).toContain("usage: bend.sh");
  });
});
