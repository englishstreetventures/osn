#!/usr/bin/env bun
/**
 * Guard: every Alchemy CLI run sends no telemetry, no committed command prints
 * or deletes Alchemy state or the state store, and no stack chooses its own
 * state store.
 *
 *  - Commands are read after joining backslash line continuations and split
 *    into segments on `&&`, `||`, `;`, `|` and a background `&` (not the `&`
 *    of a redirection such as `2>&1`); each segment is checked alone, as the
 *    words the shell hands the command: quotes (`'…'`, `"…"`, `$'…'`) and
 *    backslashes removed, a quoted space kept inside its word. A segment
 *    whose arguments after `alchemy` use an expansion (`$`, a backtick, or
 *    brace expansion such as `{a,b}`) fails, since the guard cannot know what
 *    it runs.
 *  - package.json scripts: every segment that runs Alchemy starts with
 *    `DO_NOT_TRACK=1 ` and sets `CI=true` among its leading assignments, so a
 *    run on someone's own machine takes credentials from the environment alone
 *    and never deploys or upgrades a state store without `--yes`; when the
 *    leading assignments set either more than once, the last one decides. The
 *    guard reads only those assignments: an `--env-file` that sets `CI` is
 *    outside what it sees.
 *  - workflows: a step that runs Alchemy has `DO_NOT_TRACK: "1"` in its own
 *    `env` or, when the step sets none, in the job or workflow `env`; a
 *    different value there turns telemetry on. A segment's own leading
 *    `DO_NOT_TRACK=` overrides the env, and must then be `1`; with no env
 *    value, each Alchemy segment carries the inline prefix. Composite
 *    actions: on the step or the segment.
 *  - all three: `alchemy state ls`/`list` and `alchemy state bootstrap`
 *    without `--force` are the only `state` commands allowed (bare `state`
 *    opens an explorer that reads records; `state logs` reads the store's
 *    logs; `state bootstrap --force` redeploys a store that is serving), and
 *    never `nuke`, `drift … --repair`, `teardown`, `provider cloudflare token`
 *    (it prints the token it creates), `logs` (it prints a stage's Worker
 *    logs), and `destroy` unless it names exactly one stage with a literal
 *    `--stage` that is neither `dev` nor `production`: without `--stage` the
 *    stage comes from `ALCHEMY_STAGE` in the environment, `--env-file` or
 *    `.env`, and a variable or expression may hold either.
 *  - all three, in every command whether or not it runs Alchemy itself (a
 *    package script passes its arguments on): `--log-level` only at `info`,
 *    `warn`, `warning`, `error`, `fatal` or `none`, since a lower level
 *    prints Debug records, whole failure causes among them, into a public run
 *    log; `--log-format` only as `pretty`, since under `json` Alchemy prints
 *    no plan for the plan summary or the production plan guard to read; and
 *    `ALCHEMY_LOG_LEVEL` and `ALCHEMY_LOG_FORMAT` never named, in a command
 *    or as a key of any workflow, job or step `env`: a variable reaches every
 *    Alchemy run after it, which the guard cannot follow.
 *  - stack files (`*\/infra/**\/*.ts`, `*alchemy.run.ts`, tests excluded): no
 *    state constructor name (`localState`, `inMemoryState`, `postgresState`,
 *    `makeLocalState`, `makePostgresState`, `makeHttpStateStore`,
 *    `makeBucketState`, `InMemoryService`), called or not; no module that
 *    holds a state store, its lifecycle or a command that runs it, in any
 *    import form:
 *    `alchemy/State`, `alchemy/Contributions`, `alchemy/Alchemist`,
 *    `alchemy/Cli/commands`, `@alchemy.run/sql/PostgresState`, and a
 *    provider's `StateStore`, `Alchemist`, `Contributions` or `Cli`, each with
 *    any path under it; no `export *` from `@alchemy.run/cloudflare` or
 *    `@alchemy.run/aws` or a path under either; and in a file that names one
 *    of those as a module, no `state` or `bootstrap` taken from it in any
 *    form: an import, a member (`.state`, called or not), a computed member
 *    (`["state"]`) or a destructuring key, quoted or not.
 *    `shared/infra/src/stack.ts` alone calls `Cloudflare.state()`.
 *
 * Tests: scripts/tests/check-alchemy-usage.test.ts (the checks) and
 * scripts/tests/check-alchemy-usage.cli.test.ts (this file run as CI runs it).
 * CI runs this file against the committed tree in the `script-tests` job of
 * .github/workflows/ci.yml.
 * Imports only Bun and Node built-ins.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type Finding = { readonly where: string; readonly problem: string };

export const STATE_STORE_FILE = "shared/infra/src/stack.ts";

/**
 * `alchemy` run as a command: the word on its own or at the end of a path,
 * with or without `@<version>`, then whitespace and anything (a subcommand, a
 * flag or an entry file). `alchemy-state` and `alchemy.run.ts` do not match.
 */
