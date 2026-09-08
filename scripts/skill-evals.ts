#!/usr/bin/env bun
/**
 * The inner loop for the agent skills in `.claude/skills/`.
 *
 * A full `tessl eval run` over every scenario, both variants, three runs each,
 * is sixty agent solves — most of a working day and hundreds of credits.
 * Almost none of that work is needed to answer the question a skill edit
 * actually asks, which is "did this scenario move". These subcommands narrow
 * the run to the skills the diff touched, and keep a committed scoreboard so
 * the next run has something to be compared against.
 *
 *   changed      --base <ref>              skills whose files the diff touched
 *   subset       --skills a,b --out <dir>  their scenarios, copied for a run
 *   fingerprint  <scenario-dir>            hash of everything but the skill
 *   check-names                            every scenario names a real skill
 *   plan                                   what a run now would cost, and why
 *   ready        --run <view.json>         has every variant been scored yet
 *   compare      --run <view.json>         markdown table against the scoreboard
 *   record       --run <view.json>         write those scores back
 *
 * `compare` is deliberately not a gate. At `-n 1` a scenario's score swings
 * further between identical runs than most real regressions do, so the table
 * is for a human to read in the pull request. The gate is `tessl review run
 * quality`, which is deterministic.
 */
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SKILLS_DIR = ".claude/skills";
const EVALS_DIR = ".claude/evals";
const SCOREBOARD = join(EVALS_DIR, "scores.json");
const QUALITY = join(EVALS_DIR, "quality.json");

/** How far a scenario has to fall against the scoreboard before a human is
 * asked to look. Per-scenario aggregates have a mean standard deviation of 9
 * points across runs at `-n 3`, with observed ranges to 36, and CI runs at
 * `-n 1`, which is noisier still. One run of `prep-pr` scored 3/3 on one
 * scenario and 0/3 on another with identical skill text. So this is set where
 * a drop is worth a person's attention rather than where it is significant —
 * there is no threshold at `-n 1` that means "significant". */
const EVAL_DROP_PTS = 25;

/** The quality gate is deterministic: the same SKILL.md scores the same twice.
 * A drop of this size is therefore real, and unlike an eval delta it can be
 * acted on without a second opinion. */
const QUALITY_DROP_PTS = 5;
const QUALITY_FLOOR = 70;

/** The files that decide what a scenario asks. The skill under test is not one
 * of them — that is the whole point: a score is comparable across skill edits
 * and nothing else. */
const FIXTURE_FILES = ["scenario.json", "task.md", "criteria.json", "setup.sh"];

interface ScoreRow {
  skill: string;
  fixtureHash: string;
  fingerprint: string | null;
  agent: string;
  model: string;
  runs: number;
  variant: string;
  score: number;
  points: string;
  baseline?: number | null;
  /** Hash of every `SKILL.md` as it stood when this score was recorded. It is
   * deliberately NOT part of `fingerprint`: a score stays comparable across
   * skill edits, which is the whole point of the loop. It is here so `plan`
   * can tell a run that changed only the skills from one that changed the
   * scenarios too, because the second cannot attribute a movement to either. */
  skillsHash?: string;
  items: Record<string, string>;
  runId: string;
  recordedAt: string;
}

type Scoreboard = { scenarios: Record<string, ScoreRow> };

function listSkills(): string[] {
  if (!existsSync(SKILLS_DIR)) return [];
  return readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function listScenarios(): string[] {
  if (!existsSync(EVALS_DIR)) return [];
  return readdirSync(EVALS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(EVALS_DIR, e.name, "scenario.json")))
    .map((e) => e.name)
    .sort();
}

/** A scenario belongs to the skill whose name is the longest prefix of its
 * directory name. Longest wins so `review-security-…` is not claimed by a
 * hypothetical `review` skill. */
function skillOf(scenario: string, skills: string[]): string | null {
  const owners = skills
    .filter((s) => scenario === s || scenario.startsWith(`${s}-`))
    .sort((a, b) => b.length - a.length);
  return owners[0] ?? null;
}

/** Memoised for the process. `compare` walks the scenarios twice — once for the
 * table, once for the moved-items block — and hashed the same four files each
 * time. Nothing rewrites a scenario mid-run, so one hash per directory holds. */
const fixtureHashes = new Map<string, string>();

