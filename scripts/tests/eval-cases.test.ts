import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The cases under `.claude/evals/` are data that `claude plugin eval` loads.
// `claude plugin validate` does not read them, and a run bills the owner's
// plan, so a case that cannot load would otherwise surface only after someone
// paid for it. These checks hold the shape the format documents
// (https://code.claude.com/docs/en/plugin-evals.md, "Eval suite reference").

const ROOT = join(import.meta.dir, "..", "..");
const EVALS = join(ROOT, ".claude", "evals");
const SKILLS = join(ROOT, ".claude", "skills");

const PROMPT_KEYS = new Set([
  "schema_version",
  "name",
  "description",
  "tags",
  "plugins",
  "runs",
  "expected_outcome",
  "model",
  "max_turns",
  "timeout_seconds",
  "allowed_tools",
  "append_system_prompt",
  "env",
]);
const GRADER_KEYS: Record<string, readonly string[]> = {
  regex: ["pattern", "flags", "match", "target"],
  tool_used: ["tool", "input_match", "min", "max"],
  tool_order: ["before", "after"],
  file_exists: ["path", "exists"],
  llm: ["criteria", "focus"],
  baseline: ["baseline_file", "criteria"],
};
const COMMON_GRADER_KEYS = new Set(["type", "weight", "arm"]);
// Options the docs give no default for: a grader without one cannot load or
// grades nothing. `llm` needs a body or `criteria`, checked apart.
const REQUIRED_GRADER_KEYS: Record<string, readonly string[]> = {
  regex: ["pattern"],
  tool_used: ["tool"],
  tool_order: ["before", "after"],
  file_exists: ["path"],
  llm: [],
  baseline: ["baseline_file"],
};
const FOCUS_NAMES = new Set(["last_message", "trace", "files", "mock_calls"]);
const CASE_KEYS = new Set([
  "schema_version",
  "name",
  "description",
  "tags",
  "plugins",
  "runs",
  "expected_outcome",
  "execution",
  "context",
  "graders",
]);
const CONTEXT_KEYS = new Set(["scaffold_script", "history_file", "add_dirs"]);
// Suite-level directories that are not cases.
const SUITE_DIRS = new Set(["results", "mocks"]);
// Files the agent is meant to create, so its prompt need not name them.
const CREATED_BY_AGENT = new Set([
  "prep-pr-missing-test-written/cire/api/tests/lib/guest-note.test.ts",
]);
const GRANTS = ["Bash", "Write", "Edit"];
const PINNED_URL = "https://github.com/englishstreetventures/osn.git";
const PINNED_FETCH = new RegExp(
  `^git fetch -q --depth 1 ${PINNED_URL.replaceAll(".", "\\.")} [0-9a-f]{40}$`,
);
// `set -euo pipefail`, then only blank lines and comments, then the guard.
const EMPTY_GUARD_FIRST =
  /^set -euo pipefail\n(?:[ \t]*(?:#[^\n]*)?\n)*if \[ -n "\$\(ls -A\)" \]; then\n(?: +[^\n]*\n)*? +exit 1\nfi\n/m;
// Right after the local identity, so no fixture commit is signed.
const SIGNING_OFF =
  /^git config user\.name [^\n]*\ngit config commit\.gpgsign false\ngit config tag\.gpgsign false\n/m;

type Front = Record<string, unknown>;

function compiles(pattern: string, flags: unknown): boolean {
  try {
    return RegExp(pattern, typeof flags === "string" ? flags : "") instanceof RegExp;
  } catch {
    return false;
  }
}

function isObject(value: unknown): value is Front {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validFocus(value: unknown): boolean {
  if (typeof value === "string") return FOCUS_NAMES.has(value);
  if (!isObject(value)) return false;
  return (
    value.source === "file" &&
    typeof value.path === "string" &&
    value.path.trim() !== "" &&
    Object.keys(value).every((key) => key === "source" || key === "path")
  );
}

function validRuns(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 50;
}

function isCaseDir(name: string): boolean {
  return existsSync(join(EVALS, name, "prompt.md")) || existsSync(join(EVALS, name, "case.yaml"));
}

function frontmatter(path: string): { data: Front; body: string } {
  const text = readFileSync(path, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${path}: no frontmatter`);
  return { data: (Bun.YAML.parse(match[1] ?? "") ?? {}) as Front, body: match[2] ?? "" };
}

const evalDirs = readdirSync(EVALS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);
// A directory is a case when it holds `prompt.md` or `case.yaml`.
const cases = evalDirs.filter(isCaseDir).toSorted();
const skills = readdirSync(SKILLS);

test("every directory under evals is a case or a suite-level directory", () => {
  const stray = evalDirs.filter((name) => !isCaseDir(name) && !SUITE_DIRS.has(name));
  expect(stray).toEqual([]);
});

test("every eval case is named after the skill it measures", () => {
  // `--case '<skill>-*'` is how a run picks one skill's cases; a case no
  // skill name prefixes is never picked.
  const orphans = cases.filter((name) => !skills.some((skill) => name.startsWith(`${skill}-`)));
  expect(cases.length).toBeGreaterThan(0);
  expect(orphans).toEqual([]);
});

test("a skill name that prefixes another skill's name is narrowed in the README", () => {
  // `--case 'retro-*'` also selects every `retro-v2-*` case. Each such pair
  // must sit in one README paragraph with both globs.
  const pairs = skills.flatMap((short) =>
    skills.filter((long) => long.startsWith(`${short}-`)).map((long) => [short, long] as const),
  );
  const paragraphs = readFileSync(join(EVALS, "README.md"), "utf8").split(/\n\s*\n/);
  const unnamed = pairs
    .filter(
      ([short, long]) =>
        !paragraphs.some((p) => p.includes(`${short}-*`) && p.includes(`${long}-*`)),
    )
    .map(([short, long]) => `${short} / ${long}`);
  expect(unnamed).toEqual([]);
});

test("the README case table matches each case's allowed_tools", () => {
  const rows = new Map<string, string[]>();
  const row = /^\| `([^`]+)` \| `[^`]+` \| ([^|]*) \| [^|]*\|$/;
  for (const line of readFileSync(join(EVALS, "README.md"), "utf8").split("\n")) {
    const m = row.exec(line);
    if (m) {
      const cell = (m[2] ?? "").replaceAll("`", "");
      rows.set(
        m[1] ?? "",
        cell.split(/\s+/).filter((t) => t !== ""),
      );
    }
  }
  const wrong: string[] = [];
  for (const name of cases) {
    const listed = rows.get(name);
    if (!listed) {
      wrong.push(`${name}: no README row`);
      continue;
    }
    const { data } = frontmatter(join(EVALS, name, "prompt.md"));
    const tools = Array.isArray(data.allowed_tools) ? (data.allowed_tools as string[]) : [];
    const want = GRANTS.filter((g) => tools.includes(g)).join(" ");
    if (listed.join(" ") !== want) {
      wrong.push(`${name}: README grants "${listed.join(" ")}", allowed_tools needs "${want}"`);
    }
  }
  for (const name of rows.keys()) {
    if (!cases.includes(name)) wrong.push(`${name}: README row has no case`);
  }
  expect(wrong).toEqual([]);
});

test("every scaffold parses, guards an empty workspace and strips the plugin's instructions", async () => {
  const wrong: string[] = [];
  // The parse checks share no state, so every `bash -n` runs at once.
  const scaffolds = cases.filter((name) => existsSync(join(EVALS, name, "setup.sh")));
  const parses = await Promise.all(
    scaffolds.map(async (name) => {
      const proc = Bun.spawn(["bash", "-n", join(EVALS, name, "setup.sh")], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
      return { exitCode, stderr };
    }),
  );
  for (const [index, name] of scaffolds.entries()) {
    const path = join(EVALS, name, "setup.sh");
    const check = parses[index];
    if (check && check.exitCode !== 0) wrong.push(`${name}: bash -n: ${check.stderr.trim()}`);
    const text = readFileSync(path, "utf8");
    // Scaffolds run as the owner outside the sandbox, so the guard comes
    // before every other command, and the only remote fetch is the pinned one.
    if (!EMPTY_GUARD_FIRST.test(text)) {
      wrong.push(
        `${name}: the empty-workspace guard is not the first command after set -euo pipefail`,
      );
    }
    const fetches = text
      .split("\n")
      .filter((line) => /\bgit\s+(?:-\S+\s+)*fetch\b/.test(line) && !/^\s*#/.test(line));
    if (!PINNED_FETCH.test(fetches[0] ?? "")) {
      wrong.push(`${name}: the first git fetch is not ${PINNED_URL} at a 40-hex commit`);
    }
    for (const line of fetches.slice(1)) {
      if (!line.startsWith("git fetch -q origin "))
        wrong.push(`${name}: git fetch from something other than origin after the pinned one`);
    }
    if (/\b(?:curl|wget)\b/.test(text.replace(/^\s*#.*$/gm, ""))) {
      wrong.push(`${name}: scaffold calls curl or wget`);
    }
    if (!SIGNING_OFF.test(text)) {
      wrong.push(`${name}: commit.gpgsign and tag.gpgsign are not turned off after the identity`);
    }
    // All of .claude, or all but metrics/ where the case reads it.
    const wholeClaude = /^rm -rf \.claude \.agents$/m.test(text);
    const keepsMetrics =
      /^find \.claude -mindepth 1 -maxdepth 1 ! -name metrics -exec rm -rf \{\} \+$/m.test(text) &&
      /^rm -rf \.agents$/m.test(text);
    if (!wholeClaude && !keepsMetrics) wrong.push(`${name}: does not remove .claude and .agents`);
  }
  expect(wrong).toEqual([]);
});

test("every eval case has a prompt, a case file, a scaffold and a grader", () => {
  const missing: string[] = [];
  for (const name of cases) {
    for (const part of ["prompt.md", "case.yaml", "setup.sh"]) {
      if (!existsSync(join(EVALS, name, part))) missing.push(`${name}/${part}`);
    }
    const graders = join(EVALS, name, "graders");
    if (!existsSync(graders) || !readdirSync(graders).some((f) => f.endsWith(".md"))) {
      missing.push(`${name}/graders/*.md`);
    }
  }
  expect(missing).toEqual([]);
});

test("case.yaml names its own case and its scaffold", () => {
  const wrong: string[] = [];
  for (const name of cases) {
    const data = Bun.YAML.parse(readFileSync(join(EVALS, name, "case.yaml"), "utf8")) as Front;
    const context = (data.context ?? {}) as Front;
    if (data.schema_version !== "1.1") wrong.push(`${name}: schema_version`);
    if (data.name !== name) wrong.push(`${name}: name`);
    if (context.scaffold_script !== "setup.sh") wrong.push(`${name}: context.scaffold_script`);
    for (const key of Object.keys(data)) {
      if (!CASE_KEYS.has(key)) wrong.push(`${name}: unknown case.yaml key ${key}`);
    }
    for (const key of Object.keys(context)) {
      if (!CONTEXT_KEYS.has(key)) wrong.push(`${name}: unknown context key ${key}`);
    }
    if (data.runs !== undefined && !validRuns(data.runs)) wrong.push(`${name}: case.yaml runs`);
  }
  expect(wrong).toEqual([]);
});

test("prompt.md uses only documented keys, within their limits", () => {
  const wrong: string[] = [];
  for (const name of cases) {
    const { data, body } = frontmatter(join(EVALS, name, "prompt.md"));
    for (const key of Object.keys(data)) {
      if (!PROMPT_KEYS.has(key)) wrong.push(`${name}: unknown key ${key}`);
    }
    const turns = data.max_turns;
    const timeout = data.timeout_seconds;
    if (typeof turns !== "number" || turns < 1 || turns > 200) wrong.push(`${name}: max_turns`);
    if (typeof timeout !== "number" || timeout < 1 || timeout > 3600)
      wrong.push(`${name}: timeout_seconds`);
    if (!Array.isArray(data.allowed_tools)) wrong.push(`${name}: allowed_tools`);
    if (body.trim() === "") wrong.push(`${name}: empty prompt`);
    if (data.name !== undefined && data.name !== name) wrong.push(`${name}: prompt.md name`);
    if (data.runs !== undefined && !validRuns(data.runs)) wrong.push(`${name}: prompt.md runs`);
    if (data.env !== undefined) {
      if (!isObject(data.env)) wrong.push(`${name}: env`);
      else {
        for (const key of Object.keys(data.env)) {
          if (!/^EVAL_[A-Z0-9_]*$/.test(key)) wrong.push(`${name}: env key ${key}`);
        }
      }
    }
  }
  expect(wrong).toEqual([]);
});

test("every grader has a known type, only its own keys, and a pattern that compiles", () => {
  const wrong: string[] = [];
  for (const name of cases) {
    const dir = join(EVALS, name, "graders");
    const prompt = frontmatter(join(EVALS, name, "prompt.md")).body;
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
      const where = `${name}/graders/${file}`;
      const { data, body } = frontmatter(join(dir, file));
      const type = String(data.type);
      const own = GRADER_KEYS[type];
      if (!own) {
        wrong.push(`${where}: type ${type}`);
        continue;
      }
      for (const key of Object.keys(data)) {
        if (!COMMON_GRADER_KEYS.has(key) && !own.includes(key)) wrong.push(`${where}: key ${key}`);
      }
      if (data.weight !== undefined && !(typeof data.weight === "number" && data.weight > 0)) {
        wrong.push(`${where}: weight`);
      }
      if (type === "llm" && body.trim() === "" && !data.criteria) wrong.push(`${where}: no rubric`);
      for (const key of REQUIRED_GRADER_KEYS[type] ?? []) {
        if (data[key] === undefined || data[key] === null || data[key] === "") {
          wrong.push(`${where}: missing ${key}`);
        }
      }
      for (const key of ["focus", "target"]) {
        if (data[key] !== undefined && !validFocus(data[key])) wrong.push(`${where}: ${key} value`);
      }
      if (
        data.match !== undefined &&
        !/^(contains|not_contains|count:\d+)$/.test(String(data.match))
      ) {
        wrong.push(`${where}: match value`);
      }
      if (data.arm !== undefined && data.arm !== "with-only" && data.arm !== "both") {
        wrong.push(`${where}: arm value`);
      }
      for (const key of ["min", "max"]) {
        const v = data[key];
        if (v !== undefined && !(Number.isInteger(v) && (v as number) >= 0)) {
          wrong.push(`${where}: ${key} value`);
        }
      }
      if (typeof data.min === "number" && typeof data.max === "number" && data.min > data.max) {
        wrong.push(`${where}: min exceeds max`);
      }
      if (type === "llm" && isObject(data.focus) && data.focus.source === "file") {
        if (!/missing or empty/i.test(body))
          wrong.push(`${where}: rubric passes on a missing file`);
        const path = data.focus.path;
        if (typeof path === "string" && !CREATED_BY_AGENT.has(`${name}/${path}`)) {
          if (!prompt.includes(path)) wrong.push(`${where}: prompt.md never names ${path}`);
        }
      }
      const patterns: unknown[] = [data.input_match, data.pattern];
      for (const side of [data.before, data.after]) {
        if (side && typeof side === "object") patterns.push((side as Front).input_match);
      }
      for (const pattern of patterns) {
        if (typeof pattern === "string" && !compiles(pattern, data.flags)) {
          wrong.push(`${where}: pattern does not compile`);
        }
      }
    }
  }
  expect(wrong).toEqual([]);
});
