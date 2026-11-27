// tools/bend/bend.sh, one test per way it can let a broken proof, a stale
// model, a verdict the BendTT kernel did not give, or a bend or kernel that is
// not the pinned build through, prove fewer law sets than there are, run bend
// with its version ping on, or block someone it should not. CI's
// `bend-proofs` job runs `bend.sh sets`, `check`, `kernel` and `verdict`, and
// lefthook's `bend-proofs` step runs `bend.sh hook`. Each test builds a
// scratch repository holding a copy of the script, the real bend.env and
// lean.env, and two law sets, `osn/api/laws/one` and `cire/api/laws/two`,
// each with a committed model.mjs; a stub `bend` on the PATH answers
// `version`, proves or fails a set as the world says (exiting 1, or the
// status the world gives), answers `--verdict` with the world's text and
// status for the set, builds a set's model from the world's text for it,
// builds a kernel under $HOME/.bend/bendtt/ as bend does when `--verdict`
// runs on any other file, and prints a guide; bend.env pins the stub's own
// SHA-256. A stub `lean`, on the PATH only when a test asks, answers
// `--version` with the version the test gives.

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

const REAL = join(import.meta.dir, "..", "..", "tools", "bend");
const PINNED = /^BEND_VERSION=(.+)$/m.exec(readFileSync(join(REAL, "bend.env"), "utf8"))![1]!;
const LEAN = /^LEAN_VERSION=(.+)$/m.exec(readFileSync(join(REAL, "lean.env"), "utf8"))![1]!;
const SETS = ["cire/api/laws/two", "osn/api/laws/one"] as const;
const COMMITTED = (set: string) => `export default { set: "${set}" };\n`;
const TARGET = `${process.platform === "darwin" ? "DARWIN" : "LINUX"}_${process.arch === "arm64" ? "ARM64" : "X64"}`;
const sha256 = (bytes: Buffer | string) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const PASS = "ALL PROOFS CHECK";
// What bend's plain run prints on a pass, and so what a `--verdict` that never
// reached the kernel would print.
const HINTED = `${PASS}\nUse --verdict for mathematical validity.`;
const KERNEL = "#!/bin/sh\necho the BendTT kernel\n";

const scratch = mkdtempSync(join(tmpdir(), "bend-sh-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface World {
  readonly repo: string;
  readonly tools: string;
  readonly bin: string;
  /** Holds the stub `lean`, on the PATH only when a run asks for it. */
  readonly leanBin: string;
  readonly home: string;
  readonly log: string;
}

let next = 0;

const git = (repo: string, ...args: string[]) => {
  const done = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", ...args], {
    cwd: repo,
    encoding: "utf8",
  });
  expect(done.status, done.stderr).toBe(0);
  return done.stdout;
};

/** A law set: a LAWS.bend, a PROOF.bend that imports it, a model and its committed build. */
function lawSet(repo: string, set: string, proof = "import ./LAWS.bend as Laws\n") {
  const dir = join(repo, set);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "LAWS.bend"), "");
  writeFileSync(join(dir, "PROOF.bend"), proof);
  writeFileSync(join(dir, "model.bend"), "");
  writeFileSync(join(dir, "model.mjs"), COMMITTED(set));
}

/** A git repository holding the script, the real pin, and both law sets, committed. */
function world(): World {
  next += 1;
  const dir = mkdtempSync(join(scratch, `case-${next}-`));
  const repo = join(dir, "repo");
  const tools = join(repo, "tools", "bend");
  const bin = join(dir, "bin");
  const leanBin = join(dir, "lean-bin");
  const home = join(dir, "home");
  mkdirSync(tools, { recursive: true });
  for (const at of [bin, leanBin, home]) mkdirSync(at);
  for (const file of ["bend.sh", "bend.env", "lean.env"])
    copyFileSync(join(REAL, file), join(tools, file));
  for (const set of SETS) lawSet(repo, set);
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "fixture");
  return { repo, tools, bin, leanBin, home, log: join(dir, "bend.log") };
}

/** Sets `<key>_<this platform>=<value>` in the world's copy of a pin file. */
function pinIn(w: World, file: "bend.env" | "lean.env", key: string, value: string) {
  const env = join(w.tools, file);
  const line = `${key}_${TARGET}=${value}`;
  const text = readFileSync(env, "utf8");
  const at = new RegExp(`^${key}_${TARGET}=.*$`, "m");
  writeFileSync(env, at.test(text) ? text.replace(at, line) : `${text}${line}\n`);
}

/** A verdict the stub prints for a set, and the status it exits with. */
interface Verdict {
  readonly out: string;
  readonly status?: number;
}

/**
 * A stub bend. `PROOF.bend` fails in the sets named in `failing`; `PROOF.bend
 * --verdict` prints the set's `verdicts` entry (ALL PROOFS CHECK, exit 0, by
 * default); any other file with `--verdict` builds `kernel` (unless it is
 * null) at $HOME/.bend/bendtt/0123456789abcdef/bendtt, then prints and exits
 * as `kernelRun` says (a pass by default); `model.bend
 * -o <out>` writes the set's text from `builds`, or its committed model.mjs.
 * Unless `pinned` is false, the world's bend.env pins the stub's own SHA-256
 * for this platform, as it pins the real release's binary.
 */
