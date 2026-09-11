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

import type { Card } from "./index.ts";
import {
  branchSlug,
  buildCard,
  declaredFromLabels,
  defaultMetricsDir,
  parseNumstat,
  recordsByBranch,
  repoProjectPaths,
  sameApartFromGeneratedAt,
} from "./index.ts";

/** A pull request's linked issue, as `gh pr list --json closingIssuesReferences`
 * already returns it — unconditionally, not a field this tool asked for by
 * name (`--json` takes no nested selection; see `issueLabelsById`'s doc
 * comment). The issue is usually not in this repository: see below. */
interface IssueRef {
  id: string;
  number: number;
  repository: { name: string; owner: { login: string } };
}

interface PullRequest {
  number: number;
  headRefName: string;
  mergedAt: string;
  baseRefOid: string;
  headRefOid: string;
  closingIssuesReferences: IssueRef[];
}

/** A card's complexity fields, decided per pull request below. Structurally
 * compatible with `DeclaredComplexity` (`index.ts`) but not that type itself:
 * `method` here also carries `"not-fetched"` and `"lookup-failed"`, neither
 * of which `declaredFromLabels` can produce. */
interface RatingOutcome {
  declared: number | null;
  method: string;
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

/** The card on disk, or `null` if the file is absent or not readable as JSON. */
function readCardFile(path: string): Card | null {
  try {
    return JSON.parse(readFileSync(path, "utf8") as string) as Card;
  } catch {
    return null;
  }
}

/** `gh`, asynchronously, so several calls can be in flight at once. `sh` stays
 * for the one call that has to finish before anything else can start. */
async function ghAsync(command: string[]): Promise<CommandResult> {
  const proc = Bun.spawn(command, { stdout: "pipe", stderr: "pipe" });
  const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);

  return { ok: proc.exitCode === 0, out };
}

/** How many `gh api` calls are allowed in flight. Enough to hide the round-trip
 * latency that dominates here, low enough not to look like a burst to the API. */
const FILE_FETCH_CONCURRENCY = 8;

/** How many pull requests one GraphQL document asks about.
 *
 * Not `--limit`: GitHub costs a query by the nodes it could return, and
 * `gh pr list --json commits` — which fetches every listing field per node —
 * fails that limit outright at 50. One aliased `commits{totalCount}` per pull
 * request is far cheaper than that, but the ceiling is real and undocumented,
 * so the document is chunked rather than assumed to fit.
 */
const COMMIT_QUERY_CHUNK = 50;

/**
 * The commit count of every given pull request, in one GraphQL document per
 * chunk rather than one REST call each.
 *
 * `gh api repos/…/pulls/:n --jq .commits` costs a round trip per pull request —
 * measured 7.41 s for ten — and the numbers are independent of everything else
 * the loop does, so there is no reason to fetch them one at a time.
 */
async function commitCounts(repo: string, numbers: number[]): Promise<Map<number, number>> {
  const [owner, name] = repo.split("/");
  const counts = new Map<number, number>();

  for (let i = 0; i < numbers.length; i += COMMIT_QUERY_CHUNK) {
    const chunk = numbers.slice(i, i + COMMIT_QUERY_CHUNK);
    const fields = chunk
      .map((n) => `p${n}: pullRequest(number: ${n}) { commits { totalCount } }`)
      .join("\n      ");

    const result = await ghAsync([
      "gh",
      "api",
      "graphql",
      "-f",
      `query=query { repository(owner: "${owner}", name: "${name}") { ${fields} } }`,
    ]);

    if (!result.ok) continue;

    let parsed: { data?: { repository?: Record<string, { commits?: { totalCount?: number } }> } };
    try {
      parsed = JSON.parse(result.out) as typeof parsed;
    } catch {
      continue;
    }

    for (const n of chunk) {
      const total = parsed.data?.repository?.[`p${n}`]?.commits?.totalCount;
      if (typeof total === "number") counts.set(n, total);
    }
  }

  return counts;
}

/** How many GraphQL nodes one `nodes(ids:)` document asks about. Verified
 * against the real ceiling — `nodes(ids:)` rejects a request over 100 ids
 * outright ("ARGUMENT_LIMIT") — and against cost: a 50-id document with a
 * `labels(first: 20)` sub-selection each measured `cost: 1`, `nodeCount:
 * 1050` against GitHub's 500,000-node per-query budget. 50 leaves headroom
 * under the hard limit rather than assuming a cost this small never grows. */
const NODE_QUERY_CHUNK = 50;

