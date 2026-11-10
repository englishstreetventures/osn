// scripts/install-chromium-system-libraries.sh, one test per way a cached
// package could reach apt unchecked (NEW-FEAT.md V1–V7). The script runs as
// root in CI and puts packages from a cache in apt's archive, from which apt
// installs them; a cache is restored from GitHub's store, so it is input, not
// trust. Each test runs the whole script against a fake apt (fake-apt.ts) that
// installs whatever it finds in the archive, and checks that only bytes the
// signed index names got there, and that apt downloaded the rest.

import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Each run starts bash, retry.sh and a Bun process per fake apt call; the
// limit is the backstop for one that hangs, as a FIFO read would.
setDefaultTimeout(30_000);

const INSTALL = join(import.meta.dir, "..", "install-chromium-system-libraries.sh");
const FAKE_APT = join(import.meta.dir, "fake-apt.ts");

const scratch = mkdtempSync(join(tmpdir(), "chromium-apt-"));

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** One package the mirror holds. */
interface Pkg {
  readonly name: string;
  readonly version: string;
  readonly arch: string;
  /** Whether install-deps installs it. Default true. */
  readonly needed?: boolean;
}

/** The file name apt gives a package in its archive: `:` in a version is `%3a`. */
const fileOf = (pkg: Pkg) => `${pkg.name}_${pkg.version.replaceAll(":", "%3a")}_${pkg.arch}.deb`;

/** The mirror's bytes for a package: unique to its name, version and architecture. */
const bytesOf = (pkg: Pkg) => `deb ${pkg.name} ${pkg.version} ${pkg.arch}\n`;

const sha256 = (bytes: string | Buffer) =>
  new Bun.CryptoHasher("sha256").update(bytes).digest("hex");

interface World {
  readonly dir: string;
  readonly cache: string;
  readonly archives: string;
  readonly work: string;
  readonly bin: string;
}

let next = 0;

/** A fake runner: the mirror and its signed index, an empty archive, and stubs on a PATH of its own. */
function world(mirror: readonly Pkg[]): World {
  next += 1;
  const dir = mkdtempSync(join(scratch, `case-${next}-`));
  const w: World = {
    dir,
    cache: join(dir, "cache"),
    archives: join(dir, "root", "var", "cache", "apt", "archives"),
    work: join(dir, "work"),
    bin: join(dir, "bin"),
  };
  for (const at of [
    w.cache,
    w.archives,
    w.work,
    w.bin,
    join(dir, "mirror"),
    join(dir, "root", "etc", "apt", "apt.conf.d"),
  ]) {
    mkdirSync(at, { recursive: true });
  }
  const index = mirror.map((pkg) =>
    [
      `Package: ${pkg.name}`,
      `Architecture: ${pkg.arch}`,
      `Version: ${pkg.version}`,
      `Filename: pool/main/${pkg.name[0]}/${pkg.name}/${fileOf(pkg)}`,
      `Size: ${bytesOf(pkg).length}`,
      `SHA256: ${sha256(bytesOf(pkg))}`,
    ].join("\n"),
  );
  writeFileSync(join(dir, "mirror", "Packages"), `${index.join("\n\n")}\n`);
  for (const pkg of mirror) writeFileSync(join(dir, "mirror", fileOf(pkg)), bytesOf(pkg));
  writeFileSync(
    join(dir, "needed"),
    mirror
      .filter((pkg) => pkg.needed !== false)
      .map((pkg) => `${fileOf(pkg)}\n`)
      .join(""),
  );
  writeFileSync(join(dir, "log"), "");
  const stub = (tool: string, body: string) => {
    writeFileSync(join(w.bin, tool), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(w.bin, tool), 0o755);
  };
  // The runner user's sudo runs the command as root; here it just runs it.
  stub("sudo", 'exec "$@"');
  for (const tool of ["apt-get", "apt-cache", "dpkg", "bunx"]) {
    stub(tool, `exec "${process.execPath}" "${FAKE_APT}" "${dir}" ${tool} "$@"`);
  }
  return w;
}

/** Puts a file in the cache under `file`, holding `bytes`. */
const cacheFile = (w: World, file: string, bytes: string) =>
  writeFileSync(join(w.cache, file), bytes);