function stubBend(
  w: World,
  opts: {
    version?: string;
    failing?: readonly string[];
    failStatus?: number;
    verdicts?: Readonly<Record<string, Verdict>>;
    kernel?: string | null;
    kernelRun?: Verdict;
    builds?: Readonly<Record<string, string>>;
    pinned?: boolean;
  } = {},
) {
  const {
    version = `bend ${PINNED}`,
    failing = [],
    failStatus = 1,
    verdicts = {},
    kernel = KERNEL,
    kernelRun = { out: PASS },
    builds = {},
    pinned = true,
  } = opts;
  writeFileSync(join(w.bin, "kernel-run.verdict"), `${kernelRun.out}\n`);
  writeFileSync(join(w.bin, "kernel-run.status"), String(kernelRun.status ?? 0));
  for (const set of SETS) {
    const file = set.replaceAll("/", "_");
    writeFileSync(join(w.bin, `${file}.out`), builds[set] ?? COMMITTED(set));
    writeFileSync(join(w.bin, `${file}.verdict`), `${verdicts[set]?.out ?? PASS}\n`);
    writeFileSync(join(w.bin, `${file}.status`), String(verdicts[set]?.status ?? 0));
  }
  if (kernel !== null) writeFileSync(join(w.bin, "kernel"), kernel);
  writeFileSync(join(w.bin, "failing"), failing.map((set) => `${join(w.repo, set)}\n`).join(""));
  writeFileSync(
    join(w.bin, "bend"),
    [
      "#!/usr/bin/env bash",
      `printf '%s %s %s %s %s\\n' "\${BEND_NO_TELEMETRY:-unset}" "$1" "$PWD" "\${2:--}" "$HOME" >> "${w.log}"`,
      `set=\${PWD#${w.repo}/}`,
      'case "$1 ${2:-}" in',
      `  "version ") echo "${version}" ;;`,
      `  "PROOF.bend --verdict") f="${w.bin}/\${set//\\//_}"; cat "$f.verdict"; exit "$(cat "$f.status")" ;;`,
      `  "PROOF.bend ") if grep -qx "$PWD" "${join(w.bin, "failing")}"; then echo "SOME PROOFS FAIL"; exit ${failStatus}; fi; printf '%s\\n' "${HINTED.replace("\n", "\\n")}" ;;`,
      `  *" --verdict") if [ -z "\${BENDTT:-}" ] && [ -f "${w.bin}/kernel" ]; then mkdir -p "$HOME/.bend/bendtt/0123456789abcdef"; cp "${w.bin}/kernel" "$HOME/.bend/bendtt/0123456789abcdef/bendtt"; fi; cat "${w.bin}/kernel-run.verdict"; exit "$(cat "${w.bin}/kernel-run.status")" ;;`,
      `  "model.bend -o") cp "${w.bin}/\${set//\\//_}.out" "$3" ;;`,
      '  "guide "*) echo "# Bend guide $2" ;;',
      "esac",
    ].join("\n"),
  );
  chmodSync(join(w.bin, "bend"), 0o755);
  if (pinned) pinIn(w, "bend.env", "BEND_BIN_SHA256", sha256(readFileSync(join(w.bin, "bend"))));
}

/** A stub `lean` in the world's lean-bin, reporting `version`. */
function stubLean(w: World, version = LEAN) {
  writeFileSync(
    join(w.leanBin, "lean"),
    `#!/bin/sh\necho "Lean (version ${version}, x86_64-unknown-linux-gnu, commit 0000, Release)"\n`,
  );
  chmodSync(join(w.leanBin, "lean"), 0o755);
}

function bendSh(
  w: World,
  command: string | readonly string[],
  opts: { onPath?: boolean; lean?: boolean; env?: Readonly<Record<string, string>> } = {},
) {
  const { onPath = true, lean = false, env = {} } = opts;
  const result = spawnSync(
    "bash",
    [join(w.tools, "bend.sh"), ...(typeof command === "string" ? command.split(" ") : command)],
    {
      cwd: w.repo,
      encoding: "utf8",
      env: {
        PATH: `${onPath ? `${w.bin}:` : ""}${lean ? `${w.leanBin}:` : ""}/usr/bin:/bin`,
        HOME: w.home,
        ...env,
      },
    },
  );
  const calls = existsSync(w.log) ? readFileSync(w.log, "utf8").split("\n").filter(Boolean) : [];
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    stdout: result.stdout,
    calls,
  };
}

/** The sets the stub ran `bend PROOF.bend` in, in order: the plain runs only. */
const proved = (w: World, calls: readonly string[]) =>
  calls
    .filter((call) => call.split(" ")[1] === "PROOF.bend" && call.split(" ")[3] === "-")
    .map((call) => call.split(" ")[2]!.slice(w.repo.length + 1));

/** The sets the stub ran `bend PROOF.bend --verdict` in, in order. */
const verdicts = (w: World, calls: readonly string[]) =>
  calls
    .filter((call) => call.split(" ")[1] === "PROOF.bend" && call.split(" ")[3] === "--verdict")
    .map((call) => call.split(" ")[2]!.slice(w.repo.length + 1));

/** The kernel builds the stub ran: `--verdict` on any file but a set's PROOF.bend. */
const builds = (calls: readonly string[]) =>
  calls.filter((call) => call.split(" ")[1] !== "PROOF.bend" && call.split(" ")[3] === "--verdict");

const model = (w: World, set: string) => readFileSync(join(w.repo, set, "model.mjs"), "utf8");

