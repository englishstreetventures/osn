// tools/bend/install-lean.sh, one test per way it can fail. The `bend-proofs`
// CI job builds the BendTT kernel with the Lean toolchain this script unpacks
// and puts on the PATH, so a tarball that is not the pinned release must stop
// the job before anything is unpacked. Each test runs the whole script with a
// stub `curl` on its PATH that serves a world's `served` file, or fails as a
// 504 does when there is none, and a stub `zstd` that decompresses with Bun,
// since not every machine has zstd.

import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const INSTALL = join(import.meta.dir, "..", "..", "tools", "bend", "install-lean.sh");
const VERSION = "4.34.0";
const TARGET = "linux-x64";
const DIR = `lean-${VERSION}-linux`;
const FILE = `${DIR}.tar.zst`;
const URL = `https://github.com/leanprover/lean4/releases/download/v${VERSION}/${FILE}`;

const scratch = mkdtempSync(join(tmpdir(), "install-lean-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const sha256 = (bytes: Buffer | Uint8Array) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** A real .tar.zst laid out as a Lean release: <dir>/bin/{lean,leanc}, lib/, src/. */
function tarball(dir: string, bins: readonly string[] = ["lean", "leanc"]): Buffer {
  const at = mkdtempSync(join(scratch, "tar-"));
  for (const sub of ["bin", "lib/lean", "src/lean"])
    mkdirSync(join(at, dir, sub), { recursive: true });
  for (const bin of bins) {
    writeFileSync(join(at, dir, "bin", bin), `#!/bin/sh\necho ${bin} ${VERSION}\n`);
    chmodSync(join(at, dir, "bin", bin), 0o755);
  }
  writeFileSync(join(at, dir, "lib/lean/Init.olean"), "olean\n");
  writeFileSync(join(at, dir, "src/lean/Init.lean"), "-- source\n");
  // COPYFILE_DISABLE: macOS tar would add AppleDouble `._` entries.
  const made = spawnSync("tar", ["-cf", join(at, "lean.tar"), "-C", at, dir], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
  expect(made.status, String(made.stderr)).toBe(0);
  return Buffer.from(Bun.zstdCompressSync(readFileSync(join(at, "lean.tar"))));
}

const GENUINE = tarball(DIR);
// A valid tarball with another toolchain's bytes: tar would unpack it.
const SWAPPED = tarball(DIR, ["lean", "leanc", "extra"]);
const NO_LEANC = tarball(DIR, ["lean"]);
const PINNED = sha256(GENUINE);

interface World {
  readonly dir: string;
  readonly dest: string;
  readonly bin: string;
  readonly tmp: string;
}

let next = 0;

function world(): World {
  next += 1;
  const dir = mkdtempSync(join(scratch, `case-${next}-`));
  const w: World = { dir, dest: join(dir, "lean"), bin: join(dir, "bin"), tmp: join(dir, "tmp") };
  for (const at of [w.bin, w.tmp]) mkdirSync(at, { recursive: true });
  writeFileSync(
    join(w.bin, "curl"),
    [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$*" >> "${dir}/curl.log"`,
      'out=""',
      'while [ $# -gt 0 ]; do case "$1" in -o) out=$2; shift 2 ;; *) shift ;; esac; done',
      `if [ ! -f "${dir}/served" ]; then echo "curl: (22) The requested URL returned error: 504" >&2; exit 22; fi`,
      `cp "${dir}/served" "$out"`,
    ].join("\n"),
  );
  // `zstd -dc <file>`: the only form the script uses.
  writeFileSync(
    join(w.bin, "zstd"),
    [
      "#!/usr/bin/env bash",
      '[ "$1" = "-dc" ] || exit 64',
      `exec "${process.execPath}" -e 'process.stdout.write(Bun.zstdDecompressSync(require("fs").readFileSync(process.argv[1])))' "$2"`,
    ].join("\n"),
  );
  for (const stub of ["curl", "zstd"]) chmodSync(join(w.bin, stub), 0o755);
  return w;
}

interface Run {
  readonly status: number | null;
  readonly output: string;
  /** Each curl call's arguments, one string per call. */
  readonly curl: readonly string[];
}

type Env = {
  readonly LEAN_VERSION?: string;
  readonly LEAN_TARGET?: string;
  readonly LEAN_SHA256?: string;
};

const FULL: Env = { LEAN_VERSION: VERSION, LEAN_TARGET: TARGET, LEAN_SHA256: PINNED };

function install(w: World, env: Env = FULL, args: readonly string[] = [w.dest]): Run {
  const result = spawnSync("bash", [INSTALL, ...args], {
    cwd: w.dir,
    encoding: "utf8",
    env: { PATH: `${w.bin}:/usr/bin:/bin`, HOME: w.dir, TMPDIR: w.tmp, ...env },
  });
  const log = join(w.dir, "curl.log");
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    curl: existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [],
  };
}

describe("install-lean.sh", () => {
  test("the pinned release is downloaded over https with retries, unpacked without its sources, and not left behind", () => {
    const w = world();
    writeFileSync(join(w.dir, "served"), GENUINE);
    const run = install(w);
    expect(run.status, run.output).toBe(0);
    expect(readFileSync(join(w.dest, "bin/lean"), "utf8")).toContain("lean ");
    expect(readFileSync(join(w.dest, "bin/leanc"), "utf8")).toContain("leanc ");
    expect(existsSync(join(w.dest, "lib/lean/Init.olean"))).toBe(true);
    expect(existsSync(join(w.dest, "src"))).toBe(false);
    expect(readdirSync(w.tmp)).toEqual([]);
    expect(run.curl).toHaveLength(1);
    const [call] = run.curl;
    expect(call?.endsWith(` ${URL}`), call).toBe(true);
    expect(call).toContain("--proto =https");
    expect(call).toContain("--retry 5 --retry-all-errors");
  });

  test.each([
    ["linux-arm64", "linux_aarch64"],
    ["darwin-x64", "darwin"],
    ["darwin-arm64", "darwin_aarch64"],
  ])("target %s downloads Lean's %s build", (target, suffix) => {
    const w = world();
    const dir = `lean-${VERSION}-${suffix}`;
    const served = tarball(dir);
    writeFileSync(join(w.dir, "served"), served);
    const run = install(w, { ...FULL, LEAN_TARGET: target, LEAN_SHA256: sha256(served) });
    expect(run.status, run.output).toBe(0);
    expect(run.curl[0]?.endsWith(`/v${VERSION}/${dir}.tar.zst`), run.curl[0]).toBe(true);
    expect(existsSync(join(w.dest, "bin/lean"))).toBe(true);
  });

  test("a downloaded tarball with other bytes fails, is deleted, and nothing is unpacked", () => {
    const w = world();
    writeFileSync(join(w.dir, "served"), SWAPPED);
    const run = install(w);
    expect(run.status, run.output).toBe(1);
    expect(existsSync(w.dest)).toBe(false);
    expect(readdirSync(w.tmp)).toEqual([]);
    expect(run.output).toMatch(/^::error::install-lean: /m);
  });

  test("a download that fails fails the step and leaves nothing behind", () => {
    const w = world();
    const run = install(w);
    expect(run.status, run.output).toBe(1);
    expect(run.curl).toHaveLength(1);
    expect(existsSync(w.dest)).toBe(false);
    expect(readdirSync(w.tmp)).toEqual([]);
    expect(run.output).toMatch(/^::error::install-lean: /m);
  });

  test("a pinned tarball that holds no leanc fails and installs nothing", () => {
    const w = world();
    writeFileSync(join(w.dir, "served"), NO_LEANC);
    const run = install(w, { ...FULL, LEAN_SHA256: sha256(NO_LEANC) });
    expect(run.status, run.output).toBe(1);
    expect(existsSync(w.dest)).toBe(false);
    expect(run.output).toContain("bin/leanc");
  });

  test.each([
    ["no argument", FULL, 0],
    ["two arguments", FULL, 2],
    ["no version", { LEAN_TARGET: TARGET, LEAN_SHA256: PINNED }, 1],
    ["no target", { LEAN_VERSION: VERSION, LEAN_SHA256: PINNED }, 1],
    ["no SHA-256", { LEAN_VERSION: VERSION, LEAN_TARGET: TARGET }, 1],
    ["a version that is not <n>.<n>.<n>", { ...FULL, LEAN_VERSION: "../4.34.0" }, 1],
    ["a target Lean is not pinned for", { ...FULL, LEAN_TARGET: "windows-x64" }, 1],
    ["a SHA-256 that is not 64 hex digits", { ...FULL, LEAN_SHA256: "abc" }, 1],
  ] as const)("%s is a usage error, exit 2, and nothing is downloaded", (_, env, count) => {
    const w = world();
    writeFileSync(join(w.dir, "served"), GENUINE);
    const run = install(w, env, [w.dest, w.dest].slice(0, count));
    expect(run.status, run.output).toBe(2);
    expect(run.output).toContain("usage: ");
    expect(run.curl).toEqual([]);
    expect(existsSync(w.dest)).toBe(false);
  });

  test("a destination that already exists is a usage error, and it is left alone", () => {
    const w = world();
    writeFileSync(join(w.dir, "served"), GENUINE);
    mkdirSync(w.dest);
    writeFileSync(join(w.dest, "keep"), "mine\n");
    const run = install(w);
    expect(run.status, run.output).toBe(2);
    expect(run.curl).toEqual([]);
    expect(readdirSync(w.dest)).toEqual(["keep"]);
  });
});
