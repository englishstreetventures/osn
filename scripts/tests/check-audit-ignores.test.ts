import { expect, test } from "bun:test";

import { auditCommands, checkAuditIgnores } from "../check-audit-ignores";

const NOW = new Date("2026-10-09T12:00:00Z");
const BRACES = "GHSA-vfj7-8cjw-p6xm";
const CACHE = "GHSA-ch52-4w7c-c8xp";

/** A pre-push block shaped like the real one: comments above `run:`, a folded
 * `run: >` holding the command and its flags. */
function lefthook(options: { comments?: string[]; runLines?: string[]; extra?: string } = {}) {
  const comments = (options.comments ?? []).map((line) => `      ${line}`).join("\n");
  const runLines = (
    options.runLines ?? ["bun audit --audit-level=high", `--ignore=${BRACES}`, `--ignore=${CACHE}`]
  )
    .map((line) => `        ${line}`)
    .join("\n");

  return `pre-push:
  parallel: true
  commands:
    typecheck:
      run: bash scripts/pre-push-typecheck.sh
    audit:
${comments}
      run: >
${runLines}
${options.extra ?? ""}`;
}

const MARKED = [`# DROP AFTER ${BRACES} 2027-01-07`, `# DROP AFTER ${CACHE} 2027-01-07`];

test("ignores whose markers are all in date pass", () => {
  expect(checkAuditIgnores(lefthook({ comments: MARKED }), NOW)).toEqual([]);
});

test("an audit with no ignores needs no markers", () => {
  expect(checkAuditIgnores(lefthook({ runLines: ["bun audit --audit-level=high"] }), NOW)).toEqual(
    [],
  );
});

test("a marker dated today still passes — valid through the named date", () => {
  const text = lefthook({
    comments: [`# DROP AFTER ${BRACES} 2026-10-09`, `# DROP AFTER ${CACHE} 2026-10-09`],
  });

  expect(checkAuditIgnores(text, NOW)).toEqual([]);
});

test("a marker whose date has passed fails", () => {
  const text = lefthook({ comments: [`# DROP AFTER ${BRACES} 2026-10-08`, MARKED[1]!] });
  const findings = checkAuditIgnores(text, NOW);

  expect(findings).toHaveLength(1);
  expect(findings[0]!.name).toBe(BRACES);
  expect(findings[0]!.problem).toContain("has passed");
});

test("an ignore with no marker fails", () => {
  const findings = checkAuditIgnores(lefthook({ comments: [MARKED[0]!] }), NOW);

  expect(findings).toHaveLength(1);
  expect(findings[0]!.name).toBe(CACHE);
  expect(findings[0]!.problem).toContain(`no "# DROP AFTER ${CACHE} <YYYY-MM-DD>" marker`);
});

test("a marker for another advisory does not cover this one", () => {
  const text = lefthook({
    comments: [MARKED[0]!, "# DROP AFTER GHSA-2222-3333-4444 2027-01-07"],
  });
  const findings = checkAuditIgnores(text, NOW);

  expect(findings.map((f) => f.name)).toEqual([CACHE]);
});

test("a marker that is not a real calendar date fails", () => {
  const text = lefthook({ comments: [`# DROP AFTER ${BRACES} 2026-13-40`, MARKED[1]!] });
  const findings = checkAuditIgnores(text, NOW);

  expect(findings).toHaveLength(1);
  expect(findings[0]!.problem).toContain("not a real calendar date");
});

// `Date` rolls an out-of-range day into the next month instead of rejecting
// it: 2026-11-31 parses as 2026-12-01, 53 days out and otherwise valid.
test("a marker on a day the month does not have fails", () => {
  const text = lefthook({ comments: [`# DROP AFTER ${BRACES} 2026-11-31`, MARKED[1]!] });
  const findings = checkAuditIgnores(text, NOW);

  expect(findings).toHaveLength(1);
  expect(findings[0]!.problem).toContain("not a real calendar date");
});

test("a marker exactly 90 days out passes", () => {
  const text = lefthook({ comments: [`# DROP AFTER ${BRACES} 2027-01-07`, MARKED[1]!] });

  expect(checkAuditIgnores(text, NOW)).toEqual([]);
});

test("a marker 91 days out fails", () => {
  const text = lefthook({ comments: [`# DROP AFTER ${BRACES} 2027-01-08`, MARKED[1]!] });
  const findings = checkAuditIgnores(text, NOW);

  expect(findings).toHaveLength(1);
  expect(findings[0]!.problem).toContain("91 days out");
});

// bun matches `--ignore` against any part of the advisory URL, so a prefix
// silences every advisory it is a prefix of — `GHSA-` silences all of them.
test("an ignore that is not a full GHSA id fails, marker or not", () => {
  const text = lefthook({
    comments: ["# DROP AFTER GHSA- 2027-01-07", "# DROP AFTER GHSA-vfj7 2027-01-07"],
    runLines: ["bun audit --audit-level=high", "--ignore=GHSA-", "--ignore=GHSA-vfj7"],
  });
  const findings = checkAuditIgnores(text, NOW);

  expect(findings.map((f) => f.name)).toEqual(["GHSA-", "GHSA-vfj7"]);
  expect(findings[0]!.problem).toContain("not a full GHSA id");
});