function fixtureHash(scenarioDir: string): string {
  const memo = fixtureHashes.get(scenarioDir);
  if (memo !== undefined) return memo;
  const hash = createHash("sha256");
  for (const file of FIXTURE_FILES) {
    const path = join(scenarioDir, file);
    hash.update(file);
    // Read and catch rather than stat-then-read: the miss is the rare case, and
    // `existsSync` bought a second syscall per file on every hash.
    let body: Buffer;
    try {
      body = readFileSync(path);
    } catch {
      body = Buffer.from("<absent>");
    }
    hash.update(body);
  }
  const digest = `sha256:${hash.digest("hex").slice(0, 32)}`;
  fixtureHashes.set(scenarioDir, digest);
  return digest;
}

/** Every `SKILL.md` under `.claude/skills`, hashed together. Reference files
 * beside a skill are deliberately included: a skill that moves detail into
 * `reference/` has still changed what the agent can read. */
function skillsHash(): string {
  const hash = createHash("sha256");
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true })
      .flatMap((e) =>
        e.isDirectory()
          ? walk(join(dir, e.name))
          : e.name.endsWith(".md")
            ? [join(dir, e.name)]
            : [],
      )
      .sort();
  if (!existsSync(SKILLS_DIR)) return "sha256:<absent>";
  for (const file of walk(SKILLS_DIR)) {
    hash.update(file);
    hash.update(readFileSync(file));
  }
  return `sha256:${hash.digest("hex").slice(0, 32)}`;
}

function readScoreboard(): Scoreboard {
  if (!existsSync(SCOREBOARD)) return { scenarios: {} };
  return JSON.parse(readFileSync(SCOREBOARD, "utf8")) as Scoreboard;
}

/** Pull the with-context scores out of `tessl eval view --json`. The baseline
 * variant is skipped in the inner loop, so a run usually carries one solution
 * per scenario; when both are present the context variant is the one that
 * moves with a skill edit. */