describe("bend.sh", () => {
  test("sets lists each <workspace>/laws/<topic>/ the index holds, and nothing else", () => {
    const w = world();
    stubBend(w);
    // A test folder named laws, a laws/ one level too deep, and a set nobody
    // has added are not law sets.
    lawSet(w.repo, "osn/api/tests/laws/x");
    lawSet(w.repo, "osn/api/src/laws/x");
    git(w.repo, "add", "-A");
    lawSet(w.repo, "zap/api/laws/untracked");
    const run = bendSh(w, "sets");
    expect(run.status, run.output).toBe(0);
    expect(run.output.trim().split("\n")).toEqual([...SETS]);
  });

  test("a set the index holds but the working tree has lost is neither listed nor proved", () => {
    const w = world();
    stubBend(w);
    rmSync(join(w.repo, "osn/api/laws/one"), { recursive: true, force: true });
    const sets = bendSh(w, "sets");
    expect(sets.status, sets.output).toBe(0);
    expect(sets.output.trim().split("\n")).toEqual(["cire/api/laws/two"]);
    const run = bendSh(w, "check");
    expect(run.status, run.output).toBe(0);
    expect(proved(w, run.calls)).toEqual(["cire/api/laws/two"]);
  });

  test.each(["zap/api/laws/café", "zap/api/laws/two words"])(
    "a set at %s, a name git quotes or a list splits, fails sets and check instead of dropping out",
    (bad) => {
      const w = world();
      stubBend(w);
      lawSet(w.repo, bad);
      git(w.repo, "add", "-A");
      for (const command of ["sets", "check"]) {
        const run = bendSh(w, command);
        expect(run.status, `${command}: ${run.output}`).toBe(1);
        expect(run.output).toContain("name its folders with A-Z, a-z, 0-9");
      }
      expect(proved(w, bendSh(w, "sets").calls)).toEqual([]);
      const named = bendSh(w, "check zap/api/laws/café");
      expect(named.status, named.output).toBe(1);
      expect(named.output).toContain("no law set at zap/api/laws/café");
    },
  );

  test("bend.env is read as data: no line in it turns the version ping on or runs", () => {
    const w = world();
    stubBend(w);
    const env = join(w.tools, "bend.env");
    writeFileSync(
      env,
      `${readFileSync(env, "utf8")}BEND_NO_TELEMETRY=0\nexport BEND_NO_TELEMETRY=0\ntouch ran\n`,
    );
    const run = bendSh(w, "check");
    expect(run.status, run.output).toBe(0);
    expect(proved(w, run.calls)).toEqual([...SETS]);
    expect(run.calls.every((call) => call.startsWith("1 "))).toBe(true);
    expect(existsSync(join(w.repo, "ran"))).toBe(false);
  });

  test("a set with no model.bend is proved, and build, check and hook build no model in it", () => {
    const w = world();
    stubBend(w);
    git(w.repo, "rm", "-q", "osn/api/laws/one/model.bend", "osn/api/laws/one/model.mjs");
    for (const command of ["build", "check", "hook"]) {
      const run = bendSh(w, command);
      expect(run.status, `${command}: ${run.output}`).toBe(0);
    }
    const { calls } = bendSh(w, "sets");
    expect(proved(w, calls)).toContain("osn/api/laws/one");
    const builtIn = calls
      .filter((call) => call.split(" ")[1] === "model.bend")
      .map((call) => call.split(" ")[2]!.slice(w.repo.length + 1));
    expect(builtIn).not.toContain("osn/api/laws/one");
    expect(builtIn).toContain("cire/api/laws/two");
    expect(existsSync(join(w.repo, "osn/api/laws/one/model.mjs"))).toBe(false);
  });

  test("check proves every set and checks each model, with telemetry off", () => {
    const w = world();
    stubBend(w);
    const run = bendSh(w, "check");
    expect(run.status, run.output).toBe(0);
    expect(proved(w, run.calls)).toEqual([...SETS]);
    for (const set of SETS) expect(run.output).toContain(`${set}/model.mjs matches model.bend`);
    expect(run.calls.length).toBeGreaterThan(0);
    expect(run.calls.every((call) => call.startsWith("1 "))).toBe(true);
  });

  test("check fails when one set's proof fails", () => {
    const w = world();
    stubBend(w, { failing: ["osn/api/laws/one"] });
    const run = bendSh(w, "check");
    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toContain("SOME PROOFS FAIL");
  });

  test("check fails a proof that prints SOME PROOFS FAIL even when bend exits 0", () => {
    const w = world();
    stubBend(w, { failing: ["cire/api/laws/two"], failStatus: 0 });
    const run = bendSh(w, "check");
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain(
      "cire/api/laws/two: bend exited 0 but did not print ALL PROOFS CHECK",
    );
  });

  test("check fails on one set's stale model.mjs, names it, checks the rest, and leaves the files alone", () => {
    const w = world();
    stubBend(w, { builds: { "cire/api/laws/two": "export default { built: 2 };\n" } });
    const run = bendSh(w, "check");
    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(
      /^::error::cire\/api\/laws\/two\/model\.mjs is not what cire\/api\/laws\/two\/model\.bend builds/m,
    );
    expect(run.output).toContain("osn/api/laws/one/model.mjs matches model.bend");
    expect(model(w, "cire/api/laws/two")).toBe(COMMITTED("cire/api/laws/two"));
  });

  test("check fails when the index holds no law set at all", () => {
    const w = world();
    stubBend(w);
    git(w.repo, "rm", "-rq", "osn/api/laws", "cire/api/laws");
    const run = bendSh(w, "check");
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("no law set found");
    expect(proved(w, run.calls)).toEqual([]);
  });

  test("check fails a set whose PROOF.bend does not import its LAWS.bend", () => {
    const w = world();
    stubBend(w);
    writeFileSync(join(w.repo, "osn/api/laws/one/PROOF.bend"), "import Base\n");
    const run = bendSh(w, "check");
    expect(run.status, run.output).not.toBe(0);
    expect(run.output).toContain("osn/api/laws/one/PROOF.bend does not import ./LAWS.bend");
  });

  test("check of one set proves that set alone; a set that is not one is refused", () => {
    const w = world();
    stubBend(w);
    const one = bendSh(w, "check osn/api/laws/one");
    expect(one.status, one.output).toBe(0);
    expect(proved(w, one.calls)).toEqual(["osn/api/laws/one"]);
    const none = bendSh(w, "check osn/api/laws/missing");
    expect(none.status, none.output).toBe(1);
    expect(none.output).toContain("no law set at osn/api/laws/missing");
  });

  test("build rebuilds every set's model", () => {
    const w = world();
    stubBend(w, {
      builds: {
        "osn/api/laws/one": "export default { built: 1 };\n",
        "cire/api/laws/two": "export default { built: 2 };\n",
      },
    });
    const run = bendSh(w, "build");
    expect(run.status, run.output).toBe(0);
    expect(model(w, "osn/api/laws/one")).toBe("export default { built: 1 };\n");
    expect(model(w, "cire/api/laws/two")).toBe("export default { built: 2 };\n");
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
    expect(proved(w, run.calls)).toEqual([]);
  });

  test("prove takes the pinned version with a build suffix", () => {
    const w = world();
    stubBend(w, { version: `bend ${PINNED}+abc123` });
    const run = bendSh(w, "prove");
    expect(run.status, run.output).toBe(0);
  });

  test("prove refuses a bend that reports the pinned version but is not the pinned build", () => {
    const w = world();
    stubBend(w, { pinned: false });
    const run = bendSh(w, "prove");
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain(`not the pinned Bend ${PINNED} build`);
    expect(run.calls).toEqual([]);
  });

  test("guide passes its topic to the pinned bend, with telemetry off", () => {
    const w = world();
    stubBend(w);
    const run = bendSh(w, "guide effects");
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("# Bend guide effects");
    expect(run.calls.filter((call) => call.split(" ")[1] === "guide")).toHaveLength(1);
    expect(run.calls.every((call) => call.startsWith("1 "))).toBe(true);
  });

  test("with no bend installed, prove fails and says how to install it", () => {
    const w = world();
    const run = bendSh(w, "prove", { onPath: false });
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("bend.sh install");
  });

  test.each([
    ["no bend installed", undefined],
    ["another version installed", "bend 2.0.39"],
    ["a binary that is not the pinned build", `bend ${PINNED}`],
  ])("hook passes with one line when there is %s", (name, version) => {
    const w = world();
    if (version !== undefined) {
      stubBend(w, {
        version,
        failing: [...SETS],
        pinned: !name.includes("not the pinned build"),
      });
    }
    const run = bendSh(w, "hook", { onPath: version !== undefined });
    expect(run.status, run.output).toBe(0);
    expect(run.output.trim().split("\n")).toHaveLength(1);
    expect(run.output).toContain("bend-proofs: skipped");
  });

  test("hook fails when a set's proof fails", () => {
    const w = world();
    stubBend(w, { failing: ["cire/api/laws/two"] });
    const run = bendSh(w, "hook");
    expect(run.status, run.output).not.toBe(0);
  });

  test("hook rebuilds a stale model.mjs, fails asking for it to be staged, and stages nothing itself", () => {
    const w = world();
    stubBend(w, { builds: { "osn/api/laws/one": "export default { built: 2 };\n" } });
    const run = bendSh(w, "hook");
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("osn/api/laws/one/model.mjs");
    expect(run.output).toContain("stage it");
    expect(model(w, "osn/api/laws/one")).toBe("export default { built: 2 };\n");
    expect(git(w.repo, "diff", "--cached", "--name-only")).toBe("");
  });

  test("hook passes when every set proves and every model.mjs is already what its model.bend builds", () => {
    const w = world();
    stubBend(w);
    const run = bendSh(w, "hook");
    expect(run.status, run.output).toBe(0);
    expect(proved(w, run.calls)).toEqual([...SETS]);
  });

  test("an unknown command is a usage error", () => {
    const w = world();
    stubBend(w);
    const run = bendSh(w, "verify");
    expect(run.status, run.output).toBe(2);
    expect(run.output).toContain("usage: bend.sh");
  });
});

