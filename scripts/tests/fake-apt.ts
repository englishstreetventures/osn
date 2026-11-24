// A fake apt for the test of scripts/install-chromium-system-libraries.sh:
// enough of `apt-get update`, `apt-cache show`, `dpkg --configure -a`,
// `bunx playwright install-deps chromium` and its `--dry-run` to show which
// bytes apt would install, and from where. Each stub on the test's PATH runs
// this file with the world's directory and the stub's own name in front of its
// arguments.
//
// A world is a directory holding:
//   mirror/Packages                  the signed index, records as `apt-cache show` prints them
//   mirror/<file>                    the mirror's packages
//   needed                           the files install-deps installs, one per line
//   root/var/lib/apt/lists/Packages  the index apt holds: the mirror's once `apt-get update` has reached
//                                    it, or one a test puts there first, as the runner image does
//   root/var/cache/apt/archives/     apt's archive
//   log                              one line per call, per archive entry and per package installed
//   fail                             when present, install-deps fails as apt does when a download does
//                                    (exit 100), printing what the file holds, or a default line when empty
//   update-fails                     when present, `apt-get update` prints what it holds, fetches no index
//                                    and exits 100
//   missing                          the packages the dry run reports missing, one per line; none when absent
//   unsupported                      when present, the dry run takes Playwright's unknown-platform path: a
//                                    warning, no check, exit 0
//   unresolvable                     when present, no mirror's name resolves: every `apt-get update`,
//                                    the one install-deps runs too, prints what it holds and either
//                                    finishes keeping the index on disk or is cut (see unresolvedUpdate),
//                                    and a download fails
//   update-untrusted                 when present, the mirror's index fails its signature check: every
//                                    `apt-get update` prints what it holds and keeps the index on disk,
//                                    and fails if apt's configuration makes an auth failure fatal
//   dpkg-lock                        `<pid> <tick|never>`: a dpkg of that pid holds dpkg's lock until the
//                                    clock reaches that tick, or for good. While it does, `dpkg
//                                    --configure -a` refuses as dpkg does, and install-deps waits as apt
//                                    does for as long as apt's configuration allows, then refuses
//   leave-dpkg                       `<ticks|never>`: the first install-deps is cut at the attempt's limit
//                                    (exit 124) while its dpkg, which apt-get started in a session of its
//                                    own, runs on holding the lock for that many more ticks, or for good
//   lock-at-install                  `<ticks>`: just before the first install-deps takes dpkg's lock,
//                                    another process takes it for that many ticks
//   dpkg-fails                       when present, `dpkg --configure -a` prints what it holds and exits 2,
//                                    as on a fatal error that is not the lock
//
// The clock is the number of `sleep 1` lines in the log. The test's `sleep`
// stub writes one for each `sleep 1` and returns at once, and apt's own wait
// for the lock writes one per second it waits, so a minute's wait takes no
// time.
//
// install-deps behaves as the worst apt could: it installs whatever file of
// the right name it finds in the archive, unchecked, and downloads from the
// mirror only what is not there. So a cached file that reaches the archive
// unverified shows up in the log as installed.

import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const [world, tool, ...args] = process.argv.slice(2);
if (world === undefined || tool === undefined) {
  process.stderr.write("usage: fake-apt.ts <world> <tool> [args...]\n");
  process.exit(2);
}

const mirror = join(world, "mirror");
const lists = join(world, "root", "var", "lib", "apt", "lists");
const archives = join(world, "root", "var", "cache", "apt", "archives");

const log = (line: string) => appendFileSync(join(world, "log"), `${line}\n`);

const sha256 = (path: string) =>
  new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");

/** The text a world file holds, or undefined when the world has no such file. */
const worldFile = (name: string) =>
  existsSync(join(world, name)) ? readFileSync(join(world, name), "utf8") : undefined;

