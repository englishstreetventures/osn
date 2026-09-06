// The script is a CLI with no exported functions, and every branch worth
// testing is a decision about a directory tree — which scenarios belong to a
// skill, whether a fixture moved, whether two runs are comparable. So these
// tests build a throwaway tree with its own `.claude/skills` and
// `.claude/evals`, run the real script inside it, and read what it prints.
//
// The script resolves `.claude/...` relative to the process's working
// directory, so pointing it at a fixture is a matter of `cwd`, with no copy of
// the script needed.

import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../skill-evals.ts", import.meta.url).pathname;

async function makeTree(skills: readonly string[], scenarios: readonly string[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "skill-evals-cli-"));
  for (const skill of skills) {
    await mkdir(join(dir, ".claude/skills", skill), { recursive: true });
    await writeFile(join(dir, ".claude/skills", skill, "SKILL.md"), `---\nname: ${skill}\n---\n`);
  }
  for (const scenario of scenarios) {
    const path = join(dir, ".claude/evals", scenario);
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "scenario.json"), `{"description":"${scenario}"}\n`);
    await writeFile(join(path, "task.md"), "# task\n");
    await writeFile(join(path, "criteria.json"), '{"type":"weighted_checklist","checklist":[]}\n');
    await writeFile(join(path, "setup.sh"), "#!/usr/bin/env bash\nset -euo pipefail\n");
  }
  return dir;
}