/** An executable file at `at` holding `text`. */
function executable(at: string, text: string) {
  mkdirSync(join(at, ".."), { recursive: true });
  writeFileSync(at, text);
  chmodSync(at, 0o755);
}

/** The pinned Lean where bend looks first: elan's toolchain for that version. */
const elanLean = (w: World) =>
  join(w.home, ".elan", "toolchains", `leanprover--lean4---v${LEAN}`, "bin", "lean");

describe("bend.sh verdict: CI's recheck with the BendTT kernel", () => {
  test("with no kernel, no $BENDTT and no Lean, verdict fails, names the pinned Lean and runs no bend", () => {
    const w = world();
    stubBend(w);
    const run = bendSh(w, "verdict");
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain(`Lean ${LEAN}`);
    expect(run.calls).toEqual([]);
  });

  test("a lean of another version on the PATH is no kernel: verdict fails and names both versions", () => {
    const w = world();
    stubBend(w);
    stubLean(w, "4.33.0");
    const run = bendSh(w, "verdict", { lean: true });
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("4.33.0");
    expect(run.output).toContain(LEAN);
    expect(verdicts(w, run.calls)).toEqual([]);
  });

  test.each(["the pinned Lean on the PATH", "elan's toolchain for the pinned Lean", "$BENDTT"])(
    "with %s, verdict runs bend PROOF.bend --verdict in every set, telemetry off, and passes when each prints ALL PROOFS CHECK alone",
    (kernel) => {
      const w = world();
      stubBend(w);
      stubLean(w);
      const env: Record<string, string> = {};
      if (kernel.includes("elan")) executable(elanLean(w), "#!/bin/sh\n");
      if (kernel === "$BENDTT") {
        env.BENDTT = join(w.home, "bendtt");
        executable(env.BENDTT, KERNEL);
        pinIn(w, "lean.env", "BENDTT_SHA256", sha256(KERNEL));
      }
      const run = bendSh(w, "verdict", { lean: kernel.includes("PATH"), env });
      expect(run.status, run.output).toBe(0);
      expect(verdicts(w, run.calls)).toEqual([...SETS]);
      expect(proved(w, run.calls)).toEqual([]);
      expect(run.calls.every((call) => call.startsWith("1 "))).toBe(true);
    },
  );

  test("a set whose verdict exits non-zero fails verdict, which still checks the other sets and names the one that failed", () => {
    const w = world();
    stubBend(w, {
      verdicts: { "cire/api/laws/two": { out: "SOME PROOFS FAIL\nnot a proof", status: 1 } },
    });
    stubLean(w);
    const run = bendSh(w, "verdict", { lean: true });
    expect(run.status, run.output).toBe(1);
    expect(verdicts(w, run.calls)).toEqual([...SETS]);
    expect(run.output).toMatch(/^::error::cire\/api\/laws\/two: /m);
    expect(run.output).not.toMatch(/^::error::osn\/api\/laws\/one: /m);
  });

  test.each([
    ["SOME PROOFS FAIL", "SOME PROOFS FAIL"],
    ["the plain run's hint: the kernel did not run", HINTED],
    ["anything after ALL PROOFS CHECK", `${PASS}\nand more`],
    ["nothing at all", ""],
  ])("a verdict that exits 0 but prints %s fails verdict", (_, out) => {
    const w = world();
    stubBend(w, { verdicts: { "osn/api/laws/one": { out } } });
    stubLean(w);
    const run = bendSh(w, "verdict", { lean: true });
    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/^::error::osn\/api\/laws\/one: /m);
  });

  test.each([
    ["set but empty", () => ""],
    ["naming no file", (w: World) => join(w.home, "missing")],
    [
      "naming a file that cannot run",
      (w: World) => {
        const at = join(w.home, "bendtt");
        writeFileSync(at, KERNEL);
        return at;
      },
    ],
    [
      "naming a kernel that is not the pinned build",
      (w: World) => {
        const at = join(w.home, "bendtt");
        executable(at, "#!/bin/sh\necho ALL PROOFS CHECK\n");
        return at;
      },
    ],
    [
      // bend.sh would hash ./bendtt here, while bend runs it from each set's
      // directory, or looks a bare name up on the PATH.
      "naming the pinned kernel by a relative path",
      (w: World) => {
        executable(join(w.repo, "bendtt"), KERNEL);
        return "bendtt";
      },
    ],
  ])("a $BENDTT %s fails verdict before any bend runs, Lean or no Lean", (_, bendtt) => {
    const w = world();
    stubBend(w);
    stubLean(w);
    pinIn(w, "lean.env", "BENDTT_SHA256", sha256(KERNEL));
    const run = bendSh(w, "verdict", { lean: true, env: { BENDTT: bendtt(w) } });
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("$BENDTT");
    expect(run.calls).toEqual([]);
  });

  test("in CI, a $BENDTT on a platform lean.env pins no kernel for fails verdict, which runs no bend", () => {
    const w = world();
    stubBend(w);
    pinIn(w, "lean.env", "BENDTT_SHA256", "");
    const bendtt = join(w.home, "bendtt");
    executable(bendtt, "#!/bin/sh\necho ALL PROOFS CHECK\n");
    const ci = bendSh(w, "verdict", { env: { BENDTT: bendtt, GITHUB_ACTIONS: "true" } });
    expect(ci.status, ci.output).toBe(1);
    expect(ci.output).toContain("pins no kernel");
    expect(ci.calls).toEqual([]);
    // Off CI, a kernel built on a platform with no pin is the owner's to name.
    const here = bendSh(w, "verdict", { env: { BENDTT: bendtt } });
    expect(here.status, here.output).toBe(0);
    expect(verdicts(w, here.calls)).toEqual([...SETS]);
  });

  test.each([
    ["exits 1", 1],
    ["exits 0", 0],
  ])(
    "a kernel that did not build or run fails verdict, never skips it, when bend %s",
    (_, status) => {
      const w = world();
      const broken = "Error: BendTT infrastructure: kernel exited 1 without a verdict";
      stubBend(w, { verdicts: { "cire/api/laws/two": { out: broken, status } } });
      stubLean(w);
      const run = bendSh(w, "verdict", { lean: true });
      expect(run.status, run.output).toBe(1);
      expect(run.output).toMatch(/^::error::cire\/api\/laws\/two: /m);
      expect(verdicts(w, run.calls)).toEqual([...SETS]);
      expect(run.output).not.toContain("skipped");
    },
  );
});