/** Every line of apt's configuration directory, as apt reads it. */
function aptConf(): string {
  const conf = join(world, "root", "etc", "apt", "apt.conf.d");
  return readdirSync(conf)
    .map((file) => readFileSync(join(conf, file), "utf8"))
    .join("\n");
}

/** apt-get update's warning when it kept an index on disk (apt-pkg/update.cc). */
const KEPT_INDEX =
  "W: Some index files failed to download. They have been ignored, or old ones used instead.\n";

/**
 * The longest an `apt-get update` may take when no name resolves: its share of
 * the script's 150 s attempt, which holds the script's update, Playwright's own
 * and the install when no other dpkg holds the lock. A wait for the lock comes
 * out of the same 150 s.
 */
const UPDATE_SHARE_SECONDS = 60;

/**
 * How long `apt-get update` waits on names that never resolve, as on the
 * runner in ci.yml run 43054765174: ten lookups one after another (four
 * indexes, each tried twice on the first mirror under the image's
 * `Acquire::Retries "1"`, then once on each of the other two), each an SRV
 * query unless `Acquire::EnableSrvRecords` is false and an address query, and
 * each query waits glibc's timeout times its attempts, 5 s and 2 unless
 * RES_OPTIONS sets them. Unbounded that is 200 s, 20 s a lookup, as the log
 * shows.
 */
function unresolvedSeconds(): number {
  const option = (name: string, fallback: number) => {
    const set = new RegExp(`(?:^|\\s)${name}:(\\d+)`).exec(process.env.RES_OPTIONS ?? "");
    return set?.[1] === undefined ? fallback : Number(set[1]);
  };
  const srv = !aptConf().includes('Acquire::EnableSrvRecords "false";');
  return 10 * (srv ? 2 : 1) * option("timeout", 5) * option("attempts", 2);
}

/**
 * `apt-get update`, the script's or install-deps' own. With the mirror
 * reachable, its index becomes the one apt reads. With its names unresolvable,
 * apt warns and keeps the index already on disk (apt-pkg/update.cc) when it
 * gives up in time; otherwise retry.sh cuts the attempt first, which exits 124.
 * With an index that fails its signature check where one is already on disk,
 * apt warns, keeps that one, and runs the commands listed under
 * `APT::Update::Auth-Failure`; one that fails, as `false` does, makes the
 * update fail (apt-pkg/acquire-item.cc, apt-pkg/contrib/fileutl.cc).
 */
function update(): number {
  const untrusted = worldFile("update-untrusted");
  if (untrusted !== undefined) {
    process.stderr.write(untrusted);
    if (aptConf().includes('APT::Update::Auth-Failure { "false"; };')) {
      process.stderr.write(
        "E: Problem executing scripts APT::Update::Auth-Failure 'false'\nE: Sub-process returned an error code\n",
      );
      return 100;
    }
    process.stderr.write(KEPT_INDEX);
    return 0;
  }
  const unresolvable = worldFile("unresolvable");
  if (unresolvable === undefined) {
    mkdirSync(lists, { recursive: true });
    copyFileSync(join(mirror, "Packages"), join(lists, "Packages"));
    return 0;
  }
  process.stdout.write(unresolvable);
  if (unresolvedSeconds() > UPDATE_SHARE_SECONDS) return 124;
  process.stderr.write(KEPT_INDEX);
  return 0;
}

/** The clock: how many one-second sleeps the log records so far. */
const ticks = () =>
  readFileSync(join(world, "log"), "utf8")
    .split("\n")
    .filter((line) => line === "sleep 1").length;

/** The pid of the dpkg holding dpkg's lock now, or undefined when it is free. */
function lockHolder(): string | undefined {
  const [pid, until] = (worldFile("dpkg-lock") ?? "").trim().split(" ");
  if (pid === undefined || pid === "") return undefined;
  return until === "never" || ticks() < Number(until) ? pid : undefined;
}

/** Puts dpkg's lock in the hands of `pid` for `more` ticks from now, or for good. */
function holdLock(pid: string, more: string): void {
  const until = more.trim() === "never" ? "never" : String(ticks() + Number(more));
  writeFileSync(join(world, "dpkg-lock"), `${pid} ${until}\n`);
}