async function run(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(["bun", "run", SCRIPT, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

test("subset picks only the named skills' scenarios", async () => {
  const dir = await makeTree(
    ["prep-pr", "review-security", "review-tests"],
    ["prep-pr-one", "review-security-two", "review-tests-three"],
  );
  try {
    const out = join(dir, "out");
    const result = await run(
      dir,
      "subset",
      "--skills",
      "review-security,review-tests",
      "--out",
      out,
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n").sort()).toEqual([
      "review-security-two",
      "review-tests-three",
    ]);
    expect(await Bun.file(join(out, "review-security-two/task.md")).exists()).toBe(true);
    expect(await Bun.file(join(out, "prep-pr-one/task.md")).exists()).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// `review` would otherwise claim `review-security-two` and the scenario would
// run under the wrong skill's subset — silently, since both names are real.
test("a scenario belongs to the longest matching skill name", async () => {
  const dir = await makeTree(["review", "review-security"], ["review-security-two"]);
  try {
    const out = join(dir, "out");
    const wrong = await run(dir, "subset", "--skills", "review", "--out", out);
    expect(wrong.exitCode).toBe(1);
    const right = await run(
      dir,
      "subset",
      "--skills",
      "review-security",
      "--out",
      join(dir, "out2"),
    );
    expect(right.stdout.trim()).toBe("review-security-two");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("check-names fails on a scenario no skill owns", async () => {
  const dir = await makeTree(["prep-pr"], ["prep-pr-one", "orphaned-case"]);
  try {
    const result = await run(dir, "check-names");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("orphaned-case");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("check-names passes when every scenario names a skill", async () => {
  const dir = await makeTree(["prep-pr"], ["prep-pr-one"]);
  try {
    const result = await run(dir, "check-names");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("1 scenarios");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The hash exists to answer one question: may the previous score be compared
// with this one. Editing the skill must not move it; editing anything the
// scenario asks must.
test("the fixture hash ignores the skill and tracks the scenario", async () => {
  const dir = await makeTree(["prep-pr"], ["prep-pr-one"]);
  try {
    const before = (await run(dir, "fingerprint", ".claude/evals/prep-pr-one")).stdout.trim();

    await writeFile(
      join(dir, ".claude/skills/prep-pr/SKILL.md"),
      "---\nname: prep-pr\n---\nrewritten\n",
    );
    expect((await run(dir, "fingerprint", ".claude/evals/prep-pr-one")).stdout.trim()).toBe(before);

    await writeFile(join(dir, ".claude/evals/prep-pr-one/task.md"), "# a different task\n");
    expect((await run(dir, "fingerprint", ".claude/evals/prep-pr-one")).stdout.trim()).not.toBe(
      before,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function runJson(
  scenario: string,
  items: Record<string, [number, number]>,
  model = "deepseek-v4-flash",
) {
  return JSON.stringify({
    data: {
      id: "01a0-test",
      attributes: {
        status: "completed",
        agent: "claude",
        model,
        runCount: 1,
        expectedVariants: ["usage-spec"],
        scenarios: [
          {
            path: `.claude/evals/${scenario}`,
            fingerprint: "abc",
            solutions: [
              {
                variant: "usage-spec",
                runs: [{ status: "completed", score: 50 }],
                assessmentResults: Object.entries(items).map(([name, [score, max]]) => ({
                  name,
                  score,
                  max_score: max,
                })),
              },
            ],
          },
        ],
      },
    },
  });
}

test("compare reports a delta, and refuses one when the fixture moved", async () => {
  const dir = await makeTree(["prep-pr"], ["prep-pr-one"]);
  try {
    await writeFile(join(dir, "run.json"), runJson("prep-pr-one", { a: [1, 2] }));
    expect((await run(dir, "record", "--run", "run.json")).exitCode).toBe(0);

    await writeFile(join(dir, "run2.json"), runJson("prep-pr-one", { a: [2, 2] }));
    const improved = await run(dir, "compare", "--run", "run2.json");
    expect(improved.stdout).toContain("+50 pts");

    // Now the scenario itself asks something different, so the stored score
    // is not a comparison any more.
    await writeFile(
      join(dir, ".claude/evals/prep-pr-one/setup.sh"),
      "#!/usr/bin/env bash\necho different\n",
    );
    const void_ = await run(dir, "compare", "--run", "run2.json");
    expect(void_.stdout).toContain("history void");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compare refuses a delta across a model change", async () => {
  const dir = await makeTree(["prep-pr"], ["prep-pr-one"]);
  try {
    await writeFile(join(dir, "run.json"), runJson("prep-pr-one", { a: [1, 2] }));
    await run(dir, "record", "--run", "run.json");
    await writeFile(
      join(dir, "run2.json"),
      runJson("prep-pr-one", { a: [2, 2] }, "claude-sonnet-5"),
    );
    const result = await run(dir, "compare", "--run", "run2.json");
    expect(result.stdout).toContain("not comparable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Readiness is not `status`. A run whose every solution is scored has sat at
// `pending` for over an hour, so waiting on the field would hang CI until its
// timeout; a run with a variant still unscored is the real not-yet.
test("a scored run is ready even while its status still says pending", async () => {
  const dir = await makeTree(["prep-pr"], ["prep-pr-one"]);
  try {
    const doc = JSON.parse(runJson("prep-pr-one", { a: [1, 2] })) as {
      data: { attributes: { status: string } };
    };
    doc.data.attributes.status = "pending";
    await writeFile(join(dir, "run.json"), JSON.stringify(doc));
    expect((await run(dir, "ready", "--run", "run.json")).exitCode).toBe(0);
    expect((await run(dir, "record", "--run", "run.json")).exitCode).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a run with an expected variant still unscored is not ready", async () => {
  const dir = await makeTree(["prep-pr"], ["prep-pr-one"]);
  try {
    const doc = JSON.parse(runJson("prep-pr-one", { a: [1, 2] })) as {
      data: {
        attributes: {
          expectedVariants: string[];
          scenarios: { solutions: { variant: string; assessmentResults: unknown[] }[] }[];
        };
      };
    };
    doc.data.attributes.expectedVariants = ["baseline", "usage-spec"];
    doc.data.attributes.scenarios[0]!.solutions.push({
      variant: "baseline",
      assessmentResults: [],
    });
    await writeFile(join(dir, "run.json"), JSON.stringify(doc));
    expect((await run(dir, "ready", "--run", "run.json")).exitCode).toBe(1);
    expect((await run(dir, "compare", "--run", "run.json")).exitCode).toBe(1);
    expect((await run(dir, "record", "--run", "run.json")).exitCode).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A solution grows `assessmentResults` the moment its FIRST run is judged, so a
// rubric is not a finish line. Run 7 passed the old readiness test 54 minutes in
// with most solutions on one scored run out of three, and reported that
// single sample under an n=3 heading.
test("a run still in flight whose solutions are short of runCount is not ready", async () => {
  const dir = await makeTree(["prep-pr"], ["prep-pr-one"]);
  try {
    const doc = JSON.parse(runJson("prep-pr-one", { a: [1, 2] })) as {
      data: {
        attributes: {
          status: string;
          runCount: number;
          scenarios: { solutions: { runs: { status: string; score: number | null }[] }[] }[];
        };
      };
    };
    // "pending" is what a run in flight reports, and it is the only state in
    // which a missing score means "not yet" rather than "never".
    doc.data.attributes.status = "pending";
    doc.data.attributes.runCount = 3;
    doc.data.attributes.scenarios[0]!.solutions[0]!.runs = [
      { status: "completed", score: 50 },
      { status: "completed", score: null },
      { status: "completed", score: null },
    ];
    await writeFile(join(dir, "run.json"), JSON.stringify(doc));
    expect((await run(dir, "ready", "--run", "run.json")).exitCode).toBe(1);
    expect((await run(dir, "compare", "--run", "run.json")).exitCode).toBe(1);
    expect((await run(dir, "record", "--run", "run.json")).exitCode).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a run with every run of every solution scored is ready", async () => {
  const dir = await makeTree(["prep-pr"], ["prep-pr-one"]);
  try {
    const doc = JSON.parse(runJson("prep-pr-one", { a: [1, 2] })) as {
      data: {
        attributes: {
          runCount: number;
          scenarios: { solutions: { runs: { status: string; score: number | null }[] }[] }[];
        };
      };
    };
    doc.data.attributes.runCount = 3;
    doc.data.attributes.scenarios[0]!.solutions[0]!.runs = [
      { status: "completed", score: 50 },
      { status: "completed", score: 61 },
      { status: "completed", score: 0 },
    ];
    await writeFile(join(dir, "run.json"), JSON.stringify(doc));
    expect((await run(dir, "ready", "--run", "run.json")).exitCode).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The comparison that is always valid. A stored score survives only while its
// fixture and its rubric both still ship; the baseline was judged in this run,
// on this fixture, by today's rubric, so it answers "is the skill earning its
// place" even on a row whose history is void.
test("compare reports the skill against this run's own baseline", async () => {
  const dir = await makeTree(["prep-pr"], ["prep-pr-one"]);
  try {
    const doc = JSON.parse(runJson("prep-pr-one", { a: [9, 12] })) as {
      data: {
        attributes: {
          expectedVariants: string[];
          scenarios: {
            solutions: {
              variant: string;
              runs?: { status: string; score: number }[];
              assessmentResults: { name: string; score: number; max_score: number }[];
            }[];
          }[];
        };
      };
    };
    doc.data.attributes.expectedVariants = ["baseline", "usage-spec"];
    doc.data.attributes.scenarios[0]!.solutions.push({
      variant: "baseline",
      runs: [{ status: "completed", score: 50 }],
      assessmentResults: [{ name: "a", score: 6, max_score: 12 }],
    });
    await writeFile(join(dir, "run.json"), JSON.stringify(doc));
    const out = await run(dir, "compare", "--run", "run.json");
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("50% (6/12) · +25 pts");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compare says the baseline was skipped when the run had none", async () => {
  const dir = await makeTree(["prep-pr"], ["prep-pr-one"]);
  try {
    await writeFile(join(dir, "run.json"), runJson("prep-pr-one", { a: [9, 12] }));
    const out = await run(dir, "compare", "--run", "run.json");
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("— (skipped)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// An `-n 1` run — the CI inner loop's shape — carries neither `runCount` nor a
// `runs` array. Demanding them waits for a field that never arrives: the first
// `--skip-baseline -n 1` run sat through a 90-minute poll having finished
// before the poll began.
test("a single-run payload with no runs array is ready", async () => {
  const dir = await makeTree(["prep-pr"], ["prep-pr-one"]);
  try {
    const doc = JSON.parse(runJson("prep-pr-one", { a: [1, 2] })) as {
      data: {
        attributes: {
          runCount?: number;
          scenarios: { solutions: { runs?: unknown }[] }[];
        };
      };
    };
    delete doc.data.attributes.runCount;
    delete doc.data.attributes.scenarios[0]!.solutions[0]!.runs;
    await writeFile(join(dir, "run.json"), JSON.stringify(doc));
    expect((await run(dir, "ready", "--run", "run.json")).exitCode).toBe(0);
    expect((await run(dir, "record", "--run", "run.json")).exitCode).toBe(0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// But an empty `runs` array on a payload that announces three of them is a run
// still working, not a one-run payload.
test("an empty runs array is not ready when runCount says three", async () => {
  const dir = await makeTree(["prep-pr"], ["prep-pr-one"]);
  try {
    const doc = JSON.parse(runJson("prep-pr-one", { a: [1, 2] })) as {
      data: {
        attributes: { runCount: number; scenarios: { solutions: { runs: unknown[] }[] }[] };
      };
    };
    doc.data.attributes.runCount = 3;
    doc.data.attributes.scenarios[0]!.solutions[0]!.runs = [];
    await writeFile(join(dir, "run.json"), JSON.stringify(doc));
    expect((await run(dir, "ready", "--run", "run.json")).exitCode).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// `plan` answers the question that decides whether a run is worth submitting:
// which scenarios will actually be re-solved, and can the result be attributed
// to anything. A scenario whose fingerprint is unchanged is replayed for free,
// so the only paid work is the changed ones — and if the skills moved in the
// same step, the changed ones cannot be read as a comparison at all.

async function boardFor(
  dir: string,
  rows: Record<string, { fixtureHash: string; skillsHash?: string }>,
): Promise<void> {
  const scenarios = Object.fromEntries(
    Object.entries(rows).map(([name, r]) => [
      name,
      {
        skill: name.split("-")[0],
        fixtureHash: r.fixtureHash,
        skillsHash: r.skillsHash,
        fingerprint: null,
        agent: "claude",
        model: "m",
        runs: 3,
        variant: "usage-spec",
        score: 0.5,
        points: "5/10",
        items: {},
        runId: "r",
        recordedAt: "2026-09-03",
      },
    ]),
  );
  await writeFile(join(dir, ".claude/evals/scores.json"), JSON.stringify({ scenarios }, null, 2));
}

test("plan counts an unchanged scenario at one variant when the skills moved", async () => {
  const dir = await makeTree(["alpha"], ["alpha-one", "alpha-two"]);
  const one = (await run(dir, "fingerprint", ".claude/evals/alpha-one")).stdout.trim();
  await boardFor(dir, {
    "alpha-one": { fixtureHash: one },
    "alpha-two": { fixtureHash: "sha256:stale" },
  });

  const out = await run(dir, "plan");
  expect(out.exitCode).toBe(0);
  expect(out.stdout).toContain("1 unchanged, 1 changed");
  expect(out.stdout).toContain("Unchanged (1)");
  // The board rows carry no skillsHash, so the skills read as moved: the
  // unchanged scenario still pays for its usage-spec variant (1 x 3) and the
  // changed one pays for both (2 x 3).
  expect(out.stdout).toContain("≈ 9 paid solve(s)");
  expect(out.stdout).toContain("alpha-two");
  await rm(dir, { recursive: true, force: true });
});

test("plan warns when the skills and the scenarios both moved", async () => {
  const dir = await makeTree(["alpha"], ["alpha-one"]);
  await boardFor(dir, { "alpha-one": { fixtureHash: "sha256:stale", skillsHash: "sha256:old" } });

  const out = await run(dir, "plan");
  expect(out.stdout).toContain("Skills:");
  expect(out.stdout).toContain("CHANGED since the scoreboard");
  expect(out.stdout).toContain("cannot be");
  await rm(dir, { recursive: true, force: true });
});

test("plan does not warn when only the skills moved", async () => {
  const dir = await makeTree(["alpha"], ["alpha-one"]);
  const one = (await run(dir, "fingerprint", ".claude/evals/alpha-one")).stdout.trim();
  await boardFor(dir, { "alpha-one": { fixtureHash: one, skillsHash: "sha256:old" } });

  const out = await run(dir, "plan");
  expect(out.stdout).toContain("CHANGED since the scoreboard");
  expect(out.stdout).not.toContain("WARNING");
  await rm(dir, { recursive: true, force: true });
});

test("plan counts a scenario the scoreboard has never seen as paid for", async () => {
  const dir = await makeTree(["alpha"], ["alpha-one"]);
  await boardFor(dir, {});

  const out = await run(dir, "plan");
  expect(out.stdout).toContain("1 never scored");
  expect(out.stdout).toContain("Changed (1) — both variants re-solve");
  await rm(dir, { recursive: true, force: true });
});

// A run can end with casualties. Tessl marks it `failed`, the solves that did
// finish keep their scores, and the judge averages a solution over the runs
// that scored — so a thin cell is a thinner measurement, not an absent one.
// Waiting for the missing score is waiting forever, which is what run 9 did
// until this case existed.
test("a failed run is ready on the solves that did score, and says which are thin", async () => {
  const dir = await makeTree(["prep-pr"], ["prep-pr-one"]);
  try {
    const doc = JSON.parse(runJson("prep-pr-one", { a: [1, 2] })) as {
      data: {
        attributes: {
          status: string;
          runCount: number;
          scenarios: { solutions: { runs: { status: string; score: number | null }[] }[] }[];
        };
      };
    };
    doc.data.attributes.status = "failed";
    doc.data.attributes.runCount = 3;
    doc.data.attributes.scenarios[0]!.solutions[0]!.runs = [
      { status: "completed", score: 50 },
      { status: "completed", score: 60 },
      { status: "completed", score: null },
    ];
    await writeFile(join(dir, "run.json"), JSON.stringify(doc));

    const out = await run(dir, "ready", "--run", "run.json");
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("thin: prep-pr-one [usage-spec]: 2/3");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a failed run with a solution nothing scored is still not ready", async () => {
  const dir = await makeTree(["prep-pr"], ["prep-pr-one"]);
  try {
    const doc = JSON.parse(runJson("prep-pr-one", { a: [1, 2] })) as {
      data: {
        attributes: {
          status: string;
          runCount: number;
          scenarios: { solutions: { runs: { status: string; score: number | null }[] }[] }[];
        };
      };
    };
    doc.data.attributes.status = "failed";
    doc.data.attributes.runCount = 3;
    doc.data.attributes.scenarios[0]!.solutions[0]!.runs = [
      { status: "completed", score: null },
      { status: "completed", score: null },
      { status: "completed", score: null },
    ];
    await writeFile(join(dir, "run.json"), JSON.stringify(doc));
    expect((await run(dir, "ready", "--run", "run.json")).exitCode).toBe(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// `path` is optional on the payload — the API has returned scenarios without
// one. Every read of it has to guard, and one did not: `ready`, `compare` and
// `record` all died with `undefined is not an object` because `short` is
// computed on every parse. Inside CI's poll that reads as "the run was never
// scored" for a run that was scored, and the job burns its full timeout.

test("a scenario with no path does not crash the readiness parse", async () => {
  const dir = await makeTree(["prep-pr"], ["prep-pr-one"]);
  try {
    const doc = JSON.parse(runJson("prep-pr-one", { a: [1, 2] })) as {
      data: { attributes: { status: string; runCount: number; scenarios: { path?: string }[] } };
    };
    doc.data.attributes.status = "failed";
    doc.data.attributes.runCount = 3;
    delete doc.data.attributes.scenarios[0]!.path;
    await writeFile(join(dir, "run.json"), JSON.stringify(doc));

    const out = await run(dir, "ready", "--run", "run.json");
    expect(out.stderr).not.toContain("undefined is not an object");
    expect(out.stderr).not.toContain("TypeError");
    // Nothing could be identified, so this is not a run worth recording.
    expect(out.exitCode).toBe(1);
    expect(out.stderr).toContain("no scenario in it could be identified");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The thin-cell line names the scenario, so it reads the same `path` and has to
// survive the same absence.
test("a thin cell with no path is reported rather than crashing", async () => {
  const dir = await makeTree(["prep-pr"], ["prep-pr-one", "prep-pr-two"]);
  try {
    const doc = JSON.parse(runJson("prep-pr-one", { a: [1, 2] })) as {
      data: {
        attributes: {
          status: string;
          runCount: number;
          scenarios: {
            path?: string;
            solutions: { runs: { status: string; score: number | null }[] }[];
          }[];
        };
      };
    };
    doc.data.attributes.status = "failed";
    doc.data.attributes.runCount = 3;
    doc.data.attributes.scenarios[0]!.solutions[0]!.runs = [
      { status: "completed", score: 50 },
      { status: "completed", score: 60 },
      { status: "completed", score: null },
    ];
    // A second scenario keeps a path, so a row survives and the run is ready.
    doc.data.attributes.scenarios.push({
      ...structuredClone(doc.data.attributes.scenarios[0]!),
      path: ".claude/evals/prep-pr-two",
    });
    delete doc.data.attributes.scenarios[0]!.path;
    await writeFile(join(dir, "run.json"), JSON.stringify(doc));

    const out = await run(dir, "ready", "--run", "run.json");
    expect(out.stderr).not.toContain("TypeError");
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("thin: ? [usage-spec]: 2/3");
    expect(out.stdout).toContain("thin: prep-pr-two [usage-spec]: 2/3");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// The quality gate is the one deterministic signal in this loop: the same
// SKILL.md scores the same twice. That is what makes it safe to file an issue
// against automatically, where an eval delta is not.

test("quality-check passes an unchanged score and flags a real drop", async () => {
  const dir = await makeTree(["alpha", "beta"], []);
  try {
    await mkdir(join(dir, ".claude/evals"), { recursive: true });
    await writeFile(
      join(dir, ".claude/evals/quality.json"),
      JSON.stringify({ skills: { alpha: { score: 90, recordedAt: "2026-09-01" } } }),
    );

    const same = await run(dir, "quality-check", "--scores", '{"alpha":90}');
    expect(same.exitCode).toBe(0);
    expect(same.stdout).toContain("| `alpha` | 90% | 90% | 0 |");

    const drop = await run(dir, "quality-check", "--scores", '{"alpha":84}');
    expect(drop.exitCode).toBe(1);
    expect(drop.stdout).toContain("REGRESSION: `alpha` fell 6 points, 90% to 84%.");

    // Four points is inside what a reword can move without meaning anything.
    const small = await run(dir, "quality-check", "--scores", '{"alpha":86}');
    expect(small.exitCode).toBe(0);
    expect(small.stdout).not.toContain("REGRESSION");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("quality-check fails anything under the threshold, however it got there", async () => {
  const dir = await makeTree(["alpha"], []);
  try {
    await mkdir(join(dir, ".claude/evals"), { recursive: true });
    // No history at all: a new skill under the floor still has to fail.
    await writeFile(join(dir, ".claude/evals/quality.json"), JSON.stringify({ skills: {} }));
    const out = await run(dir, "quality-check", "--scores", '{"alpha":68}');
    expect(out.exitCode).toBe(1);
    expect(out.stdout).toContain("under the 70% threshold");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("quality-check refuses a --scores argument it cannot trust", async () => {
  const dir = await makeTree(["alpha"], []);
  try {
    expect((await run(dir, "quality-check", "--scores", "not json")).exitCode).toBe(1);
    expect((await run(dir, "quality-check", "--scores", "[90]")).exitCode).toBe(1);
    const bad = await run(dir, "quality-check", "--scores", '{"alpha":"91%"}');
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr).toContain("is not a number");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("quality-record round-trips into a comparison", async () => {
  const dir = await makeTree(["alpha"], []);
  try {
    await mkdir(join(dir, ".claude/evals"), { recursive: true });
    await run(dir, "quality-record", "--scores", '{"alpha":93}');
    const out = await run(dir, "quality-check", "--scores", '{"alpha":93}');
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toContain("| `alpha` | 93% | 93% | 0 |");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// A large eval drop labels the pull request; it never files and never fails.
// The marker goes to stderr so it cannot land in the comment a human reads.

test("compare marks a scenario that fell past the threshold, on stderr only", async () => {
  const dir = await makeTree(["prep-pr"], ["prep-pr-one"]);
  try {
    const hash = (await run(dir, "fingerprint", ".claude/evals/prep-pr-one")).stdout.trim();
    await boardFor(dir, { "prep-pr-one": { fixtureHash: hash } });
    // The board says 0.5; runJson's fixture scores 6/12 = 0.5 by default, so
    // give the board a much higher score to make this run read as a fall.
    const board = JSON.parse(await Bun.file(join(dir, ".claude/evals/scores.json")).text()) as {
      scenarios: Record<string, { score: number }>;
    };
    board.scenarios["prep-pr-one"]!.score = 0.9;
    await writeFile(join(dir, ".claude/evals/scores.json"), JSON.stringify(board));

    await writeFile(join(dir, "run.json"), runJson("prep-pr-one", { a: [6, 12] }));
    const out = await run(dir, "compare", "--run", "run.json");
    expect(out.exitCode).toBe(0);
    expect(out.stderr).toContain("NEEDS-DECISION: prep-pr-one");
    expect(out.stdout).toContain("fell 25 points or more");
    expect(out.stdout).not.toContain("NEEDS-DECISION");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("compare stays quiet when the fixture moved, however far the score fell", async () => {
  const dir = await makeTree(["prep-pr"], ["prep-pr-one"]);
  try {
    await boardFor(dir, { "prep-pr-one": { fixtureHash: "sha256:stale" } });
    const board = JSON.parse(await Bun.file(join(dir, ".claude/evals/scores.json")).text()) as {
      scenarios: Record<string, { score: number }>;
    };
    board.scenarios["prep-pr-one"]!.score = 0.9;
    await writeFile(join(dir, ".claude/evals/scores.json"), JSON.stringify(board));

    await writeFile(join(dir, "run.json"), runJson("prep-pr-one", { a: [6, 12] }));
    const out = await run(dir, "compare", "--run", "run.json");
    expect(out.stderr).not.toContain("NEEDS-DECISION");
    expect(out.stdout).toContain("history void");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