function parseRun(viewJson: string) {
  const doc = JSON.parse(viewJson) as {
    data: {
      id: string;
      attributes: {
        status: string;
        agent?: string;
        model?: string;
        runCount?: number;
        expectedVariants?: string[];
        scenarios: {
          path?: string;
          fingerprint?: string;
          solutions: {
            variant: string;
            assessmentResults?: { name: string; score: number; max_score: number }[];
            runs?: { status?: string; score?: number | null }[];
          }[];
        }[];
      };
    };
  };
  const attrs = doc.data.attributes;
  const rows = new Map<
    string,
    {
      fingerprint: string | null;
      variant: string;
      items: Record<string, string>;
      score: number;
      points: string;
      baseline: { score: number; points: string } | null;
    }
  >();

  for (const scenario of attrs.scenarios ?? []) {
    // `path` is the scenario directory as the CLI saw it, e.g.
    // `.claude/evals/<name>/` or `evals/<name>`. Take the last real segment.
    const name = (scenario.path ?? "").split("/").filter(Boolean).pop();
    if (!name) continue;
    const solution =
      scenario.solutions?.find((s) => s.variant !== "baseline") ?? scenario.solutions?.[0];
    const results = solution?.assessmentResults ?? [];
    if (!solution || results.length === 0) continue;

    const scored = results.reduce((sum, r) => sum + r.score, 0);
    const total = results.reduce((sum, r) => sum + r.max_score, 0);

    // The only comparison that is always valid. A stored score is comparable
    // to this run only if the fixture AND the rubric that produced it still
    // ship; the baseline was judged by today's rubric, in this run, on this
    // fixture, by the same agent — so it answers "is the skill earning its
    // place" even when history is void. It is absent on a `--skip-baseline`
    // inner-loop run, which is the point of that flag.
    const base = scenario.solutions?.find((s) => s.variant === "baseline");
    const baseResults = base?.assessmentResults ?? [];
    const baseScored = baseResults.reduce((sum, r) => sum + r.score, 0);
    const baseTotal = baseResults.reduce((sum, r) => sum + r.max_score, 0);

    rows.set(name, {
      fingerprint: scenario.fingerprint ?? null,
      variant: solution.variant,
      items: Object.fromEntries(results.map((r) => [r.name, `${round(r.score)}/${r.max_score}`])),
      score: total === 0 ? 0 : scored / total,
      points: `${round(scored)}/${total}`,
      baseline:
        baseResults.length === 0 || baseTotal === 0
          ? null
          : { score: baseScored / baseTotal, points: `${round(baseScored)}/${baseTotal}` },
    });
  }

  // `status` lags. A run whose every solution carries a scored rubric has
  // reported `pending` for over an hour here, so waiting on the field alone
  // would hang a CI job until its timeout. What the caller actually needs to
  // know is whether every expected variant of every scenario has been scored,
  // and that is answerable from the payload.
  //
  // A solution grows an `assessmentResults` array as soon as its FIRST run is
  // judged, so "has a rubric" is not "is finished" — run 7 satisfied that test
  // 54 minutes in with 17 of 20 solutions still on one scored run out of three,
  // and the numbers it handed back were single-sample noise wearing an n=3
  // label. Require the full complement: `runCount` entries in `runs`, each
  // carrying a score. A run that genuinely produced nothing scores 0, not null,
  // so a null here means still working rather than legitimately empty.
  const expected = attrs.expectedVariants ?? [];

  // `runs[]` and `runCount` are present only on a multi-run payload. An `-n 1`
  // run — which is what the CI inner loop submits — carries neither, so a
  // predicate that demands them waits for a field that never arrives: the first
  // `--skip-baseline -n 1` run sat through a 90-minute poll having finished
  // before the poll began. Absent means "one run, and the rubric is the whole
  // signal"; present means check every entry.
  const wanted = attrs.runCount ?? 0;

  // A run whose top-level status is terminal will never gain another score, so
  // waiting for its missing ones is waiting forever. `status` lags only in one
  // direction — pending until after scoring finishes — and never goes back, so
  // "failed" and "completed" are both safe to treat as the end. Run 9 ended
  // `failed` with 58 of 60 solves scored: one agent task that failed three
  // attempts outright, and one that ran 73 minutes and then exited 1. Two
  // solutions were left on two samples of three, which is a thinner
  // measurement, not an absent one — the judge averages the runs that scored.
  const terminal = attrs.status === "failed" || attrs.status === "completed";

  const complete = (solution: { runs?: { score?: number | null }[] }) => {
    const runs = solution.runs;
    if (runs === undefined || runs.length === 0) return wanted <= 1;
    const good = runs.filter((r) => typeof r.score === "number").length;
    if (good === 0) return false;
    return terminal || (runs.length >= wanted && good === runs.length);
  };

  /** Solutions carrying fewer scored runs than the run asked for. Reported so a
   * thin cell is visible in the log rather than silently averaged. */
  const short = (attrs.scenarios ?? []).flatMap((scenario) =>
    (scenario.solutions ?? [])
      .filter((s) => {
        const good = (s.runs ?? []).filter((r) => typeof r.score === "number").length;
        return (s.runs ?? []).length > 0 && good < wanted;
      })
      .map(
        (s) =>
          // `path` is optional on the payload and the loop above already
          // guards it. It must be guarded here too: a scenario without one
          // crashed `ready`, `compare` and `record` alike, and inside CI's
          // poll that reads as "the run was never scored" for a run that was.
          `${(scenario.path ?? "").split("/").filter(Boolean).pop() ?? "?"} [${s.variant}]: ${(s.runs ?? []).filter((r) => typeof r.score === "number").length}/${wanted}`,
      ),
  );
  const scored =
    (attrs.scenarios ?? []).length > 0 &&
    (attrs.scenarios ?? []).every((scenario) =>
      (expected.length > 0 ? expected : ["usage-spec"]).every((variant) =>
        (scenario.solutions ?? []).some(
          (s) => s.variant === variant && (s.assessmentResults ?? []).length > 0 && complete(s),
        ),
      ),
    );

  return {
    runId: doc.data.id,
    status: attrs.status,
    scored,
    agent: attrs.agent ?? "unknown",
    model: attrs.model ?? "unknown",
    runs: attrs.runCount ?? 1,
    short,
    scenarios: rows,
  };
}

const round = (n: number) => Math.round(n * 100) / 100;
const pct = (n: number) => `${Math.round(n * 100)}%`;

function readArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function cmdChanged() {
  const base = readArg("--base") ?? "origin/main";
  const proc = Bun.spawnSync(["git", "diff", "--name-only", `${base}...HEAD`]);
  if (proc.exitCode !== 0) fail(`git diff against ${base} failed: ${proc.stderr.toString()}`);
  const files = proc.stdout.toString().split("\n").filter(Boolean);
  const skills = listSkills().filter((s) => files.some((f) => f.startsWith(`${SKILLS_DIR}/${s}/`)));
  for (const skill of skills) console.log(skill);
}