test("a GHSA id with a character outside GitHub's alphabet fails", () => {
  // `a`, `b`, `0` and `1` never appear in a GHSA id.
  const id = "GHSA-ab01-8cjw-p6xm";
  const text = lefthook({
    comments: [`# DROP AFTER ${id} 2027-01-07`],
    runLines: ["bun audit --audit-level=high", `--ignore=${id}`],
  });

  expect(checkAuditIgnores(text, NOW).map((f) => f.name)).toEqual([id]);
});

test("the space-separated `--ignore <id>` form is read too", () => {
  const text = lefthook({
    comments: [MARKED[0]!],
    runLines: ["bun audit --audit-level=high", `--ignore ${BRACES}`, `--ignore ${CACHE}`],
  });

  expect(checkAuditIgnores(text, NOW).map((f) => f.name)).toEqual([CACHE]);
});

test("an `--ignore` with no value fails", () => {
  const text = lefthook({ runLines: ["bun audit --audit-level=high", "--ignore"] });
  const findings = checkAuditIgnores(text, NOW);

  expect(findings).toHaveLength(1);
  expect(findings[0]!.problem).toContain("no value");
});

// Inside a folded block a `#` line is folded into the command, and the shell
// treats everything after it as a comment — every later flag is dropped.
test("a `#` inside the folded command fails", () => {
  const text = lefthook({
    comments: MARKED,
    runLines: [
      "bun audit --audit-level=high",
      `--ignore=${BRACES}`,
      "# a note that drops the next flag",
      `--ignore=${CACHE}`,
    ],
  });
  const findings = checkAuditIgnores(text, NOW);

  expect(findings.some((f) => f.problem.includes("`#`"))).toBe(true);
});

// A renamed or deleted command must not leave the check passing on nothing.
test("a pre-push hook with no `bun audit` command fails", () => {
  const text = `pre-push:
  commands:
    typecheck:
      run: bash scripts/pre-push-typecheck.sh
`;
  const findings = checkAuditIgnores(text, NOW);

  expect(findings).toHaveLength(1);
  expect(findings[0]!.problem).toContain("no pre-push command runs `bun audit`");
});

test("a skipped audit command fails", () => {
  const text = lefthook({ comments: MARKED, extra: "      skip: true\n" });
  const findings = checkAuditIgnores(text, NOW);

  expect(findings).toHaveLength(1);
  expect(findings[0]!.problem).toContain("skip");
});

// lefthook also takes `skip` as a list of conditions, and `only`, `glob` and
// `files` can each stop a command running.
test("every key that can stop the audit running fails", () => {
  for (const extra of [
    "      skip:\n        - ref: main\n",
    "      only:\n        - ref: main\n",
    '      glob: "*.ts"\n',
    "      files: git diff --name-only\n",
  ]) {
    const findings = checkAuditIgnores(lefthook({ comments: MARKED, extra }), NOW);
    const key = extra.trim().split(":")[0]!;

    expect(findings).toHaveLength(1);
    expect(findings[0]!.problem).toContain(`\`${key}:`);
  }
});

test("`skip: false` keeps the audit running and passes", () => {
  expect(
    checkAuditIgnores(lefthook({ comments: MARKED, extra: "      skip: false\n" }), NOW),
  ).toEqual([]);
});

test("an ignore in a second command running `bun audit` is checked too", () => {
  const text = `${lefthook({ comments: MARKED })}    audit-again:
      run: bun audit --ignore=GHSA-2222-3333-4444
`;

  expect(checkAuditIgnores(text, NOW).map((f) => f.name)).toEqual(["GHSA-2222-3333-4444"]);
});

test("an ignore in a lefthook 2 `jobs:` entry is checked too", () => {
  const text = `pre-push:
  jobs:
    - name: audit
      run: bun audit --audit-level=high --ignore=GHSA-2222-3333-4444
`;

  expect(checkAuditIgnores(text, NOW).map((f) => f.name)).toEqual(["GHSA-2222-3333-4444"]);
});

test("auditCommands reads the folded command the way the shell receives it", () => {
  const [command] = auditCommands(lefthook({ comments: MARKED }));

  expect(command?.run.trim()).toBe(
    `bun audit --audit-level=high --ignore=${BRACES} --ignore=${CACHE}`,
  );
});

// The check only matters if the hook runs it. The real file's dates are not
// tested here: they expire on the calendar, and the CI step and the hook
// check the real file every run.
test("lefthook.yml's pre-push hook runs this check", async () => {
  const text = await Bun.file(new URL("../../lefthook.yml", import.meta.url)).text();
  const parsed = Bun.YAML.parse(text) as {
    "pre-push": { commands: Record<string, { run?: string }> };
  };
  const runs = Object.values(parsed["pre-push"].commands).map((command) => command.run ?? "");

  expect(runs.some((run) => run.includes("scripts/check-audit-ignores.ts"))).toBe(true);
});