interface Run {
  readonly status: number | null;
  readonly output: string;
  readonly log: readonly string[];
  /** What the archive held when install-deps ran. */
  readonly archiveAtInstall: readonly string[];
  /** Each file installed: the SHA-256 of the bytes apt took, and where it took them from. */
  readonly installed: ReadonlyMap<string, { readonly sha: string; readonly from: string }>;
  readonly downloaded: readonly string[];
}

function install(w: World): Run {
  const result = spawnSync("bash", [INSTALL, w.cache], {
    cwd: w.work,
    encoding: "utf8",
    env: {
      PATH: `${w.bin}:${process.env.PATH ?? ""}`,
      HOME: process.env.HOME ?? w.dir,
      TMPDIR: tmpdir(),
      CHROMIUM_APT_ROOT: join(w.dir, "root"),
    },
  });
  const log = readFileSync(join(w.dir, "log"), "utf8").split("\n").filter(Boolean);
  const installed = new Map<string, { sha: string; from: string }>();
  for (const line of log) {
    const [word, file, sha, from] = line.split(" ");
    if (word === "installed" && file !== undefined && sha !== undefined && from !== undefined) {
      installed.set(file, { sha, from });
    }
  }
  return {
    status: result.status,
    output: `${result.stdout}${result.stderr}`,
    log,
    archiveAtInstall: log
      .filter((line) => line.startsWith("archive "))
      .map((line) => line.slice(8)),
    installed,
    downloaded: log.filter((line) => line.startsWith("downloaded ")).map((line) => line.slice(11)),
  };
}

/** Each needed package was installed with the mirror's bytes, from `from`. */
function expectGenuine(run: Run, expected: ReadonlyArray<readonly [Pkg, "archive" | "network"]>) {
  expect(Object.fromEntries(run.installed), run.output).toEqual(
    Object.fromEntries(
      expected.map(([pkg, from]) => [fileOf(pkg), { sha: sha256(bytesOf(pkg)), from }]),
    ),
  );
}

const ALPHA: Pkg = { name: "fonts-alpha", version: "1.0-1", arch: "all" };
const EPOCH: Pkg = { name: "fonts-epoch", version: "2:3.1-4ubuntu1", arch: "all" };
const BETA: Pkg = { name: "fonts-beta", version: "1.0", arch: "all" };
const GAMMA: Pkg = { name: "fonts-gamma", version: "1.0", arch: "all" };
const LIB64: Pkg = { name: "libfoo1", version: "1.0", arch: "amd64" };
const LIB32: Pkg = { name: "libfoo1", version: "1.0", arch: "i386", needed: false };

