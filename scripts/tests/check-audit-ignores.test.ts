import { expect, test } from "bun:test";

import { auditCommand, checkAuditIgnores } from "../check-audit-ignores";

const NOW = new Date("2026-10-09T12:00:00Z");
const BRACES = "GHSA-vfj7-8cjw-p6xm";
const CACHE = "GHSA-ch52-4w7c-c8xp";

/** A lefthook file shaped like the real one: comments above `run:`, a folded
 * `run: >` holding the command and its flags. `top` goes before `pre-push:`,
 * `hook` after `parallel: true`, `extra` after the audit's `run:` block. */
function lefthook(
  options: {
    comments?: string[];
    runLines?: string[];
    extra?: string;
    hook?: string;
    top?: string;
  } = {},
) {
  const comments = (options.comments ?? []).map((line) => `      ${line}`).join("\n");
  const runLines = (
    options.runLines ?? ["bun audit --audit-level=high", `--ignore=${BRACES}`, `--ignore=${CACHE}`]
  )
    .map((line) => `        ${line}`)
    .join("\n");

  return `${options.top ?? ""}pre-push:
  parallel: true
${options.hook ?? ""}  commands:
    typecheck:
      run: bash scripts/pre-push-typecheck.sh
    audit:
${comments}
      run: >
${runLines}
${options.extra ?? ""}`;
}

const MARKED = [`# DROP AFTER ${BRACES} 2027-01-07`, `# DROP AFTER ${CACHE} 2027-01-07`];

/** The single command line, for the form tests. */
function withCommand(command: string) {
  return lefthook({ comments: MARKED, runLines: [command] });
}

function problems(text: string): string[] {
  return checkAuditIgnores(text, NOW).map((f) => f.problem);
}

// --- dates ------------------------------------------------------------------

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

  expect(checkAuditIgnores(text, NOW).map((f) => f.name)).toEqual([CACHE]);
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

// --- the command's one allowed form ------------------------------------------

// Anything the shell reads as more than words — a quote, an expansion, a pipe,
// a separator, a background `&`, a comment — can change what runs while the
// flags still look right, so only one exact form passes.
test.each([
  ["a quoted id", `bun audit --audit-level=high --ignore="${BRACES}"`],
  ["a `$` expansion", "bun audit --audit-level=high --ignore=$IGNORED"],
  ["a backtick", "bun audit --audit-level=high `true`"],
  ["a brace expansion", "bun audit --audit-level=high --ignore={GHSA-2222-3333-4444,GHSA-}"],
  ["a pipe", "bun audit --audit-level=high | cat"],
  ["a `;`", "bun audit --audit-level=high; true"],
  ["a background `&`", "bun audit --audit-level=high &"],
  ["`|| true`", "bun audit --audit-level=high || true"],
  ["an echo of the command", "echo bun audit --audit-level=high"],
  ["a weaker level", "bun audit --audit-level=critical"],
  ["no level", `bun audit --ignore=${BRACES}`],
  ["a `#` comment", `bun audit --audit-level=high # --ignore=${BRACES}`],
  ["a prefix id (bun matches any part of the URL)", "bun audit --audit-level=high --ignore=GHSA-"],
  ["an id outside GitHub's alphabet", "bun audit --audit-level=high --ignore=GHSA-ab01-8cjw-p6xm"],
  ["the space-separated `--ignore <id>` form", `bun audit --audit-level=high --ignore ${BRACES}`],
  ["an `--ignore` with no value", "bun audit --audit-level=high --ignore"],
])("the audit command fails with %s", (_name, command) => {
  const found = problems(withCommand(command));

  expect(found).toHaveLength(1);
  expect(found[0]).toContain("must be exactly");
});

// Inside a folded block a `#` line is folded into the command, and the shell
// treats everything after it as a comment — every later flag is dropped.
test("a `#` line inside the folded command fails", () => {
  const text = lefthook({
    comments: MARKED,
    runLines: [
      "bun audit --audit-level=high",
      `--ignore=${BRACES}`,
      "# a note that drops the next flag",
      `--ignore=${CACHE}`,
    ],
  });

  expect(problems(text)[0]).toContain("must be exactly");
});

test("auditCommand reads the folded command with its whitespace collapsed", () => {
  expect(auditCommand(lefthook({ comments: MARKED }))).toBe(
    `bun audit --audit-level=high --ignore=${BRACES} --ignore=${CACHE}`,
  );
});

// --- keys that can change or stop the command --------------------------------

// A renamed or deleted command must not leave the check passing on nothing.
test("a pre-push hook with no `audit` command fails", () => {
  const text = `pre-push:
  commands:
    typecheck:
      run: bash scripts/pre-push-typecheck.sh
`;

  expect(problems(text)).toEqual(["no pre-push `audit` command"]);
});

test.each([
  ["skip: true", "      skip: true\n"],
  ["skip as a list", "      skip:\n        - ref: main\n"],
  ["only", "      only:\n        - ref: main\n"],
  ["glob", '      glob: "*.ts"\n'],
  ["files", "      files: git diff --name-only\n"],
  ["env", "      env:\n        BUN_CONFIG_REGISTRY: https://example.com\n"],
  ["root", "      root: osn/api\n"],
])("the audit command may carry only `run`: %s fails", (_name, extra) => {
  const found = problems(lefthook({ comments: MARKED, extra }));

  expect(found).toHaveLength(1);
  expect(found[0]).toContain("commands.audit");
  expect(found[0]).toContain("only `run`");
});

test.each([
  ["skip", "  skip: true\n"],
  ["only", "  only:\n    - ref: main\n"],
  ["exclude_tags", "  exclude_tags:\n    - audit\n"],
  ["jobs", "  jobs:\n    - run: echo\n"],
  ["piped", "  piped: true\n"],
])("the pre-push hook may carry only `parallel` and `commands`: %s fails", (key, hook) => {
  const found = problems(lefthook({ comments: MARKED, hook }));

  expect(found).toHaveLength(1);
  expect(found[0]).toContain(`pre-push.${key}`);
});

test.each([
  ["extends", "extends:\n  - other.yml\n"],
  ["remotes", "remotes:\n  - git_url: https://example.com/hooks.git\n"],
  ["rc", "rc: ./.lefthookrc\n"],
  ["templates", "templates:\n  audit-level: high\n"],
])("a top-level `%s` key fails", (key, top) => {
  const found = problems(lefthook({ comments: MARKED, top }));

  expect(found).toHaveLength(1);
  expect(found[0]).toContain(`top-level \`${key}\``);
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