/** A skill with no scenario is the normal state, not an error.
 *
 * Most skills have never had one written — `orchestrate`, `stress-plan`,
 * `rate-complexity`, `setup-osn` and `review-deps` among them — so a branch
 * that edits one has nothing to narrow a run to. Failing there reddens the
 * check on a pull request that has done nothing wrong, and a red check nobody
 * can act on is a check people learn to ignore. So an empty pick writes no
 * scenario, prints nothing on stdout and exits 0; the caller reads the empty
 * stdout and skips the run.
 *
 * A name that is not a skill at all still fails. That one is a typo, and the
 * whole point of the exit code is to catch the case a human can fix. */
function cmdSubset() {
  const out = readArg("--out") ?? fail("subset needs --out <dir>");
  const wanted = (readArg("--skills") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (wanted.length === 0) fail("subset needs --skills a,b");

  const skills = listSkills();
  const unknown = wanted.filter((s) => !skills.includes(s));
  if (unknown.length > 0) {
    fail(
      `not a skill in ${SKILLS_DIR}/: ${unknown.join(", ")}\n` +
        `Known skills: ${skills.join(", ")}`,
    );
  }

  const picked = listScenarios().filter((s) => {
    const owner = skillOf(s, skills);
    return owner !== null && wanted.includes(owner);
  });

  mkdirSync(out, { recursive: true });
  if (picked.length === 0) {
    console.error(`No scenarios cover: ${wanted.join(", ")}. Nothing to run.`);
    return;
  }

  for (const scenario of picked)
    cpSync(join(EVALS_DIR, scenario), join(out, scenario), { recursive: true });
  for (const scenario of picked) console.log(scenario);
}

function cmdFingerprint() {
  const dir = process.argv[3] ?? fail("fingerprint needs a scenario directory");
  console.log(fixtureHash(dir));
}

/** A scenario whose directory does not start with a skill's name is invisible
 * to `subset`, so it silently stops running the moment CI narrows a run. That
 * is a failure nobody notices, which is the kind worth a check. */
function cmdCheckNames() {
  const skills = listSkills();
  const scenarios = listScenarios();
  const orphans = scenarios.filter((s) => skillOf(s, skills) === null);
  if (orphans.length > 0) {
    fail(
      `Scenario directories must begin with the name of a skill in ${SKILLS_DIR}/.\n` +
        `Orphaned: ${orphans.join(", ")}\nKnown skills: ${skills.join(", ")}`,
    );
  }
  console.log(`${scenarios.length} scenarios, all owned by a skill.`);
}

function requireScored(run: ReturnType<typeof parseRun>) {
  if (!run.scored) {
    fail(`run ${run.runId} is not fully scored yet (status: ${run.status})`);
  }
}

/** What a run right now would cost, and whether it could attribute the result.
 *
 * Two facts drive it. A scenario whose fingerprint is unchanged is REPLAYED
 * rather than re-executed — both variants, not only the baseline — so it is
 * free. And a run that changes the skills *and* the scenarios in the same step
 * cannot tell which of them moved a score: the baseline moves too, and there is
 * no longer a fixed point to measure against.
 *
 * Run this before submitting. Thirty of run 9's sixty solves were baselines
 * that would have replayed for nothing if the rubrics had been left alone that
 * round. */
function cmdPlan() {
  const board = readScoreboard();
  const skills = listSkills();
  const now = skillsHash();
  const scenarios = listScenarios();

  const fresh: string[] = [];
  const replay: string[] = [];
  const unseen: string[] = [];
  for (const name of scenarios) {
    const before = board.scenarios[name];
    if (before === undefined) unseen.push(name);
    else if (before.fixtureHash !== fixtureHash(join(EVALS_DIR, name))) fresh.push(name);
    else replay.push(name);
  }

  const recorded = Object.values(board.scenarios)
    .map((r) => r.skillsHash)
    .filter((h): h is string => typeof h === "string");
  const skillsMoved = recorded.length === 0 || recorded.some((h) => h !== now);

  console.log(
    `Scenarios: ${scenarios.length} (${replay.length} unchanged, ${fresh.length} changed, ${unseen.length} never scored)`,
  );
  console.log(
    `Skills:    ${skills.length}, hash ${now}${skillsMoved ? " — CHANGED since the scoreboard" : " — unchanged since the scoreboard"}`,
  );
  console.log("");
  // The cache key is the scenario fingerprint AND the injected context, so the
  // two variants of an unchanged scenario stop behaving alike the moment a
  // skill is edited: the baseline carries no context and replays, while the
  // usage-spec variant is a different input and re-solves. Counting an
  // unchanged scenario as wholly free is how a "half price" run turns out to
  // cost two thirds.
  const paid = (replay.length * (skillsMoved ? 1 : 0) + (fresh.length + unseen.length) * 2) * 3;

  if (replay.length > 0) {
    console.log(
      `Unchanged (${replay.length})${skillsMoved ? " — baseline replays, usage-spec re-solves" : " — both variants replay"}:`,
    );
    for (const n of replay) console.log(`  ${n}`);
  }
  if (fresh.length + unseen.length > 0) {
    console.log(`Changed (${fresh.length + unseen.length}) — both variants re-solve:`);
    for (const n of [...fresh, ...unseen].sort()) console.log(`  ${n}`);
  }
  console.log("");
  console.log(`≈ ${paid} paid solve(s) at -n 3, of ${scenarios.length * 2 * 3} total`);

  if (skillsMoved && fresh.length > 0) {
    console.log("");
    console.log(
      "WARNING: the skills and " + String(fresh.length) + " scenario(s) have both changed since",
    );
    console.log("the scoreboard was written. A movement in those scenarios cannot be");
    console.log("attributed to either — their baselines are being re-judged by a new");
    console.log("rubric in the same run. Land the rubric edits on their own first, or");
    console.log("read those rows as new measurements rather than as a comparison.");
  }
}

type QualityBoard = { skills: Record<string, { score: number; recordedAt: string }> };

/** Skill name to percentage, as `tessl review run quality` prints it. Named
 * rather than inline so the shape has one owner: the workflow builds it, both
 * quality subcommands read it, and the board stores it. */
type QualityScores = Record<string, number>;

function readQuality(): QualityBoard {
  if (!existsSync(QUALITY)) return { skills: {} };
  return JSON.parse(readFileSync(QUALITY, "utf8")) as QualityBoard;
}

/** `--scores '{"review-tests":91,...}'`, as printed by `tessl review run
 * quality`. Kept as an argument rather than shelling out to `tessl` so the
 * comparison is testable without a network or a credit. */
function parseScoresArg() {
  const raw = readArg("--scores") ?? fail("needs --scores '<json>'");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail(`--scores is not JSON: ${raw}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("--scores must be a JSON object of skill name to score");
  }
  const out: QualityScores = {};
  for (const [name, score] of Object.entries(parsed)) {
    if (typeof score !== "number" || !Number.isFinite(score)) {
      fail(`score for ${name} is not a number: ${JSON.stringify(score)}`);
    }
    out[name] = score;
  }
  return out;
}

/** Compare fresh quality scores against the committed ones. Exits non-zero on a
 * regression, so CI can open an issue — this is the one signal in the loop
 * deterministic enough to file against without a human first. */
function cmdQualityCheck() {
  const now = parseScoresArg();
  const board = readQuality();
  const regressions: string[] = [];
  const lines = ["| Skill | Before | Now | Δ |", "|---|---|---|---|"];

  for (const [name, score] of Object.entries(now).sort()) {
    const before = board.skills[name];
    const delta = before === undefined ? null : round(score - before.score);
    lines.push(
      `| \`${name}\` | ${before === undefined ? "—" : `${before.score}%`} | ${score}% | ${
        delta === null ? "new" : delta > 0 ? `+${delta}` : String(delta)
      } |`,
    );
    if (score < QUALITY_FLOOR) {
      regressions.push(`\`${name}\` scored ${score}%, under the ${QUALITY_FLOOR}% threshold.`);
    } else if (delta !== null && delta <= -QUALITY_DROP_PTS) {
      regressions.push(
        `\`${name}\` fell ${Math.abs(delta)} points, ${before?.score}% to ${score}%.`,
      );
    }
  }

  console.log(lines.join("\n"));
  if (regressions.length > 0) {
    console.log("");
    for (const r of regressions) console.log(`REGRESSION: ${r}`);
    process.exit(1);
  }
}