/**
 * `dpkg --configure -a`. dpkg never waits for its lock: `modstatdb_lock` takes
 * it with FILE_LOCK_NOWAIT (lib/dpkg/dbmodify.c), and `file_lock`
 * (lib/dpkg/file.c) fails through `ohshit`, which prints `dpkg: error: ` and
 * exits 2 (lib/dpkg/ehandle.c), as every fatal error does.
 */
function configure(): number {
  const fails = worldFile("dpkg-fails");
  if (fails !== undefined) {
    log("dpkg --configure -a failed");
    process.stderr.write(fails);
    return 2;
  }
  const holder = lockHolder();
  if (holder !== undefined) {
    log("dpkg --configure -a refused");
    process.stderr.write(
      `dpkg: error: dpkg database lock was locked by /usr/bin/dpkg process with pid ${holder}\nNote: removing the lock file is always wrong, can damage the locked area\nand the entire system. See <https://wiki.debian.org/Teams/Dpkg/FAQ#db-lock>.\n`,
    );
    return 2;
  }
  log("dpkg --configure -a");
  return 0;
}

/**
 * apt-get install taking dpkg's lock. With `DPkg::Lock::Timeout "<n>"` apt
 * tries up to n times, sleeping a second after each refusal, and does not try
 * again after the last sleep (`GetLockMaybeWait` in apt-pkg/deb/debsystem.cc);
 * without it, once. Then it gives up as apt does (apt-pkg/contrib/fileutl.cc).
 */
function aptLock(): boolean {
  const timeout = Number(/DPkg::Lock::Timeout "(\d+)";/.exec(aptConf())?.[1] ?? "0");
  let holder = lockHolder();
  if (holder !== undefined && timeout > 0) {
    log("apt-get waits for dpkg's lock");
    process.stdout.write(
      `Waiting for cache lock: Could not get lock /var/lib/dpkg/lock. It is held by process ${holder} (dpkg)...\n`,
    );
    for (let tried = 1; holder !== undefined; tried += 1) {
      log("sleep 1");
      if (tried >= timeout) break;
      holder = lockHolder();
    }
  }
  if (holder === undefined) return true;
  process.stderr.write(
    `E: Could not get lock /var/lib/dpkg/lock. It is held by process ${holder} (dpkg)\nE: Unable to lock the administration directory (/var/lib/dpkg/), is another process using it?\n`,
  );
  return false;
}

/** The records of the index apt holds now, each as its lines' fields. */
function records(): { readonly text: string; readonly fields: ReadonlyMap<string, string> }[] {
  const index = join(lists, "Packages");
  if (!existsSync(index)) return [];
  return readFileSync(index, "utf8")
    .split(/\n\s*\n/)
    .filter((text) => text.trim() !== "")
    .map((text) => ({
      text: text.trim(),
      fields: new Map(
        text
          .trim()
          .split("\n")
          .map((line) => [
            line.slice(0, line.indexOf(":")),
            line.slice(line.indexOf(":") + 1).trim(),
          ]),
      ),
    }));
}

function aptCacheShow(): number {
  const wanted = args.filter((one) => !one.startsWith("-") && one !== "show");
  if (args[0] !== "show" || wanted.length !== 1 || !wanted[0]?.includes("=")) {
    process.stderr.write(`fake apt-cache: unexpected arguments: ${args.join(" ")}\n`);
    return 2;
  }
  const [name, version] = wanted[0].split("=", 2);
  log(`apt-cache show ${wanted[0]}`);
  const found = records().filter(
    (one) => one.fields.get("Package") === name && one.fields.get("Version") === version,
  );
  if (found.length === 0) {
    process.stderr.write("E: No packages found\n");
    return 100;
  }
  process.stdout.write(`${found.map((one) => one.text).join("\n\n")}\n\n`);
  return 0;
}

