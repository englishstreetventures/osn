/**
 * Put already-created issues on the Project board.
 *
 * The Project's "auto-add" workflow only fires for issues opened after it is
 * enabled, and this migration created its issues first -- creating the Project
 * needs the `project` OAuth scope, and `gh auth refresh` is interactive. So the
 * issues that went in ahead of the board are added here, once.
 *
 * The two repos are the source of truth, not the migration's own records. The
 * checklists those records were parsed from have been deleted, so anything that
 * re-reads them now sees an empty manifest and quietly does nothing -- and an
 * issue filed by hand since the migration belongs on the board just as much as
 * a migrated one.
 *
 * Re-runnable: it reads what is already on the board and adds only the rest.
 */
import { $ } from "bun";

import { Throttle } from "./throttle";

const OWNER = "xchromo";
const REPOS = ["xchromo/osn", "xchromo/osn-tracker"];

export type Run = (args: string[]) => Promise<string>;

/**
 * `.nothrow()` rather than letting `$` throw, and the message is rebuilt by
 * hand, because both are load-bearing. A `ShellError`'s message is exactly
 * "Failed with exit code 1" — stderr lives on `.stderr` and never reaches the
 * message. `alreadyOnBoard()` and `rateLimited()` below decide what to do by
 * matching stderr substrings, so letting `$` throw its own error would make
 * both of them return false: a "content already exists" response would stop
 * being the no-op it is and abort the backfill instead, and a rate limit would
 * stop being the resumable pause it is. Keeping the message shape keeps their
 * contract, and their tests assert on it.
 */
export function ghError(args: string[], exitCode: number, stderr: string): Error {
  return new Error(`gh ${args[0]} failed (${exitCode}): ${stderr.trim()}`);
}

export const gh: Run = async (args) => {
  const { exitCode, stdout, stderr } = await $`gh ${args}`.nothrow().quiet();
  if (exitCode !== 0) throw ghError(args, exitCode, stderr.toString());
  return stdout.toString();
};

/** Every issue URL in one repo's listing. `gh issue list` omits pull requests. */
export function parseIssues(json: string): string[] {
  return (JSON.parse(json) as { url: string }[]).map((issue) => issue.url);
}

/** The issues on the board already, by URL. */
export function parseBoard(json: string): Set<string> {
  const parsed = JSON.parse(json) as { items?: { content?: { url?: string } }[] };
  return new Set((parsed.items ?? []).flatMap((i) => (i.content?.url ? [i.content.url] : [])));
}

/** The one `item-add` failure that means the work is already done. */
export function alreadyOnBoard(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Content already exists in this project");
}

/** The GraphQL hourly allowance running out, which time alone fixes. */
export function rateLimited(error: unknown): boolean {
  return error instanceof Error && error.message.includes("API rate limit already exceeded");
}

export function pending(all: string[], onBoard: Set<string>): string[] {
  return all.filter((url) => !onBoard.has(url));
}

if (import.meta.main) {
  const project = Bun.argv[2];
  if (!project || Number.isNaN(Number(project))) {
    throw new Error("usage: backfill-project.ts <project-number> [--apply]");
  }
  const apply = Bun.argv.includes("--apply");

  const all: string[] = [];
  for (const repo of REPOS) {
    const urls = parseIssues(
      await gh([
        "issue",
        "list",
        "--repo",
        repo,
        "--state",
        "all",
        "--limit",
        "3000",
        "--json",
        "url",
      ]),
    );
    console.log(`${repo}: ${urls.length} issues`);
    all.push(...urls);
  }

  const board = parseBoard(
    await gh([
      "project",
      "item-list",
      project,
      "--owner",
      OWNER,
      "--format",
      "json",
      "--limit",
      "2000",
    ]),
  );
  const todo = pending(all, board);

  console.log(`${all.length} issues, ${board.size} on the board, ${todo.length} to add`);
  if (!apply) {
    for (const url of todo.slice(0, 10)) console.log(`  would add ${url}`);
    if (todo.length > 10) console.log(`  … and ${todo.length - 10} more`);
    console.log("\nre-run with --apply");
    process.exit(0);
  }

  // Adding a board item is an ordinary mutation, not content creation, so it
  // needs nothing like the gap between two `issue create` calls.
  const throttle = new Throttle(1_500);
  let done = 0;
  let already = 0;
  for (const url of todo) {
    await throttle.wait();
    try {
      await gh(["project", "item-add", project, "--owner", OWNER, "--url", url]);
      done += 1;
    } catch (error) {
      // `item-list` pages, and a long run races the board it is reading, so an
      // issue can be on the board and absent from the listing that decided this
      // set. Adding it again is the no-op it sounds like -- the add is what makes
      // the run idempotent, and dying on it strands every issue after this one.
      // The GraphQL allowance is hourly and every add spends from it, so a big
      // board can outlast it. Nothing is lost -- what went on stays on -- so say
      // how much is left and stop, rather than printing a stack trace.
      if (rateLimited(error)) {
        console.log(`rate limit reached after ${done + already} of ${todo.length}; re-run later`);
        break;
      }
      if (!alreadyOnBoard(error)) throw error;
      already += 1;
    }
    if ((done + already) % 25 === 0) console.log(`${done + already}/${todo.length}`);
  }
  console.log(`added ${done}${already > 0 ? `, ${already} were on the board already` : ""}`);
}
