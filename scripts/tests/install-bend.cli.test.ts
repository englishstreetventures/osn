// scripts/install-bend.sh, one test per way it can fail. The `bend-proofs` CI
// job runs the bend binary it unpacks, from a tarball the workflow restores
// from GitHub's cache or downloads, so a tarball that is not the pinned
// release must stop the job before anything is unpacked, whichever way it
// came. Each test runs the whole script with a stub `curl` on its PATH that
// serves a world's `served` file, or fails as a 504 does when there is none.

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

const INSTALL = join(import.meta.dir, "..", "install-bend.sh");
const VERSION = "2.0.40";
const TARGET = "linux-x64";
const FILE = `bend-${VERSION}-${TARGET}.tar.gz`;
const URL = `https://github.com/bendlang/bend/releases/download/v${VERSION}/${FILE}`;

const scratch = mkdtempSync(join(tmpdir(), "install-bend-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const sha256 = (bytes: Buffer) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** A real tarball laid out as a Bend release: bend/bin/bend, bend/bend2/, bend/guide/. */
function tarball(binary: string): Buffer {
  const at = mkdtempSync(join(scratch, "tar-"));
  for (const dir of ["bend/bin", "bend/bend2", "bend/guide"])
    mkdirSync(join(at, dir), { recursive: true });
  writeFileSync(join(at, "bend/bin/bend"), binary);
  chmodSync(join(at, "bend/bin/bend"), 0o755);
  writeFileSync(join(at, "bend/bend2/base.bend"), "import Base\n");
  writeFileSync(join(at, "bend/guide/GUIDE.md"), "# Bend\n");
  const made = spawnSync("tar", ["-czf", join(at, FILE), "-C", at, "bend"]);
  expect(made.status, String(made.stderr)).toBe(0);
  return readFileSync(join(at, FILE));
}

const GENUINE_BINARY = "#!/bin/sh\necho the pinned bend\n";
const GENUINE = tarball(GENUINE_BINARY);
// A valid tarball whose bend is another program: tar would unpack it.
const SWAPPED = tarball("#!/bin/sh\necho ALL PROOFS CHECK\n");
const PINNED = sha256(GENUINE);

interface World {
  readonly dir: string;
  readonly cache: string;
  readonly dest: string;
  readonly bin: string;
}

let next = 0;

function world(): World {
  next += 1;
  const dir = mkdtempSync(join(scratch, `case-${next}-`));
  const w: World = {
    dir,
    cache: join(dir, "cache"),
    dest: join(dir, "dest"),
    bin: join(dir, "bin"),
  };
  for (const at of [w.dest, w.bin]) mkdirSync(at, { recursive: true });
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
  chmodSync(join(w.bin, "curl"), 0o755);
  return w;
}

interface Run {
  readonly status: number | null;
  readonly output: string;
  /** Each curl call's arguments, one string per call. */
  readonly curl: readonly string[];
}

type Env = {
  readonly BEND_VERSION?: string;
  readonly BEND_TARGET?: string;
  readonly BEND_SHA256?: string;
};

function install(
  w: World,
  env: Env = { BEND_VERSION: VERSION, BEND_TARGET: TARGET, BEND_SHA256: PINNED },
  args: readonly string[] = [w.cache, w.dest],
): Run {
  const result = spawnSync("bash", [INSTALL, ...args], {
    cwd: w.dir,
    encoding: "utf8",
    env: { PATH: `${w.bin}:${process.env.PATH ?? ""}`, HOME: w.dir, ...env },
  });
  const log = join(w.dir, "curl.log");
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    curl: existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [],
  };
}

const cached = (w: World): string[] => (existsSync(w.cache) ? readdirSync(w.cache) : []);

describe("install-bend.sh", () => {
  test("a cached tarball with the pinned SHA-256 is unpacked, and nothing is downloaded", () => {
    const w = world();
    mkdirSync(w.cache);
    writeFileSync(join(w.cache, FILE), GENUINE);
    const run = install(w);
    expect(run.status, run.output).toBe(0);
    expect(readFileSync(join(w.dest, "bin/bend"), "utf8")).toBe(GENUINE_BINARY);
    expect(readdirSync(w.dest).toSorted()).toEqual(["bend2", "bin", "guide"]);
    expect(run.curl).toEqual([]);
  });

  test("a cached tarball with other bytes fails the step, is deleted, and nothing is unpacked or downloaded", () => {
    const w = world();
    mkdirSync(w.cache);
    writeFileSync(join(w.cache, FILE), SWAPPED);
    const run = install(w);
    expect(run.status, run.output).toBe(1);
    expect(readdirSync(w.dest)).toEqual([]);
    expect(cached(w)).toEqual([]);
    expect(run.curl).toEqual([]);
    expect(run.output).toMatch(/^::error::install-bend: /m);
  });

  test("with no cache, the release is downloaded over https with retries, left in the cache, and unpacked", () => {
    const w = world();
    writeFileSync(join(w.dir, "served"), GENUINE);
    const run = install(w);
    expect(run.status, run.output).toBe(0);
    expect(readFileSync(join(w.dest, "bin/bend"), "utf8")).toBe(GENUINE_BINARY);
    expect(cached(w)).toEqual([FILE]);
    expect(sha256(readFileSync(join(w.cache, FILE)))).toBe(PINNED);
    expect(run.curl).toHaveLength(1);
    const [call] = run.curl;
    expect(call?.endsWith(` ${URL}`), call).toBe(true);
    expect(call).toContain("--proto =https");
    expect(call).toContain("--retry 5 --retry-all-errors");
  });

  test("a downloaded tarball with other bytes fails the step, is deleted, and nothing is unpacked", () => {
    const w = world();
    writeFileSync(join(w.dir, "served"), SWAPPED);
    const run = install(w);
    expect(run.status, run.output).toBe(1);
    expect(readdirSync(w.dest)).toEqual([]);
    expect(cached(w)).toEqual([]);
    expect(run.output).toMatch(/^::error::install-bend: /m);
  });

  test("a download that fails fails the step, leaving nothing in the cache and nothing unpacked", () => {
    const w = world();
    const run = install(w);
    expect(run.status, run.output).toBe(1);
    expect(run.curl).toHaveLength(1);
    expect(readdirSync(w.dest)).toEqual([]);
    expect(cached(w)).toEqual([]);
    expect(run.output).toMatch(/^::error::install-bend: /m);
  });

  const full = { BEND_VERSION: VERSION, BEND_TARGET: TARGET, BEND_SHA256: PINNED };
  test.each([
    ["one argument", full, 1],
    ["no version", { BEND_TARGET: TARGET, BEND_SHA256: PINNED }, 2],
    ["no target", { BEND_VERSION: VERSION, BEND_SHA256: PINNED }, 2],
    ["no SHA-256", { BEND_VERSION: VERSION, BEND_TARGET: TARGET }, 2],
    ["a version that is not <n>.<n>.<n>", { ...full, BEND_VERSION: "../2.0.40" }, 2],
    ["a target Bend does not ship", { ...full, BEND_TARGET: "windows-x64" }, 2],
    ["a SHA-256 that is not 64 hex digits", { ...full, BEND_SHA256: "abc" }, 2],
  ] as const)("%s is a usage error, exit 2, and nothing is downloaded", (_, env, count) => {
    const w = world();
    writeFileSync(join(w.dir, "served"), GENUINE);
    const run = install(w, env, [w.cache, w.dest].slice(0, count));
    expect(run.status, run.output).toBe(2);
    expect(run.output).toContain("usage: ");
    expect(run.curl).toEqual([]);
    expect(readdirSync(w.dest)).toEqual([]);
  });
});
