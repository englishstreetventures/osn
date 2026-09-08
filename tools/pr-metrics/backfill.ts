#!/usr/bin/env bun
/**
 * Write cards for pull requests that merged before cards existed.
 *
 * Two things make a backfill different from a live run, and both shape this
 * file:
 *
 * **The branch is usually gone.** A merged branch is deleted, so
 * `git diff base...head` has nothing to resolve locally. The file list comes
 * from the GitHub API instead (`repos/:owner/:repo/pulls/:n/files`), which
 * returns per-file additions and deletions and does not care that the ref no
 * longer exists.
 *
 * **The rating is not trustworthy the same way.** A card backfilled today is
 * describing work whose cost is already known, so any rating attached to it now
 * has seen the answer. `rate-complexity` handles that by marking a backfilled
 * rating `complexity:unconfirmed`; this script simply transcribes whatever the
 * issue carries and never invents one. Cards it writes are `phase: "at-merge"`.
 *
 * The spend still comes from local transcripts, so a backfill only reaches as
 * far back as `~/.claude/projects` on this machine, and only for branches this
 * machine did the work on. Pull requests it cannot cost are reported and
 * skipped rather than written as zero — a card claiming a PR cost nothing is
 * worse than no card, because a query cannot tell it from a cheap one.
 */

import { existsSync, readFileSync } from "node:fs";

import {
  branchSlug,
  buildCard,
  declaredFromLabels,
  defaultMetricsDir,
  parseNumstat,
  recordsByBranch,
  repoProjectPaths,
} from "./index.ts";

interface PullRequest {
  number: number;
  headRefName: string;
  mergedAt: string;
  baseRefOid: string;
  headRefOid: string;
  labels: { name: string }[];
  closingIssuesReferences: { number: number }[];
}

export interface ChangedFile {
  filename: string;
  additions: number;
  deletions: number;
}

interface CommandResult {
  ok: boolean;
  out: string;
}

function sh(command: string[]): CommandResult {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });

  return { ok: result.success, out: result.stdout.toString() };
}

function flag(name: string): string | null {
  const index = Bun.argv.indexOf(`--${name}`);

  return index >= 0 && Bun.argv[index + 1] ? Bun.argv[index + 1] : null;
}

/** GitHub's per-file additions and deletions, reshaped into the `git diff
 * --numstat` lines `parseNumstat` already understands. */
export function numstatFromApi(files: ChangedFile[]): string {
  return files
    .filter((f) => {
      // Git permits tabs and newlines in a path and the files API returns it
      // verbatim, so such a name would inject an extra record into the numstat
      // that `parseNumstat` counts as a real file. Dropping it loses one row of
      // a diff summary; keeping it corrupts the whole card.
      if (typeof f.filename !== "string" || /[\t\n\r]/.test(f.filename)) {
        console.warn(`  ⚠️  skipping a changed file whose name carries a tab or newline.`);

        return false;
      }

      return true;
    })
    .map((f) => `${f.additions}\t${f.deletions}\t${f.filename}`)
    .join("\n");
}

/** The branch a card on disk was written for, or `null` if it cannot be read. */
function readCardBranch(path: string): string | null {
  try {
    const card = JSON.parse(readFileSync(path, "utf8") as string) as { pr?: { branch?: string } };

    return card.pr?.branch ?? null;
  } catch {
    return null;
  }
}