describe("bend.sh prove and check: the verdict after the plain run, where this machine can", () => {
  test.each(["prove", "check"])(
    "%s with the pinned Lean runs each set's verdict straight after its plain run",
    (command) => {
      const w = world();
      stubBend(w);
      stubLean(w);
      const run = bendSh(w, command, { lean: true });
      expect(run.status, run.output).toBe(0);
      const order = run.calls
        .filter((call) => call.split(" ")[1] === "PROOF.bend")
        .map((call) => `${call.split(" ")[2]!.slice(w.repo.length + 1)} ${call.split(" ")[3]}`);
      expect(order).toEqual(SETS.flatMap((set) => [`${set} -`, `${set} --verdict`]));
    },
  );

  test.each(["prove", "check"])("%s fails when the verdict rejects a set", (command) => {
    const w = world();
    stubBend(w, {
      verdicts: { "osn/api/laws/one": { out: "SOME PROOFS FAIL\nnot a proof", status: 1 } },
    });
    stubLean(w);
    const run = bendSh(w, command, { lean: true });
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain("osn/api/laws/one");
  });

  test.each([
    ["prove", "no Lean", undefined],
    ["check", "no Lean", undefined],
    ["prove", "another Lean", "4.33.0"],
    ["check", "another Lean", "4.33.0"],
  ])(
    "%s with %s proves every set, says once that the verdict was skipped, and passes",
    (command, _, version) => {
      const w = world();
      stubBend(w);
      if (version !== undefined) stubLean(w, version);
      const run = bendSh(w, command, { lean: version !== undefined });
      expect(run.status, run.output).toBe(0);
      expect(proved(w, run.calls)).toEqual([...SETS]);
      expect(verdicts(w, run.calls)).toEqual([]);
      expect(run.output.match(/--verdict skipped/g)).toHaveLength(1);
      expect(run.output).toContain(version ?? "no lean");
    },
  );

  test.each(["prove", "check"])(
    "%s reports a kernel that did not build as a skipped verdict, tries no other set's, and passes",
    (command) => {
      const w = world();
      const broken = "Error: BendTT infrastructure: the kernel did not build (leanc: boom)";
      stubBend(w, { verdicts: { "cire/api/laws/two": { out: broken, status: 1 } } });
      stubLean(w);
      const run = bendSh(w, command, { lean: true });
      expect(run.status, run.output).toBe(0);
      expect(proved(w, run.calls)).toEqual([...SETS]);
      expect(verdicts(w, run.calls)).toEqual(["cire/api/laws/two"]);
      expect(run.output).toContain("--verdict skipped");
      expect(run.output).toContain("leanc: boom");
    },
  );

  test.each(["prove", "check"])(
    "%s fails a rejection that also names the kernel's infrastructure, rather than skipping it",
    (command) => {
      const w = world();
      const rejected =
        "SOME PROOFS FAIL\nBendTT infrastructure: the kernel and bend2 disagree on Laws.one";
      stubBend(w, { verdicts: { "cire/api/laws/two": { out: rejected, status: 1 } } });
      stubLean(w);
      const run = bendSh(w, command, { lean: true });
      expect(run.status, run.output).toBe(1);
      expect(run.output).not.toContain("--verdict skipped");
    },
  );

  test("hook never runs the verdict, even with the pinned Lean on the PATH", () => {
    const w = world();
    stubBend(w);
    stubLean(w);
    const run = bendSh(w, "hook", { lean: true });
    expect(run.status, run.output).toBe(0);
    expect(proved(w, run.calls)).toEqual([...SETS]);
    expect(verdicts(w, run.calls)).toEqual([]);
    expect(builds(run.calls)).toEqual([]);
  });

  test("lean.env is read as data: no line in it turns the version ping on or runs", () => {
    const w = world();
    stubBend(w);
    stubLean(w);
    const env = join(w.tools, "lean.env");
    writeFileSync(env, `${readFileSync(env, "utf8")}export BEND_NO_TELEMETRY=0\ntouch ran\n`);
    const run = bendSh(w, "check", { lean: true });
    expect(run.status, run.output).toBe(0);
    expect(verdicts(w, run.calls)).toEqual([...SETS]);
    expect(run.calls.every((call) => call.startsWith("1 "))).toBe(true);
    expect(existsSync(join(w.repo, "ran"))).toBe(false);
  });
});

