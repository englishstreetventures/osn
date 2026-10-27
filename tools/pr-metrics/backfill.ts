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

import type { BranchPull, Card, IssueReference, IssueSelection, SessionsRoots } from "./index.ts";
import {
  branchCards,
  buildCard,
  cardFileName,
  decideComplexity,
  defaultMetricsDir,
  defaultSessionsRoots,
  issueKey,
  issuesToRate,
  otherPullRequest,
  parseNumstat,
  ratingLabels,
  recordsByBranch,
  recordsInWindow,
  recordWindow,
  repoProjectPaths,
  resolveRepo,
  sameApartFromGeneratedAt,
  sameRepository,
  selectIssues,
  TRACKER_REPO,
} from "./index.ts";

/** A merged pull request as `gh pr list --json` returns it. Each linked issue
 * arrives with its GraphQL node id — unconditionally, not a field this tool
 * asked for by name (`--json` takes no nested selection; see
 * `issueLabelsById`'s doc comment). The issue is usually not in this
 * repository: see below. */
interface PullRequest {
  number: number;
  headRefName: string;
  mergedAt: string;
  baseRefOid: string;
  headRefOid: string;
  body?: string | null;
  closingIssuesReferences: IssueReference[];
}

/** The repository `backfill` reads when `--repo` is not given. */
const DEFAULT_REPO = "englishstreetventures/osn";

/**
 * The card to write, given the card already on disk: `next`; `next` carrying
 * the disk card's rating; or `null`, meaning leave the disk card as it is.
 * `selection` is what the pull request links, here and in other repositories.
 *
 * A backfill rebuilds every card it can cost, and a run whose label lookup
 * failed, or that can no longer read an issue, produces a card with a null
 * rating. Writing it over a card that holds one throws away the only record of
 * that rating, so the disk card's `complexity` is carried into the new card
 * when its `declared` is set and the new one is not, or when it is `confirmed`
 * and the new one is not. Its `issue` comes with it only when this run links
 * that issue to this repository: the card is public, and an issue block
 * written some other way may name another repository's issue or carry its
 * labels.
 *
 * Two cases are not a lowered rating, or cannot carry one:
 *
 * - `next` records `part-of`. That null is the rule's answer, not a failed
 *   read: the issue's rating describes more than the branch did. A rating
 *   looked up from the issue (`confirmed`, `unconfirmed`) is not carried into
 *   it; one a caller gave by hand is.
 * - The disk rating covers fewer issues than the rating sums now
 *   ({@link issuesToRate}) — a card older than version 3, which rates one
 *   issue, for a pull request that closes several. `declared` is now the sum
 *   over all of them, and one issue's rating under that label would count
 *   several issues of work at one issue's rating. A new sum is written; when
 *   this run has none either, the disk card is left as it is, on its old
 *   version and true to that version's meaning — unless its `issue` names an
 *   issue this run does not link here, or carries labels with no issue: a
 *   public card must not keep those, so the rebuilt card is written instead.
 */