const ALCHEMY_COMMAND = /(?:^|[\s;&|(`'"/])alchemy(?:@\S+)?\s+\S/m;

/** The start of an Alchemy invocation inside a command line. */
const INVOCATION = String.raw`\balchemy(?:@\S+)?\s+`;

/** Alchemy's console log settings as environment variables. */
const LOG_SETTING_VARIABLE = /\bALCHEMY_LOG_(?:LEVEL|FORMAT)\b/;

/** A `--log-level` or `--log-format` flag in a command's words, and its value. */
const LOG_FLAG = /(?:^|\s)--log-(level|format)(?:=|\s+)(\S*)/gi;

/** The values each flag may take: Info and above, and the text format. */
const ALLOWED_LOG_VALUES = {
  level: new Set(["info", "warn", "warning", "error", "fatal", "none"]),
  format: new Set(["pretty"]),
} as const;

export const LOG_LEVEL_WHY =
  "`--log-level` below info, or at a value the guard cannot read, prints Debug records, which carry whole failure causes, into a public run log";

export const LOG_FORMAT_WHY =
  "`--log-format` other than pretty: under json Alchemy prints no plan, which the plan summary and the production plan guard read";

export const LOG_VARIABLE_WHY =
  "ALCHEMY_LOG_LEVEL and ALCHEMY_LOG_FORMAT reach every Alchemy run after them, which the guard cannot follow; pass `--log-level` or `--log-format` instead";

const FORBIDDEN: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: new RegExp(
      String.raw`${INVOCATION}(?:[^\n]*?\s)?state\b(?!\s+(?:ls|list|bootstrap)\b)`,
    ),
    why: "only `alchemy state ls` and `alchemy state bootstrap` may run; every other state command prints, reads or deletes Alchemy state",
  },
  {
    pattern: new RegExp(
      String.raw`${INVOCATION}(?:[^\n]*?\s)?state\s+bootstrap\b[^\n]*?\s--force(?=[\s=]|$)`,
    ),
    why: "`state bootstrap --force` redeploys a state store that is serving",
  },
  {
    pattern: new RegExp(String.raw`${INVOCATION}[^\n]*\bnuke\b`),
    why: "deletes every resource in the account",
  },
  {
    pattern: new RegExp(String.raw`${INVOCATION}[^\n]*\bdrift\b[^\n]*--repair\b`),
    why: "`drift --repair` is never run",
  },
  {
    pattern: new RegExp(String.raw`${INVOCATION}[^\n]*\bteardown\b`),
    why: "deletes the state store",
  },
  {
    pattern: new RegExp(String.raw`${INVOCATION}[^\n]*\bprovider\s+cloudflare\s+token\b`),
    why: "creates a Cloudflare API token and prints it to stdout, which lands in a public run log",
  },
  {
    pattern: new RegExp(String.raw`${INVOCATION}(?:[^\n]*?\s)?(?<!\bstate\s+)logs(?=\s|$)`),
    why: "prints a stage's Worker logs, which carry request paths, into a public run log",
  },
];

const DESTROY = new RegExp(String.raw`${INVOCATION}(?:[^\n]*?\s)?destroy(?=\s|$)`);

/** Every `--stage` value in a segment, as written. */
const STAGE_FLAG = /(?:^|\s)--stage(?:=|\s+)(\S+)/g;

/** A stage name as `parseStage()` in shared/infra/src/stage.ts shapes it, written out literally. */
const LITERAL_STAGE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

const LONG_LIVED_STAGES: ReadonlySet<string> = new Set(["dev", "production"]);

/**
 * `destroy` runs only on one stage the guard can read and prove short-lived.
 * Without `--stage`, Alchemy takes the stage from ALCHEMY_STAGE in the
 * environment, an --env-file or .env; a variable or an expression may hold
 * dev or production. Every form the guard cannot read fails.
 */
function destroyProblem(segment: string): string | undefined {
  if (!DESTROY.test(segment)) return undefined;
  const stages = [...segment.matchAll(STAGE_FLAG)].map((match) => match[1] ?? "");
  const [stage] = stages;
  if (stages.length !== 1 || stage === undefined || !LITERAL_STAGE.test(stage)) {
    return "`destroy` names exactly one stage with a literal --stage; any other form may reach dev or production";
  }
  return LONG_LIVED_STAGES.has(stage)
    ? "`destroy` on dev or production deletes every resource and state row of a long-lived stage"
    : undefined;
}

/**
 * `@alchemy.run/cloudflare` or `@alchemy.run/aws`, or a path under either: each
 * exports `state()`, which builds a state store layer, and `bootstrap()`, which
 * deploys a store.
 */
const PROVIDER_MODULE = String.raw`@alchemy\.run\/(?:cloudflare|aws)(?:\/[^"'\n]*)?`;

/** The provider exports that choose or deploy a state store. */
const STORE_EXPORT = String.raw`(?:state|bootstrap)`;

/** A state constructor named anywhere, called or not, or a store export imported from a provider module. */
const STATE_CONSTRUCTOR = new RegExp(
  String.raw`\b(?:localState|inMemoryState|postgresState|makeLocalState|makePostgresState|makeHttpStateStore|makeBucketState|InMemoryService)\b|\bCloudflare\.state\b|\bimport\s*\{[^}]*\b${STORE_EXPORT}\b[^}]*\}\s*from\s*["']${PROVIDER_MODULE}["']`,
);

/**
 * A module that holds a state store, its lifecycle (bootstrap, teardown, logs)
 * or a command that runs one, or a path under it, quoted as a module
 * specifier: core `alchemy/State`, `alchemy/Contributions`,
 * `alchemy/Alchemist` and `alchemy/Cli/commands`;
 * `@alchemy.run/sql/PostgresState`; and a provider's `StateStore`,
 * `Alchemist`, `Contributions` and `Cli`.
 */
const STATE_MODULE =
  /["'](?:alchemy\/(?:State|Contributions|Alchemist|Cli\/commands)|@alchemy\.run\/sql\/PostgresState|@alchemy\.run\/(?:cloudflare|aws)\/(?:StateStore|Alchemist|Contributions|Cli))(?:\/[^"'\n]*)?["']/;

/** A provider module quoted as a module specifier. */
const STATE_PROVIDER_MODULE = new RegExp(String.raw`["']${PROVIDER_MODULE}["']`);

/** Every export of a provider module passed on to another file, which the guard reads alone. */
const PROVIDER_STAR_EXPORT = new RegExp(
  String.raw`\bexport\s*\*\s*(?:as\s+\w+\s*)?from\s*["']${PROVIDER_MODULE}["']`,
);

/**
 * A store export taken from a module in the file: a member (`.state`, called
 * or not, `?.bootstrap`), a computed member (`["state"]`), or a key or
 * shorthand in a destructuring pattern (`{ state }`, `{ state: s }`,
 * `{ "state": s }`, `{ state = x }`), nested or in an arrow's parameters.
 */
const STORE_BINDING = new RegExp(
  String.raw`\.${STORE_EXPORT}\b|\[\s*(["'\x60])${STORE_EXPORT}\1\s*\]|[{,]\s*(["'\x60]?)${STORE_EXPORT}\2\s*(?:[:,}]|=(?!=))`,
);

/** Backslash-newline continuations become one space, as the shell reads them. */
const joinContinuations = (command: string): string => command.replace(/\\\r?\n\s*/g, " ");

/** `&&`, `||`, `;`, `|`, or a lone `&` that runs a command in the background; never the `&` of `2>&1`, `>&2` or `&>`. */
const COMMAND_SEPARATOR = /&&|\|\||;|\||(?<![<>])&(?!>)/;

/** A segment as the shell reads it. */
interface Segment {
  /** Its words joined by single spaces; whitespace inside a word is `QUOTED_SPACE`. */
  readonly text: string;
  /** Whether a word after the `alchemy` word uses an expansion the guard cannot read. */
  readonly expands: boolean;
}

/** Stands in for whitespace inside a quoted or escaped word, so the word stays one when the words are joined again. */
const QUOTED_SPACE = "\u0001";

/** `alchemy` as a whole word: on its own or at the end of a path, with or without `@<version>`. */
const ALCHEMY_WORD = /(?:^|\/)alchemy(?:@\S+)?$/;

/** A brace expansion starting at an unquoted `{`: `{a,b}` or `{1..3}`. */
const BRACE_EXPANSION = /^\{[^{}\s]*(?:,|\.\.)[^{}\s]*\}/;

/**
 * The words of one segment as the shell hands them to the command: a backslash
 * keeps the next character, `'…'` keeps everything up to the next `'`, `$'…'`
 * keeps its text with each backslash escape reduced to the escaped character,
 * and `"…"` keeps everything but a backslash before `"`, `\`, `$` or a
 * backtick. An unquoted or double-quoted `$` or backtick, or an unquoted
 * brace expansion, marks its word as expanding.
 */
function readSegment(raw: string): Segment {
  const words: { text: string; expands: boolean }[] = [];
  let text = "";
  let expands = false;
  let open = false;
  const end = (): void => {
    if (open) words.push({ text, expands });
    text = "";
    expands = false;
    open = false;
  };
  const quoted = (char: string): string => (/\s/.test(char) ? QUOTED_SPACE : char);
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i] ?? "";
    if (/\s/.test(char)) {
      end();
      continue;
    }
    open = true;
    if (char === "\\") {
      i++;
      text += quoted(raw[i] ?? "");
    } else if (char === "'" || (char === "$" && raw[i + 1] === "'")) {
      const ansi = char === "$";
      if (ansi) i++;
      for (i++; i < raw.length && raw[i] !== "'"; i++) {
        if (ansi && raw[i] === "\\") i++;
        text += quoted(raw[i] ?? "");
      }
    } else if (char === '"') {
      for (i++; i < raw.length && raw[i] !== '"'; i++) {
        const inner = raw[i] ?? "";
        if (inner === "\\" && /["\\$`]/.test(raw[i + 1] ?? "")) {
          i++;
          text += raw[i] ?? "";
          continue;
        }
        if (inner === "$" || inner === "`") expands = true;
        text += quoted(inner);
      }
    } else {
      if (char === "$" || char === "`" || (char === "{" && BRACE_EXPANSION.test(raw.slice(i)))) {
        expands = true;
      }
      text += char;
    }
  }
  end();
  const command = words.findIndex((word) => ALCHEMY_WORD.test(word.text));
  return {
    text: words.map((word) => word.text).join(" "),
    expands: command !== -1 && words.slice(command + 1).some((word) => word.expands),
  };
}

/** The Alchemy segments of a command: one per part between separators. */
const alchemySegments = (command: string): Segment[] =>
  joinContinuations(command)
    .split("\n")
    .flatMap((line) => line.split(COMMAND_SEPARATOR))
    .map(readSegment)
    .filter((segment) => ALCHEMY_COMMAND.test(segment.text));

/** The `NAME=value` assignments a command segment starts with. */
const LEADING_ASSIGNMENTS = /^\s*((?:[A-Za-z_]\w*=\S*\s+)*)/;

/** The value a segment's own leading assignments give `name` (the last one wins), or undefined when they set none. */
const inlineValue = (segment: Segment, name: string): string | undefined =>
  [...(LEADING_ASSIGNMENTS.exec(segment.text)?.[1] ?? "").matchAll(/(?:^|\s)([A-Za-z_]\w*)=(\S*)/g)]
    .filter((match) => match[1] === name)
    .map((match) => match[2])
    .at(-1);

const UNREADABLE = "an Alchemy command's arguments use a shell expansion the guard cannot read";

function forbidden(where: string, segment: Segment): Finding[] {
  if (segment.expands) return [{ where, problem: UNREADABLE }];
  const problems = FORBIDDEN.filter(({ pattern }) => pattern.test(segment.text)).map(
    ({ why }) => why,
  );
  const destroy = destroyProblem(segment.text);
  return [...problems, ...(destroy === undefined ? [] : [destroy])].map((problem) => ({
    where,
    problem,
  }));
}

interface Manifest {
  readonly scripts?: Readonly<Record<string, string>>;
}

/** Each Alchemy segment of each script in a manifest, with where it is. */
const scriptSegments = (
  where: string,
  manifestText: string,
): { readonly at: string; readonly segment: Segment }[] =>
  Object.entries((JSON.parse(manifestText) as Manifest).scripts ?? {}).flatMap(([name, value]) =>
    alchemySegments(value).map((segment) => ({ at: `${where} scripts.${name}`, segment })),
  );

export function checkPackageScripts(where: string, manifestText: string): Finding[] {
  const findings: Finding[] = [];
  for (const [name, value] of Object.entries(
    (JSON.parse(manifestText) as Manifest).scripts ?? {},
  )) {
    for (const problem of logSettingProblems(value)) {
      findings.push({ where: `${where} scripts.${name}`, problem });
    }
  }
  for (const { at, segment } of scriptSegments(where, manifestText)) {
    if (inlineValue(segment, "DO_NOT_TRACK") !== "1") {
      findings.push({ where: at, problem: "an Alchemy command must start with DO_NOT_TRACK=1" });
    }
    findings.push(...forbidden(at, segment));
  }
  return findings;
}

/**
 * Every Alchemy segment of a package script sets `CI=true`. A script runs on
 * someone's own machine as well as in CI; outside CI mode Alchemy reads a
 * stored profile, and a plan deploys a missing state store.
 */
export function checkScriptsRunAsCi(where: string, manifestText: string): Finding[] {
  return scriptSegments(where, manifestText)
    .filter(({ segment }) => inlineValue(segment, "CI") !== "true")
    .map(({ at }) => ({ where: at, problem: "an Alchemy package script must set CI=true" }));
}

/** A workflow or step `env:` block; GitHub Actions values are scalars. */
type EnvBlock = Readonly<Record<string, string | number | boolean>>;

interface Step {
  readonly env?: EnvBlock;
  readonly run?: string;
}

interface Workflow {
  readonly env?: EnvBlock;
  readonly jobs?: Readonly<
    Record<string, { readonly env?: EnvBlock; readonly steps?: readonly Step[] }>
  >;
}

interface CompositeAction {
  readonly runs?: { readonly steps?: readonly Step[] };
}

/** The log settings a command refuses, read from its words as the shell hands them over. */
function logSettingProblems(command: string): string[] {
  const problems = new Set<string>();
  if (LOG_SETTING_VARIABLE.test(command)) problems.add(LOG_VARIABLE_WHY);
  const segments = joinContinuations(command)
    .split("\n")
    .flatMap((line) => line.split(COMMAND_SEPARATOR))
    .map(readSegment);
  for (const segment of segments) {
    for (const [, kind = "", value = ""] of segment.text.matchAll(LOG_FLAG)) {
      const level = kind.toLowerCase() === "level";
      const allowed = level ? ALLOWED_LOG_VALUES.level : ALLOWED_LOG_VALUES.format;
      if (!allowed.has(value.toLowerCase())) problems.add(level ? LOG_LEVEL_WHY : LOG_FORMAT_WHY);
    }
  }
  return [...problems];
}

/** An env block that sets either of Alchemy's log variables, whatever the value. */
const envLogProblems = (where: string, env: EnvBlock | undefined): Finding[] =>
  Object.keys(env ?? {}).some((key) => LOG_SETTING_VARIABLE.test(key))
    ? [{ where, problem: LOG_VARIABLE_WHY }]
    : [];

/** The first env block that sets `DO_NOT_TRACK` decides; none set means on. */
const telemetryOff = (...levels: readonly (EnvBlock | undefined)[]): boolean => {
  const decider = levels.find((env) => env !== undefined && env.DO_NOT_TRACK !== undefined);
  return decider !== undefined && String(decider.DO_NOT_TRACK) === "1";
};

function checkSteps(
  where: string,
  steps: readonly Step[],
  outer: readonly (EnvBlock | undefined)[],
): Finding[] {
  const findings: Finding[] = [];
  for (const [index, step] of steps.entries()) {
    const at = `${where}.steps[${index}]`;
    findings.push(...envLogProblems(`${at}.env`, step.env));
    if (typeof step.run !== "string") continue;
    for (const problem of logSettingProblems(step.run)) findings.push({ where: at, problem });
    const segments = alchemySegments(step.run);
    if (segments.length === 0) continue;
    const off = telemetryOff(step.env, ...outer);
    const segmentOff = (segment: Segment): boolean => {
      const inline = inlineValue(segment, "DO_NOT_TRACK");
      return inline === undefined ? off : inline === "1";
    };
    if (!segments.every(segmentOff)) {
      findings.push({ where: at, problem: 'an Alchemy step needs DO_NOT_TRACK: "1" in its env' });
    }
    for (const segment of segments) findings.push(...forbidden(at, segment));
  }
  return findings;
}

export function checkWorkflow(where: string, yamlText: string): Finding[] {
  const workflow = (Bun.YAML.parse(yamlText) ?? {}) as Workflow;
  const findings = envLogProblems(`${where} env`, workflow.env);
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    findings.push(...envLogProblems(`${where} jobs.${jobId}.env`, job.env));
    findings.push(
      ...checkSteps(`${where} jobs.${jobId}`, job.steps ?? [], [job.env, workflow.env]),
    );
  }
  return findings;
}

export function checkCompositeAction(where: string, yamlText: string): Finding[] {
  const action = (Bun.YAML.parse(yamlText) ?? {}) as CompositeAction;
  return checkSteps(`${where} runs`, action.runs?.steps ?? [], []);
}

export function checkStackSource(where: string, text: string): Finding[] {
  const choosesState =
    STATE_CONSTRUCTOR.test(text) ||
    STATE_MODULE.test(text) ||
    PROVIDER_STAR_EXPORT.test(text) ||
    (STATE_PROVIDER_MODULE.test(text) && STORE_BINDING.test(text));
  return choosesState
    ? [{ where, problem: `a stack takes its state from stackOptions() (${STATE_STORE_FILE})` }]
    : [];
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  let gitFailed = false;
  const tracked = (...patterns: string[]): string[] => {
    const result = spawnSync("git", ["ls-files", "--", ...patterns], {
      cwd: root,
      encoding: "utf8",
    });
    if (result.status !== 0) gitFailed = true;
    return (result.stdout ?? "").split("\n").filter((path) => path !== "");
  };
  const read = (path: string): string => readFileSync(resolve(root, path), "utf8");
  const manifests = tracked("package.json", "*/package.json");
  const findings = [
    ...manifests.flatMap((path) => [
      ...checkPackageScripts(path, read(path)),
      ...checkScriptsRunAsCi(path, read(path)),
    ]),
    ...tracked(".github/workflows/*.yml", ".github/workflows/*.yaml").flatMap((path) =>
      checkWorkflow(path, read(path)),
    ),
    ...tracked(".github/actions/*/action.yml", ".github/actions/*/action.yaml").flatMap((path) =>
      checkCompositeAction(path, read(path)),
    ),
    ...tracked("*/infra/*.ts", "*alchemy.run.ts")
      .filter((path) => path !== STATE_STORE_FILE && !/(?:^|\/)tests\//.test(path))
      .flatMap((path) => checkStackSource(path, read(path))),
  ];
  if (gitFailed || !manifests.includes("package.json")) {
    process.stderr.write(
      "check-alchemy-usage: could not list the files git tracks; nothing was checked.\n",
    );
    process.exit(1);
  }
  for (const finding of findings) process.stderr.write(`${finding.where}: ${finding.problem}\n`);
  process.stdout.write(
    findings.length === 0
      ? "check-alchemy-usage: every Alchemy use passes.\n"
      : `check-alchemy-usage: ${findings.length} finding(s).\n`,
  );
  process.exit(findings.length === 0 ? 0 : 1);
}