/** Write the fresh scores back, so the next run has something to compare to. */
function cmdQualityRecord() {
  const now = parseScoresArg();
  const board = readQuality();
  const today = new Date().toISOString().slice(0, 10);
  for (const [name, score] of Object.entries(now))
    board.skills[name] = { score, recordedAt: today };
  const ordered = Object.fromEntries(
    Object.entries(board.skills).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(QUALITY, `${JSON.stringify({ skills: ordered }, null, 2)}\n`);
  console.log(`Recorded ${Object.keys(now).length} quality score(s) into ${QUALITY}.`);
}

/** The poll predicate for CI. `tessl eval run` returns the moment a run is
 * queued, so something has to wait; `status` is not that something. */
function cmdReady() {
  const runPath = readArg("--run") ?? fail("ready needs --run <view.json>");
  const run = parseRun(readFileSync(runPath, "utf8"));
  // A payload can satisfy the scoring predicate and still yield no rows — every
  // scenario missing its `path`, for one. Reporting "ready" for nothing is
  // worse than reporting "not ready", because the caller goes on to record it.
  if (run.scored && run.scenarios.size === 0) {
    fail(`run ${run.runId} scored, but no scenario in it could be identified`);
  }
  if (!run.scored) {
    console.log(`not ready (status: ${run.status})`);
    process.exit(1);
  }
  console.log(`scored: ${run.scenarios.size} scenario(s)`);
  for (const line of run.short) console.log(`  thin: ${line}`);
}

function cmdCompare() {
  const runPath = readArg("--run") ?? fail("compare needs --run <view.json>");
  const run = parseRun(readFileSync(runPath, "utf8"));
  requireScored(run);
  const board = readScoreboard();
  const skills = listSkills();

  const lines = [
    `### Skill eval — \`${run.agent}:${run.model}\`, n=${run.runs}, ${run.scenarios.size} scenario(s)`,
    "",
    "| Scenario | Skill | Now | vs baseline | Before | Δ |",
    "|---|---|---|---|---|---|",
  ];

  for (const [name, now] of [...run.scenarios].sort()) {
    const before = board.scenarios[name];
    const hash = fixtureHash(join(EVALS_DIR, name));
    const skill = skillOf(name, skills) ?? "—";
    let previous = "—";
    let delta = "new scenario";

    if (before) {
      previous = `${pct(before.score)} (${before.points})`;
      if (before.fixtureHash !== hash) {
        // The hash covers `scenario.json`, `task.md`, `criteria.json` and
        // `setup.sh`, so this fires on a rubric edit as readily as on a new
        // fixture commit. Either way the stored number was produced by a
        // different question and cannot be subtracted from this one.
        delta = "**history void** — the scenario changed";
      } else if (
        before.model !== run.model ||
        before.agent !== run.agent ||
        before.runs !== run.runs
      ) {
        delta = `**not comparable** — was \`${before.agent}:${before.model}\`, n=${before.runs}`;
      } else {
        const points = round((now.score - before.score) * 100);
        delta = points === 0 ? "no change" : `${points > 0 ? "+" : ""}${points} pts`;
      }
    }
    const lift =
      now.baseline === null
        ? "— (skipped)"
        : `${pct(now.baseline.score)} (${now.baseline.points}) · ${
            round((now.score - now.baseline.score) * 100) >= 0 ? "+" : ""
          }${round((now.score - now.baseline.score) * 100)} pts`;
    lines.push(
      `| \`${name}\` | ${skill} | ${pct(now.score)} (${now.points}) | ${lift} | ${previous} | ${delta} |`,
    );
  }

  // Per-item movement, which is where a real regression is legible. A total
  // that holds still can hide a ground-truth check going to zero while a
  // formatting check makes the points back.
  const moved: string[] = [];
  for (const [name, now] of run.scenarios) {
    const before = board.scenarios[name];
    if (!before || before.fixtureHash !== fixtureHash(join(EVALS_DIR, name))) continue;
    for (const [item, score] of Object.entries(now.items)) {
      const was = before.items[item];
      if (was !== undefined && was !== score)
        moved.push(`- \`${name}\` · \`${item}\`: ${was} → ${score}`);
    }
  }
  if (moved.length > 0)
    lines.push("", "<details><summary>Items that moved</summary>", "", ...moved, "</details>");

  // A scenario far enough down to be worth a person's attention. This is NOT a
  // significance test — at `-n 1` there is no threshold that means significant,
  // and the same skill text has scored 3/3 and 0/3 on two scenarios of one run.
  // It is a prompt to look, which is why it labels the pull request rather than
  // filing anything. Only scenarios whose fixture is unchanged qualify: a moved
  // fixture makes the stored score answer a different question.
  const drops: string[] = [];
  for (const [name, now] of run.scenarios) {
    const before = board.scenarios[name];
    if (!before || before.fixtureHash !== fixtureHash(join(EVALS_DIR, name))) continue;
    const delta = round((now.score - before.score) * 100);
    if (delta <= -EVAL_DROP_PTS) {
      drops.push(
        `${name}: ${pct(before.score)} → ${pct(now.score)} (${delta} pts, threshold ${-EVAL_DROP_PTS})`,
      );
    }
  }
  if (drops.length > 0) {
    lines.push(
      "",
      `> **${drops.length} scenario(s) fell ${EVAL_DROP_PTS} points or more.** That is a prompt to`,
      "> look, not a verdict: at `-n 1` a scenario moves further on noise than most real",
      "> regressions do. Read the moved items above and the judge's reasoning before",
      "> concluding anything.",
      "",
      ...drops.map((d) => `> - ${d}`),
    );
  }

  lines.push("", `[Run ${run.runId}](https://tessl.io/workspaces/musubi/eval-runs/${run.runId})`);
  console.log(lines.join("\n"));
  // On stderr so it never lands in the pull-request comment: the workflow greps
  // for it to decide whether to label, and the comment is for a human.
  for (const d of drops) console.error(`NEEDS-DECISION: ${d}`);
}

function cmdRecord() {
  const runPath = readArg("--run") ?? fail("record needs --run <view.json>");
  const run = parseRun(readFileSync(runPath, "utf8"));
  requireScored(run);
  const board = readScoreboard();
  const skills = listSkills();
  const today = new Date().toISOString().slice(0, 10);
  // Hoisted: nothing in the loop below can change it, and inside the loop it
  // re-walked `.claude/skills` and re-read all nine files once per scenario.
  const skills_hash = skills.length > 0 ? skillsHash() : undefined;

  for (const [name, now] of run.scenarios) {
    board.scenarios[name] = {
      skill: skillOf(name, skills) ?? "unknown",
      fixtureHash: fixtureHash(join(EVALS_DIR, name)),
      fingerprint: now.fingerprint,
      agent: run.agent,
      model: run.model,
      runs: run.runs,
      variant: now.variant,
      score: round(now.score),
      points: now.points,
      // Stored so a later run can see whether the *lift* held, not only whether
      // the absolute score did. A skill can score the same while the model it
      // rides on improves underneath it, and that is the skill ceasing to earn
      // its place. Null on a `--skip-baseline` run.
      baseline: now.baseline === null ? null : round(now.baseline.score),
      skillsHash: skills_hash,
      items: now.items,
      runId: run.runId,
      recordedAt: today,
    };
  }

  const ordered = Object.fromEntries(
    Object.entries(board.scenarios).sort(([a], [b]) => a.localeCompare(b)),
  );
  writeFileSync(SCOREBOARD, `${JSON.stringify({ scenarios: ordered }, null, 2)}\n`);
  console.log(`Recorded ${run.scenarios.size} scenario(s) into ${SCOREBOARD}.`);
}

const commands = {
  changed: cmdChanged,
  subset: cmdSubset,
  fingerprint: cmdFingerprint,
  "check-names": cmdCheckNames,
  plan: cmdPlan,
  "quality-check": cmdQualityCheck,
  "quality-record": cmdQualityRecord,
  ready: cmdReady,
  compare: cmdCompare,
  record: cmdRecord,
} satisfies Record<string, () => void>;

const command = process.argv[2];
// `Object.hasOwn`, never `in` — `in` walks the prototype chain, so `toString`
// and `constructor` would pass this guard and then be called as a subcommand.
if (!command || !Object.hasOwn(commands, command)) {
  fail(`Usage: bun run scripts/skill-evals.ts <${Object.keys(commands).join("|")}> [flags]`);
}
commands[command as keyof typeof commands]();