describe("install-chromium-system-libraries.sh", () => {
  test("V1: a cached package whose bytes the signed index names, one with an epoch among them, is installed from the archive and not downloaded", () => {
    const w = world([ALPHA, EPOCH]);
    cacheFile(w, fileOf(ALPHA), bytesOf(ALPHA));
    cacheFile(w, fileOf(EPOCH), bytesOf(EPOCH));
    const run = install(w);
    expect(run.status, run.output).toBe(0);
    expectGenuine(run, [
      [ALPHA, "archive"],
      [EPOCH, "archive"],
    ]);
    expect(run.downloaded).toEqual([]);
    // The fake apt-cache knows nothing until `apt-get update` has run, so the
    // check read the index the attempt had just fetched.
    expect(run.log.indexOf("apt-get update")).toBeLessThan(
      run.log.findIndex((line) => line.startsWith("apt-cache show")),
    );
    expect(run.log).toContain(`apt-cache show ${EPOCH.name}=${EPOCH.version}`);
  });

  test("V2: a tampered package is dropped with a warning naming it, apt downloads it, and the install and the cache saved after it hold the mirror's bytes", () => {
    const w = world([ALPHA, BETA]);
    cacheFile(w, fileOf(ALPHA), bytesOf(ALPHA));
    cacheFile(w, fileOf(BETA), "a package someone changed\n");
    const run = install(w);
    expect(run.status, run.output).toBe(0);
    expect(run.archiveAtInstall).toEqual([fileOf(ALPHA)]);
    expectGenuine(run, [
      [ALPHA, "archive"],
      [BETA, "network"],
    ]);
    expect(run.downloaded).toEqual([fileOf(BETA)]);
    expect(run.output).toMatch(new RegExp(`^::warning::.*dropped ${fileOf(BETA)}`, "m"));
    expect(readFileSync(join(w.cache, fileOf(BETA)), "utf8")).toBe(bytesOf(BETA));
    expect(readFileSync(join(w.cache, fileOf(ALPHA)), "utf8")).toBe(bytesOf(ALPHA));
  });

  test("V3: a cached package of a version the index no longer lists is dropped, and apt downloads the version it does", () => {
    const old: Pkg = { ...BETA, version: "0.9" };
    const w = world([BETA]);
    cacheFile(w, fileOf(old), bytesOf(old));
    const run = install(w);
    expect(run.status, run.output).toBe(0);
    expect(run.archiveAtInstall).toEqual([]);
    expectGenuine(run, [[BETA, "network"]]);
    expect(run.output).toMatch(new RegExp(`^::warning::.*dropped ${fileOf(old)}`, "m"));
  });

  test("V4: a cached package holding the bytes the index names for another architecture is dropped", () => {
    const w = world([LIB64, LIB32]);
    cacheFile(w, fileOf(LIB64), bytesOf(LIB32));
    const run = install(w);
    expect(run.status, run.output).toBe(0);
    expect(run.archiveAtInstall).toEqual([]);
    expectGenuine(run, [[LIB64, "network"]]);
  });

  test("V5: a file whose name is not <name>_<version>_<arch>.deb is dropped without running or printing what its name holds", () => {
    const w = world([ALPHA]);
    const bad = [
      "evil.deb",
      "fonts-alpha_1.0-1.deb",
      "Fonts-Alpha_1.0-1_all.deb",
      "fonts-alpha_1%2e0-1_all.deb",
      "$(touch pwned)_1.0_all.deb",
      "fonts-alpha_1.0-1_all\n::error::pwned_1.0_all.deb",
    ];
    for (const file of bad) cacheFile(w, file, bytesOf(ALPHA));
    const run = install(w);
    expect(run.status, run.output).toBe(0);
    expect(run.archiveAtInstall).toEqual([]);
    expectGenuine(run, [[ALPHA, "network"]]);
    expect(existsSync(join(w.work, "pwned"))).toBe(false);
    expect(readdirSync(w.work)).toEqual([]);
    // A workflow command starts a line; no line here may be one a name wrote.
    expect(run.output).not.toContain("::error::");
    expect(run.output.match(/^::warning::/gm)?.length, run.output).toBe(bad.length);
    // A % in a name is escaped as workflow-command data, so it shows as written.
    expect(run.output).toContain("dropped fonts-alpha_1%252e0-1_all.deb");
  });

  test("V6: a cache entry named as a genuine package that is a symlink, a FIFO or a directory is dropped, and the run does not hang on it", () => {
    const w = world([ALPHA, BETA, GAMMA]);
    // The symlink's target holds the genuine bytes: only the kind of entry is wrong.
    symlinkSync(join(w.dir, "mirror", fileOf(ALPHA)), join(w.cache, fileOf(ALPHA)));
    expect(spawnSync("mkfifo", [join(w.cache, fileOf(BETA))]).status).toBe(0);
    mkdirSync(join(w.cache, fileOf(GAMMA)));
    const from = performance.now();
    const run = install(w);
    expect(run.status, run.output).toBe(0);
    expect(performance.now() - from).toBeLessThan(20_000);
    expect(run.archiveAtInstall).toEqual([]);
    expectGenuine(run, [
      [ALPHA, "network"],
      [BETA, "network"],
      [GAMMA, "network"],
    ]);
    expect(run.output.match(/^::warning::.*not a regular file/gm)?.length, run.output).toBe(3);
  });

  test("V7: the bytes checked are the bytes copied: a copy that differs from the cached file is dropped", () => {
    const w = world([ALPHA]);
    cacheFile(w, fileOf(ALPHA), bytesOf(ALPHA));
    // A cp that writes other bytes whenever it copies out of the cache, as a
    // file changed between its check and its copy would.
    writeFileSync(
      join(w.bin, "cp"),
      [
        "#!/usr/bin/env bash",
        "src=${*: -2:1}; dest=${*: -1}",
        `case "$src" in "${w.cache}"/*) [ -d "$dest" ] && dest="$dest/$(basename "$src")"; printf 'changed\\n' > "$dest"; exit 0 ;; esac`,
        'exec /bin/cp "$@"',
      ].join("\n"),
    );
    chmodSync(join(w.bin, "cp"), 0o755);
    const run = install(w);
    expect(run.status, run.output).toBe(0);
    expect(run.archiveAtInstall).toEqual([]);
    expectGenuine(run, [[ALPHA, "network"]]);
  });
});
