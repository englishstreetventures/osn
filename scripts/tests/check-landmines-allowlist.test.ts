import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { compareConfigs } from "../check-landmines-allowlist";

const SCRIPT = new URL("../check-landmines-allowlist.ts", import.meta.url).pathname;
const REPO_ROOT = new URL("../../", import.meta.url).pathname;

// Built from parts so this file never holds the comment the guard refuses.
const DISABLE = ["oxlint", "disable"].join("-");

const BASE = `{
  // A comment, as oxlintrc.json has hundreds.
  "rules": {
    "eqeqeq": "error",
    "landmines-testing/no-fixed-sleep": [
      "error",
      { "allow": { "a/tests/one.test.ts": 2, "a/tests/two.test.ts": 1 } }
    ],
    "landmines-testing/no-unsignaled-poll": "error",
    "landmines-testing/no-test-doubles": "off"
  },
  "overrides": [{ "files": ["**/tests/**"], "rules": { "eqeqeq": "off" } }],
  "jsPlugins": [{ "name": "landmines-testing", "specifier": "@interfere/landmines/testing" }]
}`;

const NO_RENAMES: ReadonlyMap<string, string> = new Map();

function problems(base: string, head: string): readonly string[] {
  return compareConfigs(base, head, NO_RENAMES).map((finding) => finding.problem);
}

test("passes a base with no landmines rule at all, whatever the head adds", () => {
  const base = `{ "rules": { "eqeqeq": "error" } }`;
  expect(problems(base, BASE)).toEqual([]);
});

test("refuses a rule the base sets and the head removes", () => {
  const head = BASE.replace(`"landmines-testing/no-unsignaled-poll": "error",`, "");
  expect(problems(BASE, head)).toEqual([
    "landmines-testing/no-unsignaled-poll is set on the base and missing here",
  ]);
});

test("refuses a rule the base sets and the head turns off", () => {
  const head = BASE.replace(
    `"landmines-testing/no-unsignaled-poll": "error"`,
    `"landmines-testing/no-unsignaled-poll": "off"`,
  );
  expect(problems(BASE, head)).toEqual([
    "landmines-testing/no-unsignaled-poll is error on the base and off here",
  ]);
});

test("refuses a rule the base sets and the head lowers to warn", () => {
  const head = BASE.replace(
    `[
      "error",
      { "allow"`,
    `[
      "warn",
      { "allow"`,
  );
  expect(problems(BASE, head)).toEqual([
    "landmines-testing/no-fixed-sleep is error on the base and warn here",
  ]);
});

test("refuses a renamed plugin alias, which renames every key", () => {
  const head = BASE.replaceAll("landmines-testing", "lm-testing");
  expect(problems(BASE, head)).toEqual([
    "landmines-testing/no-fixed-sleep is set on the base and missing here",
    "landmines-testing/no-unsignaled-poll is set on the base and missing here",
    "landmines-testing/no-test-doubles is set on the base and missing here",
  ]);
});

test("refuses a raised count", () => {
  const head = BASE.replace(`"a/tests/one.test.ts": 2`, `"a/tests/one.test.ts": 3`);
  expect(problems(BASE, head)).toEqual([
    "landmines-testing/no-fixed-sleep: a/tests/one.test.ts is allowed 3, up from 2 on the base",
  ]);
});

test("refuses a key the base does not have, on a rule with an allow map", () => {
  const head = BASE.replace(
    `"a/tests/two.test.ts": 1`,
    `"a/tests/two.test.ts": 1, "a/tests/new.test.ts": 1`,
  );
  expect(problems(BASE, head)).toEqual([
    "landmines-testing/no-fixed-sleep: a/tests/new.test.ts is not on the base's allow map",
  ]);
});

test("refuses an allow map added to a rule the base sets with none", () => {
  const head = BASE.replace(
    `"landmines-testing/no-unsignaled-poll": "error"`,
    `"landmines-testing/no-unsignaled-poll": ["error", { "allow": { "a/tests/one.test.ts": 1 } }]`,
  );
  expect(problems(BASE, head)).toEqual([
    "landmines-testing/no-unsignaled-poll: a/tests/one.test.ts is not on the base's allow map",
  ]);
});

test("carries a renamed file's count to its new key", () => {
  const head = BASE.replace(`"a/tests/one.test.ts": 2`, `"a/tests/moved.test.ts": 2`);
  const renamed = new Map([["a/tests/moved.test.ts", "a/tests/one.test.ts"]]);
  expect(compareConfigs(BASE, head, renamed)).toEqual([]);
  const raised = BASE.replace(`"a/tests/one.test.ts": 2`, `"a/tests/moved.test.ts": 3`);
  expect(compareConfigs(BASE, raised, renamed).map((finding) => finding.problem)).toEqual([
    "landmines-testing/no-fixed-sleep: a/tests/moved.test.ts is allowed 3, up from 2 on the base",
  ]);
});

test("refuses a landmines key added in an override", () => {
  const head = BASE.replace(
    `"rules": { "eqeqeq": "off" }`,
    `"rules": { "eqeqeq": "off", "landmines-testing/no-fixed-sleep": "off" }`,
  );
  expect(problems(BASE, head)).toEqual([
    'an override for ["**/tests/**"] sets landmines-testing/no-fixed-sleep to "off", which the base does not',
  ]);
});