/**
 * The labels of every given issue, addressed by its GraphQL node id — never
 * by `(repository, number)`.
 *
 * `closingIssuesReferences[].number` is not safe to look up with a
 * repository-scoped `issue(number:)` alias (the shape `commitCounts` uses
 * above for pull-request numbers): the linked issue is usually not in this
 * repository at all — most of this repository's pull requests close a
 * finding in the private `xchromo/osn-tracker` repo instead — so the same
 * bare number can resolve to an unrelated issue in the wrong repository, or
 * to nothing (`NOT_FOUND`) when it happens to be a pull-request number
 * instead. Either way one bad alias makes the whole batched `gh api graphql`
 * call exit non-zero, and `commitCounts`'s `if (!result.ok) continue` would
 * then drop every OTHER issue in that chunk too.
 *
 * `nodes(ids:)` needs no repository scoping — `gh pr list --json
 * closingIssuesReferences` already returns each linked issue's node id
 * alongside its number — and resolves every id independently: a id GraphQL
 * cannot resolve becomes `null` at that position without touching its
 * siblings. The document's exit code still goes non-zero when any id in it
 * is unresolved (verified live), so `result.out` is parsed regardless of
 * `result.ok`; only output that isn't JSON at all — a total transport
 * failure — gives up on the chunk.
 *
 * Returns a map keyed by id. `has(id)` distinguishes "resolved, whatever
 * labels came back" from "never resolved" — callers need that distinction to
 * avoid recording a failed lookup as if it were a successfully-checked,
 * genuinely unrated issue (see the `"lookup-failed"` branch below).
 */
async function issueLabelsById(ids: string[]): Promise<Map<string, string[]>> {
  const labels = new Map<string, string[]>();

  for (let i = 0; i < ids.length; i += NODE_QUERY_CHUNK) {
    const chunk = ids.slice(i, i + NODE_QUERY_CHUNK);
    const idList = chunk.map((id) => JSON.stringify(id)).join(", ");

    const result = await ghAsync([
      "gh",
      "api",
      "graphql",
      "-f",
      `query=query { nodes(ids: [${idList}]) { ... on Issue { labels(first: 20) { nodes { name } } } } }`,
    ]);

    let parsed: { data?: { nodes?: ({ labels?: { nodes?: { name: string }[] } } | null)[] } };
    try {
      parsed = JSON.parse(result.out) as typeof parsed;
    } catch {
      continue;
    }

    const nodes = parsed.data?.nodes ?? [];
    chunk.forEach((id, idx) => {
      const node = nodes[idx];
      if (node)
        labels.set(
          id,
          (node.labels?.nodes ?? []).map((l) => l.name),
        );
    });
  }

  return labels;
}

/** The changed-file list of every given pull request, a bounded number of
 * requests at a time. The list has to stay on the paginated REST endpoint:
 * `gh pr list --json files` silently truncates at 100 files, and this
 * repository already has a pull request with 289. */
