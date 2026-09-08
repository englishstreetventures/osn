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

import {
  buildCard,
  declaredFromLabels,
  defaultMetricsDir,
  parseNumstat,
  type SessionRecord,
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

interface ChangedFile {
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

/** Every branch that appears in a transcript, with its records. One pass over
 * the logs; a per-PR scan would re-read gigabytes once per pull request. */
function recordsByBranch(sessionsDir: string): Map<string, SessionRecord[]> {
  const byBranch = new Map<string, SessionRecord[]>();
  const patterns = [`${sessionsDir}/*/*.jsonl`, `${sessionsDir}/*/*/subagents/*.jsonl`];

  for (const pattern of patterns) {
    const found = sh(["sh", "-c", `ls -1 ${pattern} 2>/dev/null || true`]);

    for (const file of found.out.split("\n").filter(Boolean)) {
      let text: string;
      try {
        text = require("node:fs").readFileSync(file, "utf8") as string;
      } catch {
        continue;
      }

      for (const line of text.split("\n")) {
        if (!line.includes('"gitBranch"')) continue;

        let record: SessionRecord;
        try {
          record = JSON.parse(line) as SessionRecord;
        } catch {
          continue;
        }

        const branch = record.gitBranch;
        if (!branch || branch === "main") continue;

        const existing = byBranch.get(branch);
        if (existing) existing.push(record);
        else byBranch.set(branch, [record]);
      }
    }
  }

  return byBranch;
}

/** GitHub's per-file additions and deletions, reshaped into the `git diff
 * --numstat` lines `parseNumstat` already understands. */
function numstatFromApi(files: ChangedFile[]): string {
  return files.map((f) => `${f.additions}\t${f.deletions}\t${f.filename}`).join("\n");
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
  const byBranch = recordsByBranch(sessionsDir);

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

    const path = `${outDir}/${pull.headRefName.replace(/[^a-zA-Z0-9._-]/g, "-")}.json`;

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