export function keepRating(onDisk: unknown, next: Card, selection: IssueSelection): Card | null {
  if (onDisk === null || typeof onDisk !== "object") return next;

  const disk = onDisk as Partial<Pick<Card, "pr" | "issue" | "complexity">>;
  const old = disk.complexity;
  if (disk.pr?.number !== next.pr.number || old === null || typeof old !== "object") return next;

  const oldDeclared = typeof old.declared === "number" ? old.declared : null;
  const lowered =
    (oldDeclared !== null && next.complexity.declared === null) ||
    (old.method === "confirmed" && next.complexity.method !== "confirmed");
  if (!lowered) return next;

  const lookedUp = old.method === "confirmed" || old.method === "unconfirmed";
  if (next.complexity.method === "part-of" && lookedUp) return next;

  const diskIssue = disk.issue?.number;
  const linkedHere =
    typeof diskIssue === "number" &&
    (diskIssue === next.issue.number ||
      selection.closed.includes(diskIssue) ||
      selection.partOf.includes(diskIssue));

  const rated = issuesToRate(selection);
  const covered = typeof old.issues === "number" ? old.issues : oldDeclared === null ? 0 : 1;
  if (covered < rated.here.length + rated.elsewhere.length) {
    if (next.complexity.declared !== null) return next;
    const issueless =
      (diskIssue === null || diskIssue === undefined) && (disk.issue?.labels ?? []).length === 0;

    return linkedHere || issueless ? null : next;
  }

  return {
    ...next,
    issue: linkedHere && disk.issue !== undefined ? disk.issue : next.issue,
    complexity: { declared: oldDeclared, method: old.method, issues: covered },
  };
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
 * finding in the private `englishstreetventures/osn-tracker` repo instead — so the same
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
  // The canonical name, so a renamed owner or another case still compares
  // equal to the owner GitHub reports on each linked issue. Every call below
  // uses it too.
  const typedRepo = flag("repo") ?? DEFAULT_REPO;
  const repo = resolveRepo(typedRepo) ?? typedRepo;
  const limit = flag("limit") ?? "100";
  const outDir = flag("out-dir") ?? defaultMetricsDir();
  const sessionsDir: SessionsRoots = flag("sessions-dir") ?? defaultSessionsRoots();
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
    "number,headRefName,mergedAt,baseRefOid,headRefOid,body,closingIssuesReferences",
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
  // Pull requests with transcripts that still get no card: their records
  // cannot be separated from another pull request's, or another pull request's
  // card holds their file. Each is named on stderr as it happens.
  const heldBack: number[] = [];
  // Pull requests whose card on disk keeps a rating this run could not carry
  // into a rebuilt card, so the card was not rebuilt.
  const leftAsIs: number[] = [];
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

  // A merged pull request is credited with what its merge closed, GitHub's
  // references, and its body only names which one the branch was cut for.
  // Labels are fetched by node id (see `issueLabelsById`'s doc comment for why
  // not by number). A card's `issue.labels` come only from this repository's
  // issues. A pull request that links no issue here is rated from the tracker
  // issues it closes (`issuesToRate`), and those ids go in a call of their own
  // whose answer keeps only the `complexity:` pair (`ratingLabels`): a tracker
  // issue's `severity:`/`area:` labels must never reach a card committed in
  // this public repository, and a tracker this token cannot read must not cost
  // a public lookup. Keyed by pull-request number for the per-pull loop below.
  const selections = new Map(
    carded.map((pull) => [
      pull.number,
      selectIssues({
        body: pull.body ?? "",
        refs: pull.closingIssuesReferences ?? [],
        repo,
        closedFromBody: false,
      }),
    ]),
  );
  const localIssueIds = new Map<number, Map<number, string>>();
  for (const pull of carded) {
    const ids = new Map<number, string>();
    for (const ref of pull.closingIssuesReferences ?? []) {
      if (ref.id !== undefined && sameRepository(ref, repo)) ids.set(ref.number, ref.id);
    }
    localIssueIds.set(pull.number, ids);
  }
  const uniqueIssueIds = new Set<string>();
  for (const ids of localIssueIds.values()) for (const id of ids.values()) uniqueIssueIds.add(id);

  // Each tracker issue a pull request's rating sums, by `issueKey`, to its node id.
  const trackerIssueIds = new Map<number, Map<string, string>>();
  for (const pull of carded) {
    const wanted = new Set(
      issuesToRate(selections.get(pull.number) as IssueSelection)
        .elsewhere.filter((issue) => issue.repo.toLowerCase() === TRACKER_REPO)
        .map(issueKey),
    );
    const ids = new Map<string, string>();
    for (const ref of pull.closingIssuesReferences ?? []) {
      const key = issueKey({
        repo: `${ref.repository.owner.login}/${ref.repository.name}`,
        number: ref.number,
      });
      if (ref.id !== undefined && wanted.has(key)) ids.set(key, ref.id);
    }
    trackerIssueIds.set(pull.number, ids);
  }
  const uniqueTrackerIds = new Set<string>();
  for (const ids of trackerIssueIds.values())
    for (const id of ids.values()) uniqueTrackerIds.add(id);

  const [counts, files, labelsById, trackerLabelsById] = await Promise.all([
    commitCounts(repo, numbers),
    fileLists(repo, numbers),
    issueLabelsById([...uniqueIssueIds]),
    issueLabelsById([...uniqueTrackerIds]).then(
      (found) => new Map([...found].map(([id, names]) => [id, ratingLabels(names)])),
    ),
  ]);

  // Oldest merge first, so on a reused branch name the first pull request
  // meets `<slug>.json` before any later one does. The listing is newest first.
  carded.sort((a, b) => Date.parse(a.mergedAt) - Date.parse(b.mergedAt));

  for (const pull of carded) {
    const branch = pull.headRefName;

    // Every other pull request known on this branch name: this listing's, and
    // the cards already on disk, since `--limit` reaches back only so far.
    // Transcripts are joined by branch name alone, so on a reused name the
    // merges are what separate one pull request's records from another's.
    const onDiskCards = branchCards(outDir, branch);
    const others = new Map<number, BranchPull>();
    for (const other of pulls) {
      if (other.headRefName === branch && other.number !== pull.number) {
        others.set(other.number, {
          number: other.number,
          mergedAt: other.mergedAt,
          state: "MERGED",
        });
      }
    }
    for (const { card: other } of onDiskCards) {
      const number = other.pr.number;
      if (typeof number !== "number" || number === pull.number || others.has(number)) continue;
      const mergedAt = typeof other.pr.merged_at === "string" ? other.pr.merged_at : null;
      others.set(number, { number, mergedAt, state: mergedAt === null ? null : "MERGED" });
    }

    const window = recordWindow({ mergedAt: pull.mergedAt }, [...others.values()]);
    if (window.kind === "unplaceable") {
      process.stderr.write(
        `  ⚠️  #${pull.number}: \`${branch}\` also carried #${window.pull}, whose merge time is unknown — skipping rather than mixing their sessions.\n`,
      );
      heldBack.push(pull.number);
      continue;
    }

    // A pull request whose window holds nothing has no spend this machine can
    // show — its transcripts are gone, or were never here — and a zero card
    // reads like a cheap pull request.
    const records = recordsInWindow(byBranch.get(branch) ?? [], window);
    if (records.length === 0) {
      process.stderr.write(
        `  ⚠️  #${pull.number}: no records between the merges around it on \`${branch}\` — skipping.\n`,
      );
      heldBack.push(pull.number);
      continue;
    }

    // `<slug>.json` belongs to the pull request whose card is already there,
    // or else to the earliest merged one on the name; every later pull request
    // takes `<slug>-<pr>.json`.
    const slugOwner = onDiskCards.find(
      ({ file }) => file === cardFileName(branch, pull.number, true),
    )?.card.pr.number;
    const first =
      typeof slugOwner === "number"
        ? slugOwner === pull.number
        : [...others.values()].every(
            (other) =>
              other.mergedAt !== null && Date.parse(other.mergedAt) > Date.parse(pull.mergedAt),
          );

    const changed = files.get(pull.number) ?? [];

    // Only this repository's issues are recorded. A private tracker number on
    // a public card would reveal that the finding exists, and of its labels
    // only the `complexity:` pair is ever kept, for the rating.
    const selection: IssueSelection = selections.get(pull.number) ?? {
      issue: null,
      closed: [],
      partOf: [],
      foreign: false,
      closedElsewhere: [],
      partOfElsewhere: [],
      candidates: [],
    };
    const ids = localIssueIds.get(pull.number) ?? new Map<number, string>();
    // `null` marks an issue queried and unresolved — a transport error, or an
    // issue that vanished between merge and backfill — which reads as
    // `lookup-failed`, never as a checked issue with no rating.
    const issueLabels = new Map<number, string[] | null>(
      selection.closed.map((issue) => {
        const id = ids.get(issue);

        return [issue, id === undefined ? null : (labelsById.get(id) ?? null)];
      }),
    );
    // Tracker issues by `issueKey`, rating labels only; one with no id, or
    // whose node did not resolve, is absent and reads as `not-fetched`.
    const trackerIds = trackerIssueIds.get(pull.number) ?? new Map<string, string>();
    const labelsElsewhere = new Map<string, string[] | null>();
    for (const [key, id] of trackerIds) {
      const names = trackerLabelsById.get(id);
      if (names !== undefined) labelsElsewhere.set(key, names);
    }
    const complexity = decideComplexity(selection, issueLabels, labelsElsewhere);

    if (complexity.method === "lookup-failed") {
      const missing = selection.closed.filter((issue) => issueLabels.get(issue) === null);
      process.stderr.write(
        `  ⚠️  could not fetch labels for ${missing.map((n) => `#${n}`).join(", ")} (closed by PR #${pull.number}) — leaving complexity unrated rather than guessing.\n`,
      );
    }
    const unread = issuesToRate(selection).elsewhere.filter(
      (issue) => !labelsElsewhere.has(issueKey(issue)),
    );
    if (unread.length > 0) {
      process.stderr.write(
        `  ⚠️  could not read ${unread.map((issue) => `${issue.repo}#${issue.number}`).join(", ")} (closed by PR #${pull.number}) — recording not-fetched.\n`,
      );
    }
    if (complexity.unrated.length > 0) {
      process.stderr.write(
        `  ⚠️  ${complexity.unrated.join(", ")} (closed by PR #${pull.number}) carries no complexity: rating, so the sum is unknown.\n`,
      );
    }

    const issueNumber = selection.issue;
    const labels = issueNumber === null ? [] : (issueLabels.get(issueNumber) ?? []);

    // `cardFileName` goes through `branchSlug`, never a copy of its first step:
    // the inline version omitted the trailing `^-+|-+$` strip, so a branch name
    // ending in a character outside the class made `backfill` and `card` write
    // two different files for the same branch.
    const file = cardFileName(branch, pull.number, first);
    const path = `${outDir}/${file}`;
    const onDisk = existsSync(path) ? readCardFile(path) : null;

    // The review counts come from report files that are gone by merge time, so
    // the only source a backfill has is the card `retro` already wrote.
    const built = buildCard(
      records,
      parseNumstat(numstatFromApi(changed), counts.get(pull.number) ?? 0),
      {
        review: onDisk?.pr?.number === pull.number ? (onDisk.review ?? null) : null,
        branch: pull.headRefName,
        prNumber: pull.number,
        issueNumber,
        issueType: null,
        issueLabels: labels,
        declaredComplexity: complexity.declared,
        complexityMethod: complexity.method,
        complexityIssues: complexity.issues,
        baseSha: pull.baseRefOid,
        headSha: pull.headRefOid,
        mergedAt: pull.mergedAt,
        phase: "at-merge",
        generatedAt: new Date().toISOString(),
      },
    );

    const card = keepRating(onDisk, built, selection);
    if (card !== null && card !== built) {
      process.stderr.write(
        `  ⚠️  #${pull.number}: keeping the rating already on disk (${card.complexity.method} ${card.complexity.declared}) over this run's (${built.complexity.method} ${built.complexity.declared}).\n`,
      );
    }

    // `branchSlug` is not injective — `feat/x-`, `feat-x` and `feat/x` all slug
    // to `feat-x` — and this loop writes many cards in one pass. `card` writes
    // one per run and cannot see a clash; here it is visible, and a silently
    // overwritten card is indistinguishable from a pull request that was never
    // backfilled at all. The guard keys on the files this run has claimed, so a
    // card left untouched still holds its filename against a second branch, and
    // a card left by an earlier run is not mistaken for a clash.
    const existing = claimed.has(file) ? (onDisk?.pr?.branch ?? null) : null;
    if (existing !== null && existing !== pull.headRefName) {
      console.warn(
        `  ⚠️  slug collision on ${file}: \`${existing}\` and \`${pull.headRefName}\` — keeping the first, skipping #${pull.number}.`,
      );
      skipped.push(pull.number);
      continue;
    }

    // A card left by an earlier run for another pull request is that pull
    // request's record. Never write over it, as `card` never does.
    const owner = onDisk?.pr ? otherPullRequest(onDisk, pull.number) : null;
    if (owner !== null) {
      process.stderr.write(
        `  ⚠️  ${file} is the card for #${owner} — skipping #${pull.number} rather than writing over it.\n`,
      );
      heldBack.push(pull.number);
      continue;
    }

    claimed.add(file);

    if (card === null) {
      process.stderr.write(
        `  ⚠️  #${pull.number}: the card on disk rates fewer issues than the ${selection.closed.length} this pull request closes, and this run could not read their sum — leaving that card as it is.\n`,
      );
      leftAsIs.push(pull.number);
      continue;
    }

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

  if (leftAsIs.length > 0) {
    process.stdout.write(
      `left ${leftAsIs.length} card(s) as they were, each named above, rather than lose their rating: ${leftAsIs.join(", ")}\n`,
    );
  }

  if (heldBack.length > 0) {
    process.stdout.write(
      `held back ${heldBack.length} PR(s) with transcripts but no card, each named above: ${heldBack.join(", ")}\n`,
    );
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
