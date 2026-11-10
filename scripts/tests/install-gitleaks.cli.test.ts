// scripts/install-gitleaks.sh, one test per way it can fail. The secret scan
// runs the gitleaks binary it unpacks, from a tarball the workflow restores
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

const INSTALL = join(import.meta.dir, "..", "install-gitleaks.sh");
const VERSION = "8.30.1";
const FILE = `gitleaks_${VERSION}_linux_x64.tar.gz`;
const URL = `https://github.com/gitleaks/gitleaks/releases/download/v${VERSION}/${FILE}`;

const scratch = mkdtempSync(join(tmpdir(), "install-gitleaks-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

const sha256 = (bytes: Buffer) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

/** A real tarball holding one file, `gitleaks`, with these contents. */
function tarball(binary: string): Buffer {
  const at = mkdtempSync(join(scratch, "tar-"));
  writeFileSync(join(at, "gitleaks"), binary);
  const made = spawnSync("tar", ["-czf", join(at, FILE), "-C", at, "gitleaks"]);
  expect(made.status, String(made.stderr)).toBe(0);
  return readFileSync(join(at, FILE));
}

const GENUINE_BINARY = "the pinned gitleaks\n";
const GENUINE = tarball(GENUINE_BINARY);
// A valid tarball whose `gitleaks` is another program: tar would unpack it.
const SWAPPED = tarball("a scanner that finds nothing\n");
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

function install(
  w: World,
  env: { readonly GITLEAKS_VERSION?: string; readonly GITLEAKS_SHA256?: string } = {
    GITLEAKS_VERSION: VERSION,
    GITLEAKS_SHA256: PINNED,
  },
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

describe("install-gitleaks.sh", () => {
  test("a cached tarball with the pinned SHA-256 is unpacked, and nothing is downloaded", () => {
    const w = world();
    mkdirSync(w.cache);
    writeFileSync(join(w.cache, FILE), GENUINE);
    const run = install(w);
    expect(run.status, run.output).toBe(0);
    expect(readFileSync(join(w.dest, "gitleaks"), "utf8")).toBe(GENUINE_BINARY);
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
    expect(run.output).toMatch(/^::error::install-gitleaks: /m);
  });

  test("with no cache, the release is downloaded with retries, left in the cache for the workflow to save, and unpacked", () => {
    const w = world();
    writeFileSync(join(w.dir, "served"), GENUINE);
    const run = install(w);
    expect(run.status, run.output).toBe(0);
    expect(readFileSync(join(w.dest, "gitleaks"), "utf8")).toBe(GENUINE_BINARY);
    expect(cached(w)).toEqual([FILE]);
    expect(sha256(readFileSync(join(w.cache, FILE)))).toBe(PINNED);
    expect(run.curl).toHaveLength(1);
    const [call] = run.curl;
    expect(call?.endsWith(` ${URL}`), call).toBe(true);
    expect(call).toContain("--retry 5 --retry-all-errors");
  });

  test("a downloaded tarball with other bytes fails the step, is deleted, and nothing is unpacked", () => {
    const w = world();
    writeFileSync(join(w.dir, "served"), SWAPPED);
    const run = install(w);
    expect(run.status, run.output).toBe(1);
    expect(readdirSync(w.dest)).toEqual([]);
    expect(cached(w)).toEqual([]);
    expect(run.output).toMatch(/^::error::install-gitleaks: /m);
  });

  test("a download that fails fails the step, leaving nothing in the cache and nothing unpacked", () => {
    const w = world();
    const run = install(w);
    expect(run.status, run.output).toBe(1);
    expect(run.curl).toHaveLength(1);
    expect(readdirSync(w.dest)).toEqual([]);
    expect(cached(w)).toEqual([]);
    expect(run.output).toMatch(/^::error::install-gitleaks: /m);
  });

  test.each([
    ["one argument", { GITLEAKS_VERSION: VERSION, GITLEAKS_SHA256: PINNED }, 1],
    ["no version", { GITLEAKS_SHA256: PINNED }, 2],
    ["no SHA-256", { GITLEAKS_VERSION: VERSION }, 2],
    [
      "a version that is not <n>.<n>.<n>",
      { GITLEAKS_VERSION: "../8.30.1", GITLEAKS_SHA256: PINNED },
      2,
    ],
    [
      "a SHA-256 that is not 64 hex digits",
      { GITLEAKS_VERSION: VERSION, GITLEAKS_SHA256: "abc" },
      2,
    ],
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
