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
//   root/var/lib/apt/lists/Packages  the index once `apt-get update` has run
//   root/var/cache/apt/archives/     apt's archive
//   log                              one line per call, per archive entry and per package installed
//   fail                             when present, install-deps fails as apt does when a download does
//                                    (exit 100), printing what the file holds, or a default line when empty
//   update-fails                     when present, `apt-get update` prints what it holds, fetches no index
//                                    and exits 100
//   missing                          the packages the dry run reports missing, one per line; none when absent
//   unsupported                      when present, the dry run takes Playwright's unknown-platform path: a
//                                    warning, no check, exit 0
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

/** `apt-get update`: the mirror's index becomes the one apt reads. */
function update(): void {
  mkdirSync(lists, { recursive: true });
  copyFileSync(join(mirror, "Packages"), join(lists, "Packages"));
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

/** The text a world file holds, or undefined when the world has no such file. */
const worldFile = (name: string) =>
  existsSync(join(world, name)) ? readFileSync(join(world, name), "utf8") : undefined;

function installDeps(): number {
  // Playwright's command runs `apt-get update` before `apt-get install`.
  update();
  log("install-deps");
  const fail = worldFile("fail");
  if (fail !== undefined) {
    process.stderr.write(fail === "" ? "E: Unable to fetch some archives\n" : fail);
    return 100;
  }
  mkdirSync(archives, { recursive: true });
  for (const entry of readdirSync(archives).toSorted()) log(`archive ${entry}`);
  const needed = readFileSync(join(world, "needed"), "utf8").split("\n").filter(Boolean);
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
        update();
        return 0;
      }
      break;
    case "apt-cache":
      return aptCacheShow();
    case "dpkg":
      if (args.join(" ") === "--configure -a") {
        log("dpkg --configure -a");
        return 0;
      }
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
