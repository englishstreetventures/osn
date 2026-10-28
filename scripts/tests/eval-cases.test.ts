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

type Front = Record<string, unknown>;

function compiles(pattern: string): boolean {
  try {
    return new RegExp(pattern).source.length > 0;
  } catch {
    return false;
  }
}

function frontmatter(path: string): { data: Front; body: string } {
  const text = readFileSync(path, "utf8");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`${path}: no frontmatter`);
  return { data: (Bun.YAML.parse(match[1] ?? "") ?? {}) as Front, body: match[2] ?? "" };
}

const cases = readdirSync(EVALS, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== "results")
  .map((entry) => entry.name)
  .toSorted();
const skills = readdirSync(SKILLS);

test("every eval case is named after the skill it measures", () => {
  // `--case '<skill>-*'` is how a run picks one skill's cases; a case no
  // skill name prefixes is never picked.
  const orphans = cases.filter((name) => !skills.some((skill) => name.startsWith(`${skill}-`)));
  expect(cases.length).toBeGreaterThan(0);
  expect(orphans).toEqual([]);
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
  }
  expect(wrong).toEqual([]);
});

test("every grader has a known type, only its own keys, and a pattern that compiles", () => {
  const wrong: string[] = [];
  for (const name of cases) {
    const dir = join(EVALS, name, "graders");
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
      const patterns: unknown[] = [data.input_match, data.pattern];
      for (const side of [data.before, data.after]) {
        if (side && typeof side === "object") patterns.push((side as Front).input_match);
      }
      for (const pattern of patterns) {
        if (typeof pattern === "string" && !compiles(pattern)) {
          wrong.push(`${where}: pattern does not compile`);
        }
      }
    }
  }
  expect(wrong).toEqual([]);
});