describe("bend.sh kernel: CI's BendTT kernel, restored or built, only with the pinned SHA-256", () => {
  const cacheOf = (w: World) => join(w.repo, "..", "cache", "bendtt");

  test("a restored kernel with the pinned SHA-256 is kept and its path printed, and no bend runs", () => {
    const w = world();
    stubBend(w);
    pinIn(w, "lean.env", "BENDTT_SHA256", sha256(KERNEL));
    executable(join(cacheOf(w), "bendtt"), KERNEL);
    const run = bendSh(w, `kernel ${cacheOf(w)}`);
    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toBe(`${join(cacheOf(w), "bendtt")}\n`);
    expect(run.calls).toEqual([]);
  });

  test("a restored kernel with other bytes fails, is deleted, and no bend runs", () => {
    const w = world();
    stubBend(w);
    stubLean(w);
    pinIn(w, "lean.env", "BENDTT_SHA256", sha256(KERNEL));
    executable(join(cacheOf(w), "bendtt"), "#!/bin/sh\necho ALL PROOFS CHECK\n");
    const run = bendSh(w, `kernel ${cacheOf(w)}`, { lean: true });
    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/^::error::/m);
    expect(existsSync(join(cacheOf(w), "bendtt"))).toBe(false);
    expect(run.calls).toEqual([]);
  });

  test.each([
    ["passes", { out: PASS }, {}],
    [
      "exits 1 after building it",
      { out: "Error: BendTT infrastructure: kernel exited 1 without a verdict", status: 1 },
      {},
    ],
    ["runs with a $BENDTT already set", { out: PASS }, { BENDTT: "/usr/bin/false" }],
  ] as const)(
    "with none restored, bend builds one under a scratch HOME with the pinned Lean, and the one it built is copied in and its path alone printed, when bend %s",
    (_, kernelRun, env) => {
      const w = world();
      stubBend(w, { kernelRun });
      stubLean(w);
      pinIn(w, "lean.env", "BENDTT_SHA256", sha256(KERNEL));
      const run = bendSh(w, `kernel ${cacheOf(w)}`, { lean: true, env });
      expect(run.status, run.output).toBe(0);
      expect(run.stdout).toBe(`${join(cacheOf(w), "bendtt")}\n`);
      expect(readFileSync(join(cacheOf(w), "bendtt"), "utf8")).toBe(KERNEL);
      const built = builds(run.calls);
      expect(built).toHaveLength(1);
      expect(built[0]!.split(" ")[4]).not.toBe(w.home);
      expect(existsSync(join(w.home, ".bend"))).toBe(false);
      expect(verdicts(w, run.calls)).toEqual([]);
    },
  );

  test.each([
    ["another SHA-256", sha256("another kernel")],
    ["no pin", ""],
  ])("a built kernel with %s fails, names the hash it has, and is not copied", (_, pin) => {
    const w = world();
    stubBend(w);
    stubLean(w);
    pinIn(w, "lean.env", "BENDTT_SHA256", pin);
    const run = bendSh(w, `kernel ${cacheOf(w)}`, { lean: true });
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain(sha256(KERNEL));
    expect(existsSync(join(cacheOf(w), "bendtt"))).toBe(false);
  });

  test("with none restored and no pinned Lean on the PATH, kernel fails and runs no bend", () => {
    const w = world();
    stubBend(w);
    pinIn(w, "lean.env", "BENDTT_SHA256", sha256(KERNEL));
    const run = bendSh(w, `kernel ${cacheOf(w)}`);
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain(`Lean ${LEAN}`);
    expect(run.calls).toEqual([]);
  });

  test("a build that leaves no kernel fails and shows what bend said", () => {
    const w = world();
    const said = "Error: BendTT infrastructure: the kernel did not build (lean: boom)";
    stubBend(w, { kernel: null, kernelRun: { out: said, status: 1 } });
    stubLean(w);
    pinIn(w, "lean.env", "BENDTT_SHA256", sha256(KERNEL));
    const run = bendSh(w, `kernel ${cacheOf(w)}`, { lean: true });
    expect(run.status, run.output).toBe(1);
    expect(run.output).toContain(said);
    expect(existsSync(join(cacheOf(w), "bendtt"))).toBe(false);
  });

  test.each([
    ["no directory", ["kernel"]],
    ["an empty directory name", ["kernel", ""]],
    ["two directories", ["kernel", "a", "b"]],
    // The path it prints becomes $BENDTT, which must be absolute.
    ["a relative directory", ["kernel", "cache/bendtt"]],
  ])("kernel with %s is a usage error, exit 2, and runs no bend", (_, args) => {
    const w = world();
    stubBend(w);
    stubLean(w);
    pinIn(w, "lean.env", "BENDTT_SHA256", sha256(KERNEL));
    const run = bendSh(w, args, { lean: true });
    expect(run.status, run.output).toBe(2);
    expect(run.output).toContain("usage: bend.sh kernel <absolute dir>");
    expect(run.calls).toEqual([]);
  });
});