async function fileLists(repo: string, numbers: number[]): Promise<Map<number, ChangedFile[]>> {
  const lists = new Map<number, ChangedFile[]>();
  const queue = [...numbers];

  const worker = async () => {
    for (let n = queue.shift(); n !== undefined; n = queue.shift()) {
      const result = await ghAsync([
        "gh",
        "api",
        "--paginate",
        `repos/${repo}/pulls/${n}/files`,
        "--jq",
        ".[] | {filename, additions, deletions}",
      ]);

      lists.set(
        n,
        result.out
          .split("\n")
          .filter(Boolean)
          .flatMap((line) => {
            try {
              return [JSON.parse(line) as ChangedFile];
            } catch {
              return [];
            }
          }),
      );
    }
  };

  await Promise.all(Array.from({ length: Math.min(FILE_FETCH_CONCURRENCY, queue.length) }, worker));

  return lists;
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
    "number,headRefName,mergedAt,baseRefOid,headRefOid,closingIssuesReferences",
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
  let unchanged = 0;
  const claimed = new Set<string>();

  // No transcript means the work happened on another machine, or before this
  // machine's logs begin. Writing a zero-cost card would put a row in the
  // datalake that reads exactly like a genuinely cheap pull request — so those
  // are dropped here, before anything is fetched for them.
  const carded = pulls.filter((pull) => (byBranch.get(pull.headRefName)?.length ?? 0) > 0);
  for (const pull of pulls) {
    if (!carded.includes(pull)) skipped.push(pull.number);
  }

  // Both fetches happen up front rather than twice per iteration. Neither
  // depends on the other's result, and the loop's own work is local.
  const numbers = carded.map((pull) => pull.number);

  // A linked issue's labels are read only when the issue itself lives in
  // this same repository — see `issueLabelsById`'s doc comment for why a
  // repository-scoped alias can't be used for one elsewhere, and
  // xchromo/osn#1012 for why one elsewhere (chiefly the private
  // xchromo/osn-tracker) is never fetched at all: its labels can carry a
  // severity/area pair that must not reach a card committed in this public
  // repository. Keyed by pull-request number so the per-pull loop below can
  // look its ref back up.
  const [repoOwner, repoName] = repo.split("/");
  const localIssueRefs = new Map<number, IssueRef>();
  for (const pull of carded) {
    const ref = pull.closingIssuesReferences[0];
    if (ref && ref.repository.owner.login === repoOwner && ref.repository.name === repoName) {
      localIssueRefs.set(pull.number, ref);
    }
  }
  const uniqueIssueIds = [...new Set([...localIssueRefs.values()].map((ref) => ref.id))];

  const [counts, files, labelsById] = await Promise.all([
    commitCounts(repo, numbers),
    fileLists(repo, numbers),
    issueLabelsById(uniqueIssueIds),
  ]);

  for (const pull of carded) {
    const records = byBranch.get(pull.headRefName) ?? [];
    const changed = files.get(pull.number) ?? [];

    const linkedRef = pull.closingIssuesReferences[0] ?? null;
    const issueNumber = linkedRef?.number ?? null;
    const localRef = localIssueRefs.get(pull.number) ?? null;

    let labels: string[] = [];
    let complexity: RatingOutcome;
    if (linkedRef === null) {
      // No linked issue at all — nothing to check. Matches what `card`
      // itself writes when given no `--issue-labels` (index.ts).
      complexity = { declared: null, method: "none" };
    } else if (localRef === null) {
      // A linked issue exists but lives outside this repository —
      // deliberately never read (see the comment above `localIssueRefs`).
      // Distinct from "none": a rating may well exist there; nobody checked.
      complexity = { declared: null, method: "not-fetched" };
    } else if (!labelsById.has(localRef.id)) {
      // Queried and unresolved — a transport error, or the issue vanished
      // between merge and backfill. Distinct from "none" for the same
      // reason a zero-transcript pull request is skipped rather than carded
      // at zero: a card must never claim to have checked something it did
      // not.
      complexity = { declared: null, method: "lookup-failed" };
      console.warn(
        `  ⚠️  could not fetch labels for issue #${localRef.number} (linked from PR #${pull.number}) — leaving complexity unrated rather than guessing.`,
      );
    } else {
      labels = labelsById.get(localRef.id) ?? [];
      complexity = declaredFromLabels(labels);
    }

    const card = buildCard(
      records,
      parseNumstat(numstatFromApi(changed), counts.get(pull.number) ?? 0),
      {
        branch: pull.headRefName,
        prNumber: pull.number,
        issueNumber,
        issueType: null,
        issueLabels: labels,
        declaredComplexity: complexity.declared,
        complexityMethod: complexity.method,
        baseSha: pull.baseRefOid,
        headSha: pull.headRefOid,
        mergedAt: pull.mergedAt,
        phase: "at-merge",
        generatedAt: new Date().toISOString(),
      },
    );

    // `branchSlug`, not a copy of its first step: the inline version omitted
    // the trailing `^-+|-+$` strip, so a branch name ending in a character
    // outside the class made `backfill` and `card` write two different files
    // for the same branch, and nothing downstream keys on the filename.
    const slug = branchSlug(pull.headRefName);
    const path = `${outDir}/${slug}.json`;

    // `branchSlug` is not injective — `feat/x-`, `feat-x` and `feat/x` all slug
    // to `feat-x` — and this loop writes many cards in one pass. `card` writes
    // one per run and cannot see a clash; here it is visible, and a silently
    // overwritten card is indistinguishable from a pull request that was never
    // backfilled at all. The guard keys on the slugs this run has claimed, so a
    // card left untouched still holds its filename against a second branch, and
    // a card left by an earlier run is not mistaken for a clash.
    const onDisk = existsSync(path) ? readCardFile(path) : null;
    const existing = claimed.has(slug) ? (onDisk?.pr?.branch ?? null) : null;
    if (existing !== null && existing !== pull.headRefName) {
      console.warn(
        `  ⚠️  slug collision on ${slug}.json: \`${existing}\` and \`${pull.headRefName}\` — keeping the first, skipping #${pull.number}.`,
      );
      skipped.push(pull.number);
      continue;
    }

    claimed.add(slug);

    if (onDisk !== null && sameApartFromGeneratedAt(onDisk, card)) {
      unchanged += 1;
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

  if (unchanged > 0) {
    console.log(`left ${unchanged} card(s) untouched — nothing but the timestamp would change.`);
  }

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