test("refuses a landmines key in an override that the base has and the head drops", () => {
  const base = BASE.replace(
    `"rules": { "eqeqeq": "off" }`,
    `"rules": { "eqeqeq": "off", "landmines-testing/no-test-doubles": "error" }`,
  );
  expect(problems(base, BASE)).toEqual([
    'the base\'s override for ["**/tests/**"] sets landmines-testing/no-test-doubles to "error", and no override here does',
  ]);
});

test("reads comments anywhere in the file", () => {
  const head = BASE.replace(`"eqeqeq": "error",`, `"eqeqeq": "error", /* inline */\n    // a line`);
  expect(problems(BASE, head)).toEqual([]);
});

test("reads trailing commas", () => {
  const head = BASE.replace(`"a/tests/two.test.ts": 1 }`, `"a/tests/two.test.ts": 1, }`).replace(
    `"landmines-testing/no-test-doubles": "off"`,
    `"landmines-testing/no-test-doubles": "off",`,
  );
  expect(problems(BASE, head)).toEqual([]);
});

test("passes a lowered count and a removed key", () => {
  const head = BASE.replace(
    `"a/tests/one.test.ts": 2, "a/tests/two.test.ts": 1`,
    `"a/tests/one.test.ts": 1`,
  );
  expect(problems(BASE, head)).toEqual([]);
});

test("throws on a file it cannot parse, rather than reading it as empty", () => {
  expect(() => compareConfigs("{ not json", BASE, NO_RENAMES)).toThrow();
  expect(() => compareConfigs(BASE, "[]", NO_RENAMES)).toThrow();
});

// The CLI: base and head as two commits in a throwaway repository, which is
// how CI sees a pull request (its merge commit against HEAD^1).

type Run = { readonly exitCode: number; readonly output: string };

function repository(files: Readonly<Record<string, string>>) {
  const root = mkdtempSync(join(tmpdir(), "landmines-allowlist-"));
  const git = (...args: string[]): string => {
    const result = Bun.spawnSync(
      [
        "git",
        "-c",
        "user.email=o@t",
        "-c",
        "user.name=o",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    if (!result.success) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };
  const put = (path: string, contents: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  for (const [path, contents] of Object.entries(files)) put(path, contents);
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  const base = git("rev-parse", "HEAD");
  const commit = (): void => {
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", "pull request");
  };
  const run = (ref: string = base): Run => {
    const result = Bun.spawnSync(["bun", "run", SCRIPT, "--base", ref], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    return {
      exitCode: result.exitCode,
      output: result.stdout.toString() + result.stderr.toString(),
    };
  };
  const remove = (): void => rmSync(root, { recursive: true, force: true });
  return { git, put, commit, run, remove };
}

const TRACKED = {
  "oxlintrc.json": BASE,
  "a/tests/one.test.ts": "export {};\n",
  "a/tests/two.test.ts": "export {};\n",
};

test("the CLI carries a count across a file git sees as renamed", () => {
  const repo = repository(TRACKED);
  try {
    repo.git("mv", "a/tests/one.test.ts", "a/tests/moved.test.ts");
    repo.put(
      "oxlintrc.json",
      BASE.replace(`"a/tests/one.test.ts": 2`, `"a/tests/moved.test.ts": 2`),
    );
    repo.commit();
    const { exitCode, output } = repo.run();
    expect(output).toContain("passes");
    expect(exitCode).toBe(0);
  } finally {
    repo.remove();
  }
});

test("the CLI refuses an allow key that matches no tracked file", () => {
  const repo = repository(TRACKED);
  try {
    repo.git("rm", "-q", "a/tests/two.test.ts");
    repo.commit();
    const { exitCode, output } = repo.run();
    expect(output).toContain(
      "landmines-testing/no-fixed-sleep: a/tests/two.test.ts matches no tracked file",
    );
    expect(exitCode).toBe(1);
  } finally {
    repo.remove();
  }
});

test("the CLI refuses an added comment that disables a landmines rule", () => {
  const repo = repository(TRACKED);
  try {
    repo.put("a/tests/one.test.ts", `// ${DISABLE} landmines-testing/no-fixed-sleep\nexport {};\n`);
    repo.commit();
    const { exitCode, output } = repo.run();
    expect(output).toContain(
      `a/tests/one.test.ts adds "// ${DISABLE} landmines-testing/no-fixed-sleep"`,
    );
    expect(exitCode).toBe(1);
  } finally {
    repo.remove();
  }
});

test("the CLI exits 2 when the base has no oxlintrc.json, or one it cannot parse", () => {
  const repo = repository({ "a/tests/one.test.ts": "export {};\n" });
  try {
    repo.put("oxlintrc.json", BASE);
    repo.commit();
    const missing = repo.run();
    expect(missing.output).toContain("cannot read oxlintrc.json at");
    expect(missing.exitCode).toBe(2);

    const unparsable = repository({ "oxlintrc.json": "{ not json" });
    try {
      unparsable.put("oxlintrc.json", BASE);
      unparsable.commit();
      const broken = unparsable.run();
      expect(broken.output).toContain("cannot parse oxlintrc.json at");
      expect(broken.exitCode).toBe(2);
    } finally {
      unparsable.remove();
    }

    const noRef = repo.run("no-such-ref");
    expect(noRef.exitCode).toBe(2);
  } finally {
    repo.remove();
  }
});

test("the real CLI passes this repository's own oxlintrc.json against its last commit", () => {
  const result = Bun.spawnSync(["bun", "run", SCRIPT, "--base", "HEAD"], {
    cwd: REPO_ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = result.stdout.toString() + result.stderr.toString();
  expect(output).toContain("passes");
  expect(result.exitCode).toBe(0);
});