/** This platform as bend.sh names it: darwin-arm64, linux-x64, … */
const PLATFORM = TARGET.toLowerCase().replace("_", "-");

/**
 * A stub curl in the world's bin. It logs its arguments, answers with the
 * world's HTTP status (200 by default), writes the world's served bytes to
 * its `-o` file on a 200, prints the status as `-w '%{http_code}'` asks, or
 * exits with `exit` and writes nothing, as a connection failure does.
 */
function stubCurl(w: World, opts: { status?: number; served?: string; exit?: number } = {}) {
  const { status = 200, served = KERNEL, exit } = opts;
  writeFileSync(join(w.bin, "served"), served);
  writeFileSync(
    join(w.bin, "curl"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> "${w.bin}/curl.log"`,
      exit === undefined ? "" : `echo "curl: (7) Failed to connect" >&2; exit ${exit}`,
      'out=""',
      'while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; *) shift ;; esac; done',
      status === 200 ? `cp "${w.bin}/served" "$out"` : `echo "Not Found" > "$out"`,
      `printf '%s' ${status}`,
    ].join("\n"),
  );
  chmodSync(join(w.bin, "curl"), 0o755);
}

const curlCalls = (w: World) =>
  existsSync(join(w.bin, "curl.log"))
    ? readFileSync(join(w.bin, "curl.log"), "utf8").split("\n").filter(Boolean)
    : [];

describe("bend.sh fetch: CI's BendTT kernel from its release, only with the pinned SHA-256", () => {
  const dirOf = (w: World) => join(w.repo, "..", "fetched");
  /** A pin from the world's copy of a pin file, for this platform. */
  const pinOf = (w: World, file: "bend.env" | "lean.env", key: string) =>
    new RegExp(`^${key}_${TARGET}=(.*)$`, "m").exec(
      readFileSync(join(w.tools, file), "utf8"),
    )?.[1] ?? "";
  // The asset is named by all three pins the kernel is built from and checked
  // against, so a change to any of them names an asset nobody has published.
  const url = (w: World) => {
    const key = sha256(
      `${pinOf(w, "bend.env", "BEND_SHA256")}\n${pinOf(w, "lean.env", "LEAN_SHA256")}\n${sha256(KERNEL)}\n`,
    ).slice(0, 16);
    return `https://github.com/englishstreetventures/osn/releases/download/bendtt-${PINNED}-lean${LEAN}/bendtt-${PLATFORM}-${key}`;
  };

  test("the asset with the pinned SHA-256 is kept, runnable, and its path alone printed; it comes over https from the pinned tag and asset", () => {
    const w = world();
    stubBend(w);
    stubCurl(w);
    pinIn(w, "lean.env", "BENDTT_SHA256", sha256(KERNEL));
    const run = bendSh(w, `fetch ${dirOf(w)}`);
    expect(run.status, run.output).toBe(0);
    expect(run.stdout).toBe(`${join(dirOf(w), "bendtt")}\n`);
    expect(readFileSync(join(dirOf(w), "bendtt"), "utf8")).toBe(KERNEL);
    expect(spawnSync("test", ["-x", join(dirOf(w), "bendtt")]).status).toBe(0);
    const calls = curlCalls(w);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.endsWith(` ${url(w)}`), calls[0]).toBe(true);
    expect(calls[0]).toContain("--proto =https");
    expect(calls[0]).toContain("--retry 5 --retry-connrefused");
    // A 404 answers at once: the caller builds the kernel instead.
    expect(calls[0]).not.toContain("--retry-all-errors");
    expect(run.calls).toEqual([]);
  });

  test("an asset with other bytes, such as another platform's kernel, fails, names its hash, and nothing is kept", () => {
    const w = world();
    stubBend(w);
    const other = "#!/bin/sh\necho ALL PROOFS CHECK\n";
    stubCurl(w, { served: other });
    pinIn(w, "lean.env", "BENDTT_SHA256", sha256(KERNEL));
    const run = bendSh(w, `fetch ${dirOf(w)}`);
    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/^::error::/m);
    expect(run.output).toContain(sha256(other));
    expect(run.stdout).toBe("");
    expect(existsSync(join(dirOf(w), "bendtt"))).toBe(false);
    expect(existsSync(join(dirOf(w), "bendtt.part"))).toBe(false);
  });

  test("no asset published for these pins (404) exits 3, so the caller builds one, and nothing is kept", () => {
    const w = world();
    stubBend(w);
    stubCurl(w, { status: 404 });
    pinIn(w, "lean.env", "BENDTT_SHA256", sha256(KERNEL));
    const run = bendSh(w, `fetch ${dirOf(w)}`);
    expect(run.status, run.output).toBe(3);
    expect(run.stdout).toBe("");
    expect(existsSync(join(dirOf(w), "bendtt"))).toBe(false);
    expect(existsSync(join(dirOf(w), "bendtt.part"))).toBe(false);
  });

  test.each([
    ["any other HTTP status", { status: 503 }],
    ["a failed connection", { exit: 7 }],
    // curl's own 3 (a malformed URL) must not read as "not published".
    ["curl exiting 3", { exit: 3 }],
  ])("%s fails, exit 1, and nothing is kept", (_, opts) => {
    const w = world();
    stubBend(w);
    stubCurl(w, opts);
    pinIn(w, "lean.env", "BENDTT_SHA256", sha256(KERNEL));
    const run = bendSh(w, `fetch ${dirOf(w)}`);
    expect(run.status, run.output).toBe(1);
    expect(run.output).toMatch(/^::error::/m);
    expect(existsSync(join(dirOf(w), "bendtt"))).toBe(false);
  });

  test("asset prints the tag and asset name fetch reads, and fails with no pin", () => {
    const w = world();
    stubBend(w);
    pinIn(w, "lean.env", "BENDTT_SHA256", sha256(KERNEL));
    const run = bendSh(w, "asset");
    expect(run.status, run.output).toBe(0);
    const [tag, asset] = run.stdout.trim().split(" ");
    expect(url(w)).toEndWith(`/releases/download/${tag}/${asset}`);
    pinIn(w, "lean.env", "BENDTT_SHA256", "");
    const none = bendSh(w, "asset");
    expect(none.status, none.output).toBe(1);
    expect(none.stdout).toBe("");
  });

  test("on a platform lean.env pins no kernel for, fetch downloads nothing and exits 3", () => {
    const w = world();
    stubBend(w);
    stubCurl(w);
    pinIn(w, "lean.env", "BENDTT_SHA256", "");
    const run = bendSh(w, `fetch ${dirOf(w)}`);
    expect(run.status, run.output).toBe(3);
    expect(run.output).toContain(`pins no kernel for ${PLATFORM}`);
    expect(curlCalls(w)).toEqual([]);
  });

  test.each([
    ["no directory", ["fetch"]],
    ["a relative directory", ["fetch", "fetched"]],
    ["two directories", ["fetch", "/tmp/a", "/tmp/b"]],
  ])("fetch with %s is a usage error, exit 2, and downloads nothing", (_, args) => {
    const w = world();
    stubBend(w);
    stubCurl(w);
    pinIn(w, "lean.env", "BENDTT_SHA256", sha256(KERNEL));
    const run = bendSh(w, args);
    expect(run.status, run.output).toBe(2);
    expect(run.output).toContain("usage: bend.sh fetch <absolute dir>");
    expect(curlCalls(w)).toEqual([]);
  });
});

describe("bend.sh pin files", () => {
  // LEAN_VERSION names a directory under $HOME/.elan/toolchains/, and both
  // versions are checked before any command runs.
  test.each([
    ["lean.env", "LEAN_VERSION"],
    ["bend.env", "BEND_VERSION"],
  ] as const)(
    "a %s whose %s is not <n>.<n>.<n> fails every command before bend runs",
    (file, key) => {
      const w = world();
      stubBend(w);
      const env = join(w.tools, file);
      writeFileSync(
        env,
        readFileSync(env, "utf8").replace(new RegExp(`^${key}=.*$`, "m"), `${key}=../4.34.0`),
      );
      for (const command of ["sets", "check", "hook", "verdict"]) {
        const run = bendSh(w, command);
        expect({ command, status: run.status }).toEqual({ command, status: 1 });
        expect(run.output).toContain(`pins no ${key}=`);
      }
      expect(bendSh(w, "sets").calls).toEqual([]);
    },
  );
});