function installDeps(): number {
  // Playwright's command runs `apt-get update` before `apt-get install`.
  const updated = update();
  if (updated !== 0) return updated;
  log("install-deps");
  const taken = worldFile("lock-at-install");
  if (taken !== undefined && !readFileSync(join(world, "log"), "utf8").includes("lock taken\n")) {
    log("another process: lock taken");
    holdLock("4242", taken);
  }
  if (!aptLock()) return 100;
  const leave = worldFile("leave-dpkg");
  if (leave !== undefined && !readFileSync(join(world, "log"), "utf8").includes("dpkg left\n")) {
    // retry.sh's `timeout` exits 124 once it has cut the attempt.
    log("install-deps cut at the limit: dpkg left");
    holdLock("3014", leave);
    return 124;
  }
  const fail = worldFile("fail");
  if (fail !== undefined) {
    process.stderr.write(fail === "" ? "E: Unable to fetch some archives\n" : fail);
    return 100;
  }
  mkdirSync(archives, { recursive: true });
  for (const entry of readdirSync(archives).toSorted()) log(`archive ${entry}`);
  const needed = readFileSync(join(world, "needed"), "utf8").split("\n").filter(Boolean);
  // apt fetches everything the archive lacks before it installs anything.
  const absent = needed.filter((file) => !existsSync(join(archives, file)));
  if (absent.length > 0 && worldFile("unresolvable") !== undefined) {
    for (const file of absent) {
      process.stderr.write(
        `Err:1 http://azure.archive.ubuntu.com/ubuntu resolute/universe all ${file}\n  Temporary failure resolving 'azure.archive.ubuntu.com'\n`,
      );
    }
    process.stderr.write(
      "E: Unable to fetch some archives, maybe run apt update or try with --fix-missing?\n",
    );
    return 100;
  }
  for (const file of needed) {
    const inArchive = join(archives, file);
    let from = "archive";
    if (!existsSync(inArchive)) {
      copyFileSync(join(mirror, file), inArchive);
      log(`downloaded ${file}`);
      from = "network";
    }
    log(`installed ${file} ${sha256(inArchive)} ${from}`);
  }
  return 0;
}

/**
 * `install-deps --dry-run chromium`, as Playwright 1.64.1 writes it
 * (`reportMissingDependenciesLinux` in playwright-core's lib/coreBundle.js):
 * it simulates the install with `apt-get install -s`, which reads the index
 * apt already holds, and touches neither the network nor the archive.
 */
function dryRun(): number {
  log("install-deps --dry-run");
  if (worldFile("unsupported") !== undefined) {
    process.stderr.write(
      "Cannot install dependencies for ubuntu26.04-x64 with Playwright 1.64.1!\n",
    );
    return 0;
  }
  const missing = (worldFile("missing") ?? "").split("\n").filter(Boolean).toSorted();
  if (missing.length === 0) {
    process.stdout.write("All system dependencies are installed.\n");
    return 0;
  }
  process.stdout.write(
    `Missing system dependencies (${missing.length}):\n${missing.map((one) => `  ${one}\n`).join("")}`,
  );
  return 1;
}

function main(): number {
  switch (tool) {
    case "apt-get":
      if (args.length === 1 && args[0] === "update") {
        log("apt-get update");
        const unreachable = worldFile("update-fails");
        if (unreachable !== undefined) {
          process.stdout.write(unreachable);
          return 100;
        }
        return update();
      }
      break;
    case "apt-cache":
      return aptCacheShow();
    case "dpkg":
      if (args.join(" ") === "--configure -a") return configure();
      break;
    case "bunx":
      if (args.join(" ") === "--no-install playwright install-deps chromium") return installDeps();
      if (args.join(" ") === "--no-install playwright install-deps --dry-run chromium") {
        return dryRun();
      }
      break;
    default:
      break;
  }
  process.stderr.write(`fake ${tool}: unexpected arguments: ${args.join(" ")}\n`);
  return 2;
}

process.exit(main());