if (import.meta.main) {
  const repo = flag("repo") ?? "xchromo/osn";
  const limit = flag("limit") ?? "100";
  const outDir = flag("out-dir") ?? defaultMetricsDir();
  const sessionsDir = flag("sessions-dir") ?? `${process.env.HOME}/.claude/projects`;
  const dryRun = Bun.argv.includes("--dry-run");

  const listed = sh([
    "gh",
    "pr",
    "list",
    "--repo",
    repo,
    "--state",
    "merged",
    "--limit",
    limit,
    "--json",
    "number,headRefName,mergedAt,baseRefOid,headRefOid,labels,closingIssuesReferences",
  ]);

  if (!listed.ok) {
    console.error("❌ pr-metrics backfill: `gh pr list` failed. Is `gh` authenticated?");
    process.exit(1);
  }

  const pulls = JSON.parse(listed.out) as PullRequest[];
  const byBranch = recordsByBranch(sessionsDir, { repoPaths: repoProjectPaths() });

  console.log(
    `pr-metrics backfill: ${pulls.length} merged PR(s), ${byBranch.size} branch(es) with transcripts.`,
  );

  const skipped: number[] = [];
  let written = 0;

  for (const pull of pulls) {
    const records = byBranch.get(pull.headRefName);

    // No transcript means the work happened on another machine, or before this
    // machine's logs begin. Writing a zero-cost card would put a row in the
    // datalake that reads exactly like a genuinely cheap pull request.
    if (!records || records.length === 0) {
      skipped.push(pull.number);
      continue;
    }

    const filesResult = sh([
      "gh",
      "api",
      "--paginate",
      `repos/${repo}/pulls/${pull.number}/files`,
      "--jq",
      ".[] | {filename, additions, deletions}",
    ]);

    const files = filesResult.out
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ChangedFile);

    const labels = pull.labels.map((label) => label.name);
    const complexity = declaredFromLabels(labels);
    const commits = sh(["gh", "api", `repos/${repo}/pulls/${pull.number}`, "--jq", ".commits"]);

    const card = buildCard(records, parseNumstat(numstatFromApi(files), Number(commits.out) || 0), {
      branch: pull.headRefName,
      prNumber: pull.number,
      issueNumber: pull.closingIssuesReferences[0]?.number ?? null,
      issueType: null,
      issueLabels: labels,
      declaredComplexity: complexity.declared,
      complexityMethod: complexity.method,
      baseSha: pull.baseRefOid,
      headSha: pull.headRefOid,
      mergedAt: pull.mergedAt,
      phase: "at-merge",
      generatedAt: new Date().toISOString(),
    });

    // `branchSlug`, not a copy of its first step: the inline version omitted
    // the trailing `^-+|-+$` strip, so a branch name ending in a character
    // outside the class made `backfill` and `card` write two different files
    // for the same branch, and nothing downstream keys on the filename.
    const path = `${outDir}/${branchSlug(pull.headRefName)}.json`;

    // `branchSlug` is not injective — `feat/x-`, `feat-x` and `feat/x` all slug
    // to `feat-x` — and this loop writes many cards in one pass. `card` writes
    // one per run and cannot see a clash; here it is visible, and a silently
    // overwritten card is indistinguishable from a pull request that was never
    // backfilled at all.
    const existing = written > 0 && existsSync(path) ? readCardBranch(path) : null;
    if (existing !== null && existing !== pull.headRefName) {
      console.warn(
        `  ⚠️  slug collision on ${branchSlug(pull.headRefName)}.json: \`${existing}\` and \`${pull.headRefName}\` — keeping the first, skipping #${pull.number}.`,
      );
      skipped.push(pull.number);
      continue;
    }

    if (dryRun) {
      console.log(
        `  would write #${pull.number} ${pull.headRefName} — $${card.spend.usd_equivalent.toFixed(2)}`,
      );
    } else {
      require("node:fs").mkdirSync(outDir, { recursive: true });
      require("node:fs").writeFileSync(path, `${JSON.stringify(card, null, 2)}\n`);
      console.log(
        `  #${pull.number} ${pull.headRefName} — $${card.spend.usd_equivalent.toFixed(2)}`,
      );
    }

    written += 1;
  }

  console.log(`\n${dryRun ? "would write" : "wrote"} ${written} card(s).`);

  if (skipped.length > 0) {
    console.log(
      `skipped ${skipped.length} PR(s) with no local transcript: ${skipped.slice(0, 10).join(", ")}${
        skipped.length > 10 ? ", …" : ""
      }`,
    );
    console.log(
      "A card is only written where the spend is real — a zero-cost card reads like a cheap PR.",
    );
  }
}
