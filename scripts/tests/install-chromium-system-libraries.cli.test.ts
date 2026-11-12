// scripts/install-chromium-system-libraries.sh, one test per way a cached
// package could reach apt unchecked, or the cache the workflow saves could
// end up wrong. The script runs as root in CI and puts packages from a cache
// in apt's archive, from which apt installs them; a cache is restored from
// GitHub's store, so it is input, not trust. Each test runs the whole script
// against a fake apt (fake-apt.ts) that installs whatever it finds in the
// archive, and checks that only bytes the signed index names got there, that
// apt downloaded the rest, and what the cache holds afterwards.

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
  /**
   * The architecture variant apt names the file by, as on an Ubuntu 26.04
   * runner, whose apt writes `_amd64v3.deb` for a package whose record says
   * `Architecture: amd64`. Default: the architecture itself.
   */
  readonly variant?: string;
  /** Whether install-deps installs it. Default true. */
  readonly needed?: boolean;
}

/** The file name apt gives a package in its archive: `:` in a version is `%3a`. */
const fileOf = (pkg: Pkg) =>
  `${pkg.name}_${pkg.version.replaceAll(":", "%3a")}_${pkg.variant ?? pkg.arch}.deb`;

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

/**
 * A fake runner: the mirror and its signed index, an empty archive, and stubs
 * on a PATH of its own. The cache is the directory `cacheName` in it.
 */
