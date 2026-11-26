// tools/bend/bend.sh, one test per way it can let a broken proof, a stale
// model or a bend that is not the pinned build through, prove fewer law sets
// than there are, run bend with its version ping on, or block someone it
// should not. CI's `bend-proofs` job runs `bend.sh sets` and `bend.sh check`,
// and lefthook's `bend-proofs` step runs `bend.sh hook`. Each test builds a
// scratch repository holding a copy of the script and the real bend.env, and
// two law sets, `osn/api/laws/one` and `cire/api/laws/two`, each with a
// committed model.mjs; a stub `bend` on the PATH answers `version`, proves or
// fails a set as the world says (exiting 1, or the status the world gives),
// builds a set's model from the world's text for it, and prints a guide;
// bend.env pins the stub's own SHA-256.

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
const SETS = ["cire/api/laws/two", "osn/api/laws/one"] as const;
const COMMITTED = (set: string) => `export default { set: "${set}" };\n`;
const TARGET = `${process.platform === "darwin" ? "DARWIN" : "LINUX"}_${process.arch === "arm64" ? "ARM64" : "X64"}`;
const sha256 = (bytes: Buffer) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

const scratch = mkdtempSync(join(tmpdir(), "bend-sh-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

interface World {
  readonly repo: string;
  readonly tools: string;
  readonly bin: string;
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
  mkdirSync(tools, { recursive: true });
  mkdirSync(bin);
  for (const file of ["bend.sh", "bend.env"]) copyFileSync(join(REAL, file), join(tools, file));
  for (const set of SETS) lawSet(repo, set);
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "fixture");
  return { repo, tools, bin, log: join(dir, "bend.log") };
}

/**
 * A stub bend. `PROOF.bend` fails in the sets named in `failing`; `model.bend
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
    builds?: Readonly<Record<string, string>>;
    pinned?: boolean;
  } = {},
) {
  const {
    version = `bend ${PINNED}`,
    failing = [],
    failStatus = 1,
    builds = {},
    pinned = true,
  } = opts;
  for (const set of SETS) {
    writeFileSync(join(w.bin, `${set.replaceAll("/", "_")}.out`), builds[set] ?? COMMITTED(set));
  }
  writeFileSync(join(w.bin, "failing"), failing.map((set) => `${join(w.repo, set)}\n`).join(""));
  writeFileSync(
    join(w.bin, "bend"),
    [
      "#!/usr/bin/env bash",
      `printf '%s %s %s\\n' "\${BEND_NO_TELEMETRY:-unset}" "$1" "$PWD" >> "${w.log}"`,
      `set=\${PWD#${w.repo}/}`,
      'case "$1" in',
      `  version) echo "${version}" ;;`,
      `  PROOF.bend) if grep -qx "$PWD" "${join(w.bin, "failing")}"; then echo "SOME PROOFS FAIL"; exit ${failStatus}; fi; echo "ALL PROOFS CHECK" ;;`,
      `  model.bend) cp "${w.bin}/\${set//\\//_}.out" "$3" ;;`,
      '  guide) echo "# Bend guide $2" ;;',
      "esac",
    ].join("\n"),
  );
  chmodSync(join(w.bin, "bend"), 0o755);
  if (pinned) {
    const env = join(w.tools, "bend.env");
    const digest = sha256(readFileSync(join(w.bin, "bend")));
    writeFileSync(
      env,
      readFileSync(env, "utf8").replace(
        new RegExp(`^BEND_BIN_SHA256_${TARGET}=.*$`, "m"),
        `BEND_BIN_SHA256_${TARGET}=${digest}`,
      ),
    );
  }
}

function bendSh(w: World, command: string, onPath = true) {
  const result = spawnSync("bash", [join(w.tools, "bend.sh"), ...command.split(" ")], {
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

/** The sets the stub proved, in order. */
const proved = (w: World, calls: readonly string[]) =>
  calls
    .filter((call) => call.split(" ")[1] === "PROOF.bend")
    .map((call) => call.split(" ")[2]!.slice(w.repo.length + 1));

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
    const run = bendSh(w, "prove", false);
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
    const run = bendSh(w, "hook", version !== undefined);
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