function world(mirror: readonly Pkg[], cacheName = "cache"): World {
  next += 1;
  const dir = mkdtempSync(join(scratch, `case-${next}-`));
  const w: World = {
    dir,
    cache: join(dir, cacheName),
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

/** Each file in the cache and the bytes it holds. */
const cacheContents = (w: World) =>
  Object.fromEntries(
    readdirSync(w.cache).map((file) => [file, readFileSync(join(w.cache, file), "utf8")]),
  );

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

/** The prefix of the one warning the script prints when it carries on without apt. */
const SKIPPED = "::warning::install-chromium-system-libraries: skipped apt: ";

/** The start of the line the script prints when it fails rather than carry on without apt. */
const NOT_SKIPPED = "install-chromium-system-libraries: not skipped: ";

/**
 * What `apt-get update` printed in each attempt of ci.yml run 43054765174 on
 * 2026-11-11, when the runner could resolve none of Ubuntu's mirrors: one
 * other repository answered, the Ubuntu ones never did.
 */
const UNREACHABLE = [
  "Get:6 https://packages.microsoft.com/ubuntu/26.04/prod resolute InRelease [3964 B]",
  "Ign:2 http://azure.archive.ubuntu.com/ubuntu resolute InRelease",
  "Err:2 https://security.ubuntu.com/ubuntu resolute InRelease",
  "  Temporary failure resolving 'azure.archive.ubuntu.com'",
  "  Temporary failure resolving 'archive.ubuntu.com'",
  "  Temporary failure resolving 'security.ubuntu.com'",
  "",
].join("\n");

/** apt's own words for an index it fetched and could not trust (methods/gpgv.cc, apt-pkg/acquire-item.cc). */
const UNTRUSTED: Readonly<Record<string, string>> = {
  NO_PUBKEY: [
    "Err:6 https://packages.microsoft.com/ubuntu/26.04/prod resolute InRelease",
    "  The following signatures couldn't be verified because the public key is not available: NO_PUBKEY EB3E94ADBE1229CF",
    "",
  ].join("\n"),
  BADSIG: [
    "Err:6 https://packages.microsoft.com/ubuntu/26.04/prod resolute InRelease",
    "  The following signatures were invalid: BADSIG EB3E94ADBE1229CF Microsoft (Release signing) <gpgsecurity@microsoft.com>",
    "",
  ].join("\n"),
  "Hash Sum mismatch": [
    "E: Failed to fetch https://packages.microsoft.com/ubuntu/26.04/prod/dists/resolute/main/binary-amd64/Packages.bz2  Hash Sum mismatch",
    "   Hashes of expected file:",
    "    - SHA256:0000000000000000000000000000000000000000000000000000000000000000",
    "",
  ].join("\n"),
};

/**
 * What `apt-get update` warns when an index fails its signature check and apt
 * holds an older copy: it keeps that copy (apt-pkg/acquire-item.cc).
 */
const UNTRUSTED_KEPT = [
  "Err:2 http://azure.archive.ubuntu.com/ubuntu resolute InRelease",
  "  The following signatures were invalid: BADSIG 871920D1991BC93C Ubuntu Archive Automatic Signing Key (2018) <ftpmaster@ubuntu.com>",
  "W: An error occurred during the signature verification. The repository is not updated and the previous index files will be used. OpenPGP signature verification failed: http://azure.archive.ubuntu.com/ubuntu resolute InRelease: The following signatures were invalid: BADSIG 871920D1991BC93C Ubuntu Archive Automatic Signing Key (2018) <ftpmaster@ubuntu.com>",
  "",
].join("\n");

/** Makes every `apt-get update` print `text` and fail without an index. */
const unreachable = (w: World, text: string) => writeFileSync(join(w.dir, "update-fails"), text);

describe("install-chromium-system-libraries.sh", () => {
  test("a cached package whose bytes the signed index names, one with an epoch among them, is installed from the archive and not downloaded", () => {
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
    // A mirror apt reaches installs as it always has: no dry run, no warning.
    expect(run.log).not.toContain("install-deps --dry-run");
    expect(run.output).not.toMatch(/^::warning::/m);
    // Without the first line apt deletes what it downloads and the cache saves
    // nothing. The second spares each connection a DNS query no mirror answers;
    // when names do not resolve, that query is half the wait. The third makes an
    // index that fails its signature check fail the update, where apt would
    // otherwise keep the old copy and carry on. Retries and timeouts are the
    // image's own (zz-retries), which apt reads after this file.
    expect(
      readFileSync(join(w.dir, "root", "etc", "apt", "apt.conf.d", "80-ci-chromium"), "utf8"),
    ).toBe(
      [
        'APT::Keep-Downloaded-Packages "true";',
        'Acquire::EnableSrvRecords "false";',
        'APT::Update::Auth-Failure { "false"; };',
        "",
      ].join("\n"),
    );
  });

  test("a tampered package is dropped with a warning naming it, apt downloads it, and the install and the cache saved after it hold the mirror's bytes", () => {
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

  test("a cached package of a version the index no longer lists is dropped, apt downloads the version it does, and the cache saved after it holds only that one", () => {
    const old: Pkg = { ...BETA, version: "0.9" };
    const w = world([BETA]);
    cacheFile(w, fileOf(old), bytesOf(old));
    const run = install(w);
    expect(run.status, run.output).toBe(0);
    expect(run.archiveAtInstall).toEqual([]);
    expectGenuine(run, [[BETA, "network"]]);
    expect(run.output).toMatch(new RegExp(`^::warning::.*dropped ${fileOf(old)}`, "m"));
    // A superseded version left in the cache would be saved with it, run after run.
    expect(readdirSync(w.cache)).toEqual([fileOf(BETA)]);
    expect(readFileSync(join(w.cache, fileOf(BETA)), "utf8")).toBe(bytesOf(BETA));
  });

  test("an install that fails on every attempt fails the step after three, and leaves the cache as it found it", () => {
    const old: Pkg = { ...BETA, version: "0.9" };
    const w = world([ALPHA, BETA]);
    cacheFile(w, fileOf(ALPHA), bytesOf(ALPHA));
    cacheFile(w, fileOf(old), bytesOf(old));
    writeFileSync(join(w.dir, "fail"), "");
    const before = cacheContents(w);
    const run = install(w);
    // apt's own status, through retry.sh and out of the step.
    expect(run.status, run.output).toBe(100);
    expect(run.log.filter((line) => line === "install-deps")).toHaveLength(3);
    expect(run.output.match(/^::warning::retry\.sh: /gm)?.length, run.output).toBe(3);
    expect(run.output.match(/^::error::/gm)?.length, run.output).toBe(1);
    expect(run.output).not.toContain("kept for the cache");
    // Neither emptied nor swapped for a partial archive the E2E job would save.
    expect(cacheContents(w)).toEqual(before);
  });

  test("a cached package holding the bytes the index names for another architecture is dropped", () => {
    const w = world([LIB64, LIB32]);
    cacheFile(w, fileOf(LIB64), bytesOf(LIB32));
    const run = install(w);
    expect(run.status, run.output).toBe(0);
    expect(run.archiveAtInstall).toEqual([]);
    expectGenuine(run, [[LIB64, "network"]]);
  });

  test("a cached package that apt named by its architecture variant (amd64v3) is kept when the index names its bytes under the base architecture (amd64)", () => {
    const UTILS: Pkg = {
      name: "xfonts-utils",
      version: "1:7.7+7build1",
      arch: "amd64",
      variant: "amd64v3",
    };
    const w = world([UTILS, ALPHA]);
    cacheFile(w, fileOf(UTILS), bytesOf(UTILS));
    cacheFile(w, fileOf(ALPHA), bytesOf(ALPHA));
    const run = install(w);
    expect(run.status, run.output).toBe(0);
    expectGenuine(run, [
      [UTILS, "archive"],
      [ALPHA, "archive"],
    ]);
    expect(run.downloaded).toEqual([]);
    expect(run.output).not.toContain("::warning::");
  });

  test("a variant's name earns nothing more: one holding another architecture's bytes, or naming no variant of the record's architecture, is dropped", () => {
    const LIB64V3: Pkg = { ...LIB64, variant: "amd64v3" };
    const w = world([LIB64V3, LIB32]);
    cacheFile(w, fileOf(LIB64V3), bytesOf(LIB32));
    // The genuine amd64 bytes, under names that are not amd64 or a variant of it.
    cacheFile(w, "libfoo1_1.0_amd64x.deb", bytesOf(LIB64));
    cacheFile(w, "libfoo1_1.0_amd64v.deb", bytesOf(LIB64));
    const run = install(w);
    expect(run.status, run.output).toBe(0);
    expect(run.archiveAtInstall).toEqual([]);
    expectGenuine(run, [[LIB64V3, "network"]]);
    expect(run.output.match(/^::warning::/gm)?.length, run.output).toBe(3);
  });

  test("a file whose name is not <name>_<version>_<arch>.deb is dropped without running or printing what its name holds", () => {
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

  test("a cache entry named as a genuine package that is a symlink, a FIFO or a directory is dropped, and the run does not hang on it", () => {
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

  test("the bytes checked are the bytes copied: a copy that differs from the cached file is dropped", () => {
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

  test("an index that fails its signature check where apt holds an older copy fails every update, so no cached package is checked against that copy or installed, and the step fails saying why", () => {
    const w = world([ALPHA]);
    indexOnDisk(w);
    cacheFile(w, fileOf(ALPHA), bytesOf(ALPHA));
    writeFileSync(join(w.dir, "update-untrusted"), UNTRUSTED_KEPT);
    const before = cacheContents(w);
    const run = install(w);
    expect(run.status, run.output).toBe(100);
    expect(run.log.filter((line) => line === "apt-get update")).toHaveLength(3);
    expect(
      run.log.filter((line) => line.startsWith("apt-cache show") || line === "install-deps"),
    ).toEqual([]);
    expect(run.installed.size).toBe(0);
    expect(run.log).not.toContain("install-deps --dry-run");
    expect(run.output).toContain(`${NOT_SKIPPED}apt reported a signature or hash failure`);
    // Never read as an outage.
    expect(run.output).not.toContain(KEPT_INDEX);
    expect(cacheContents(w)).toEqual(before);
  });

  test("when the script cannot keep its copy of the output, the step fails, though the install passed, and leaves the cache as it found it", () => {
    const old: Pkg = { ...ALPHA, version: "0.9-1" };
    const w = world([ALPHA]);
    // A cache the install would refresh: the old version out, the new one in.
    cacheFile(w, fileOf(old), bytesOf(old));
    // A tee that cannot write its file, as on a full disk: it still passes
    // what it reads on to the log, and exits 1. apt's configuration it writes.
    writeFileSync(
      join(w.bin, "tee"),
      [
        "#!/usr/bin/env bash",
        'case "${*: -1}" in */apt.conf.d/*) exec /usr/bin/tee "$@" ;; esac',
        "cat",
        "exit 1",
      ].join("\n"),
    );
    chmodSync(join(w.bin, "tee"), 0o755);
    const before = cacheContents(w);
    const run = install(w);
    expect(run.status, run.output).toBe(1);
    expect(run.log).toContain("install-deps");
    expect(run.output.match(/^::error::install-chromium-system-libraries: /gm), run.output).toEqual(
      ["::error::install-chromium-system-libraries: "],
    );
    expect(run.output).not.toContain("kept for the cache");
    expect(cacheContents(w)).toEqual(before);
  });
});

// The step carries on without apt only when no `apt-get update` finished, apt
// said the network failed and never that an index was untrusted, and
// Playwright's dry run finds nothing missing. Then it installs nothing, so no
// cached package can reach apt; every other failure fails the step as before.
describe("install-chromium-system-libraries.sh when apt cannot reach the mirror", () => {
  test("with nothing missing, the step passes with one warning, after three attempts, having installed nothing and left the cache as it found it", () => {
    // retry.sh's annotations quote the command line, cache path and all; a
    // path holding words apt's integrity errors use must not read as one.
    const w = world([ALPHA], "cache-signed-hash");
    cacheFile(w, fileOf(ALPHA), bytesOf(ALPHA));
    unreachable(w, UNREACHABLE);
    const before = cacheContents(w);
    const run = install(w);
    expect(run.status, run.output).toBe(0);
    expect(
      run.output.match(/^::warning::install-chromium-system-libraries: /gm),
      run.output,
    ).toEqual([`::warning::install-chromium-system-libraries: `]);
    expect(run.output).toContain(SKIPPED);
    expect(run.log.filter((line) => line === "apt-get update")).toHaveLength(3);
    expect(run.log.at(-1)).toBe("install-deps --dry-run");
    // Nothing judged against an index, nothing put in the archive or installed.
    expect(
      run.log.filter((line) => line.startsWith("apt-cache show") || line === "install-deps"),
    ).toEqual([]);
    expect(readdirSync(w.archives)).toEqual([]);
    expect(run.installed.size).toBe(0);
    expect(cacheContents(w)).toEqual(before);
  });

  test("with a package missing, the step fails with apt's status and the dry run's list", () => {
    const w = world([ALPHA]);
    unreachable(w, UNREACHABLE);
    writeFileSync(join(w.dir, "missing"), "xfonts-utils\nfonts-unifont\n");
    const run = install(w);
    expect(run.status, run.output).toBe(100);
    expect(run.log.at(-1)).toBe("install-deps --dry-run");
    expect(run.output).toContain(
      "Missing system dependencies (2):\n  fonts-unifont\n  xfonts-utils\n",
    );
    expect(run.output).toContain(`${NOT_SKIPPED}playwright install-deps --dry-run chromium`);
    expect(run.output).not.toContain(SKIPPED);
  });

  test.each(Object.keys(UNTRUSTED))(
    "beside a network failure, an index apt could not trust (%s) fails the step without a dry run",
    (kind) => {
      const w = world([ALPHA]);
      unreachable(w, `${UNREACHABLE}${UNTRUSTED[kind]}`);
      const run = install(w);
      expect(run.status, run.output).toBe(100);
      expect(run.log).not.toContain("install-deps --dry-run");
      expect(run.output).toContain(`${NOT_SKIPPED}apt reported a signature or hash failure`);
      expect(run.output).not.toContain(SKIPPED);
    },
  );

  test("once an `apt-get update` has finished, a download failing on the network fails the step, and the cache was checked against that index", () => {
    const w = world([ALPHA, BETA]);
    cacheFile(w, fileOf(ALPHA), bytesOf(ALPHA));
    writeFileSync(
      join(w.dir, "fail"),
      [
        `Err:1 http://azure.archive.ubuntu.com/ubuntu resolute/universe amd64 ${BETA.name} all ${BETA.version}`,
        "  Temporary failure resolving 'azure.archive.ubuntu.com'",
        `E: Failed to fetch http://azure.archive.ubuntu.com/ubuntu/pool/universe/f/${BETA.name}/${fileOf(BETA)}  Temporary failure resolving 'azure.archive.ubuntu.com'`,
        "E: Unable to fetch some archives, maybe run apt-get update or try with --fix-missing?",
        "",
      ].join("\n"),
    );
    const run = install(w);
    expect(run.status, run.output).toBe(100);
    expect(run.log).not.toContain("install-deps --dry-run");
    expect(run.output).toContain(`${NOT_SKIPPED}apt-get update finished`);
    expect(run.output).not.toContain(SKIPPED);
    // In every attempt the cached package was checked after the update.
    const updates = run.log.flatMap((line, at) => (line === "apt-get update" ? [at] : []));
    const checks = run.log.flatMap((line, at) =>
      line === `apt-cache show ${ALPHA.name}=${ALPHA.version}` ? [at] : [],
    );
    expect(updates).toHaveLength(3);
    expect(checks).toHaveLength(3);
    for (const [attempt, at] of updates.entries()) expect(checks[attempt]).toBeGreaterThan(at);
  });

  test("a failure in which apt names no network fault fails the step without a dry run", () => {
    const w = world([ALPHA]);
    unreachable(
      w,
      "E: The repository 'http://azure.archive.ubuntu.com/ubuntu resolute Release' does not have a Release file.\n",
    );
    const run = install(w);
    expect(run.status, run.output).toBe(100);
    expect(run.log).not.toContain("install-deps --dry-run");
    expect(run.output).toContain(`${NOT_SKIPPED}apt reported no network failure`);
    expect(run.output).not.toContain(SKIPPED);
  });

  test("a dry run that passes without saying every dependency is installed, as on a platform Playwright does not know, fails the step", () => {
    const w = world([ALPHA]);
    unreachable(w, UNREACHABLE);
    writeFileSync(join(w.dir, "unsupported"), "");
    const run = install(w);
    expect(run.status, run.output).toBe(100);
    expect(run.log.at(-1)).toBe("install-deps --dry-run");
    expect(run.output).toContain(`${NOT_SKIPPED}playwright install-deps --dry-run chromium`);
    expect(run.output).not.toContain(SKIPPED);
  });
});

/** The start of the warning the script prints when apt installed against the index copies on disk. */
const KEPT_INDEX =
  "::warning::install-chromium-system-libraries: apt-get update could not fetch every index";

/**
 * Makes the mirror's names unresolvable, as on 2026-11-11: every `apt-get
 * update`, the script's and Playwright's own, prints `UNREACHABLE` and
 * finishes keeping the index on disk only when the resolver gives up fast
 * enough (fake-apt.ts says how fast), and a download fails.
 */
const unresolvable = (w: World) => writeFileSync(join(w.dir, "unresolvable"), UNREACHABLE);

/**
 * The index the runner image was built with: the mirror's, as apt fetched
 * and checked it then, already in apt's lists before the step runs.
 */
function indexOnDisk(w: World): void {
  const lists = join(w.dir, "root", "var", "lib", "apt", "lists");
  mkdirSync(lists, { recursive: true });
  writeFileSync(join(lists, "Packages"), readFileSync(join(w.dir, "mirror", "Packages")));
}

// With the resolver bounded, `apt-get update` gives up on names that do not
// resolve inside its attempt, exits 0 and keeps the index on disk. Each cached
// package is then checked against that index, as against a fresh one, and apt
// installs what it can without the network.
describe("install-chromium-system-libraries.sh when the mirror's names do not resolve", () => {
  test("with the cache holding what the index on disk names, the first attempt installs it all from the cache and passes with one warning", () => {
    const w = world([ALPHA, EPOCH]);
    indexOnDisk(w);
    cacheFile(w, fileOf(ALPHA), bytesOf(ALPHA));
    cacheFile(w, fileOf(EPOCH), bytesOf(EPOCH));
    unresolvable(w);
    // On the image the fonts are not installed, so carrying on without apt is
    // not open: only the install can pass the step.
    writeFileSync(join(w.dir, "missing"), `${ALPHA.name}\n${EPOCH.name}\n`);
    const run = install(w);
    expect(run.status, run.output).toBe(0);
    // Both updates, the script's and Playwright's, finished in the one attempt.
    expect(run.output).not.toContain("::warning::retry.sh");
    expect(run.log.filter((line) => line === "apt-get update")).toHaveLength(1);
    expect(run.log.filter((line) => line === "install-deps")).toHaveLength(1);
    expectGenuine(run, [
      [ALPHA, "archive"],
      [EPOCH, "archive"],
    ]);
    expect(run.downloaded).toEqual([]);
    expect(run.log).not.toContain("install-deps --dry-run");
    expect(run.output.match(/^::warning::/gm), run.output).toEqual(["::warning::"]);
    expect(run.output).toContain(KEPT_INDEX);
    expect(cacheContents(w)).toEqual({
      [fileOf(ALPHA)]: bytesOf(ALPHA),
      [fileOf(EPOCH)]: bytesOf(EPOCH),
    });
  });

  test("with the cache holding a newer version than the index on disk names, the step fails after three attempts with one line saying so, having put nothing unchecked in the archive", () => {
    const old: Pkg = { ...ALPHA, version: "0.9-1" };
    // The image's index names 0.9-1; the cache was saved after 1.0-1 reached the mirror.
    const w = world([old]);
    indexOnDisk(w);
    cacheFile(w, fileOf(ALPHA), bytesOf(ALPHA));
    unresolvable(w);
    writeFileSync(join(w.dir, "missing"), `${ALPHA.name}\n`);
    const before = cacheContents(w);
    const run = install(w);
    expect(run.status, run.output).toBe(100);
    expect(run.log.filter((line) => line === "install-deps")).toHaveLength(3);
    expect(run.archiveAtInstall).toEqual([]);
    expect(run.installed.size).toBe(0);
    expect(run.output).toMatch(new RegExp(`^::warning::.*dropped ${fileOf(ALPHA)}`, "m"));
    expect(run.output.match(new RegExp(`^${NOT_SKIPPED}`, "gm")), run.output).toHaveLength(1);
    expect(run.output).toContain(`${NOT_SKIPPED}apt-get update could not fetch every index`);
    expect(run.log).not.toContain("install-deps --dry-run");
    expect(run.output).not.toContain(SKIPPED);
    expect(cacheContents(w)).toEqual(before);
  });

  test("with the index on disk kept, an install that fails for a reason other than a download does not blame the cache", () => {
    const w = world([ALPHA]);
    indexOnDisk(w);
    cacheFile(w, fileOf(ALPHA), bytesOf(ALPHA));
    unresolvable(w);
    writeFileSync(join(w.dir, "fail"), "E: Sub-process /usr/bin/dpkg returned an error code (1)\n");
    const run = install(w);
    expect(run.status, run.output).toBe(100);
    expect(run.output).toContain(
      "W: Some index files failed to download. They have been ignored, or old ones used instead.",
    );
    expect(run.output.match(new RegExp(`^${NOT_SKIPPED}`, "gm")), run.output).toHaveLength(1);
    expect(run.output).toContain(`${NOT_SKIPPED}apt-get update finished, so apt held an index`);
    expect(run.output).not.toContain("could not fetch every index");
  });
});
