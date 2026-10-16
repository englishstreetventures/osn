#!/usr/bin/env bun
/**
 * Guard: every Alchemy CLI run sends no telemetry, no committed command prints
 * or deletes Alchemy state or the state store, and no stack chooses its own
 * state store.
 *
 *  - Commands are read after joining backslash line continuations and split
 *    into segments on `&&`, `||`, `;`, `|` and a background `&` (not the `&`
 *    of a redirection such as `2>&1`); each segment is checked alone.
 *  - package.json scripts: every segment that runs Alchemy starts with
 *    `DO_NOT_TRACK=1 `.
 *  - workflows: a step that runs Alchemy has `DO_NOT_TRACK: "1"` in its own
 *    `env` or, when the step sets none, in the job or workflow `env`; a
 *    different value there turns telemetry on. Otherwise each Alchemy segment
 *    carries the inline prefix. Composite actions: on the step or the segment.
 *  - all three: `alchemy state ls`/`list` is the only `state` command allowed
 *    (bare `state` opens an explorer that reads records; `provider cloudflare
 *    state logs` reads the store's logs), and never `nuke`, `drift … --repair`,
 *    `teardown`, `provider cloudflare token` (it prints the token it creates)
 *    or `destroy` with `--stage dev` or `--stage production`, in any flag order.
 *  - stack files (`*\/infra/**\/*.ts`, `*alchemy.run.ts`, tests excluded): no
 *    state constructor, no `state` import from `alchemy/Cloudflare`, and no
 *    `.state(` call in a file that names `alchemy/Cloudflare` or `alchemy/AWS`
 *    as a module in any import form; `shared/infra/src/stack.ts` alone calls
 *    `Cloudflare.state()`.
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

const FORBIDDEN: readonly { readonly pattern: RegExp; readonly why: string }[] = [
  {
    pattern: new RegExp(String.raw`${INVOCATION}(?:[^\n]*?\s)?state\b(?!\s+(?:ls|list)\b)`),
    why: "only `alchemy state ls` may run; every other state command prints, reads or deletes Alchemy state",
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
    pattern: new RegExp(
      String.raw`${INVOCATION}(?=[^\n]*\bdestroy\b)(?=[^\n]*--stage(?:\s+|=)["']?(?:dev|production)["']?(?![\w-]))`,
    ),
    why: "`destroy` on dev or production deletes every resource and state row of a long-lived stage",
  },
];

const STATE_CONSTRUCTOR =
  /\b(?:localState|inMemoryState|postgresState)\s*\(|\bCloudflare\.state\b|\bimport\s*\{[^}]*\bstate\b[^}]*\}\s*from\s*["']alchemy\/Cloudflare["']/;

/** `alchemy/Cloudflare` or `alchemy/AWS`, or a path under either, quoted as a module specifier: each exports a `state()`. */
const STATE_PROVIDER_MODULE = /["']alchemy\/(?:Cloudflare|AWS)(?:\/[^"'\n]*)?["']/;

const STATE_CALL = /\.state\s*\(/;

/** Backslash-newline continuations become one space, as the shell reads them. */
const joinContinuations = (command: string): string => command.replace(/\\\r?\n\s*/g, " ");

/** `&&`, `||`, `;`, `|`, or a lone `&` that runs a command in the background; never the `&` of `2>&1`, `>&2` or `&>`. */
const COMMAND_SEPARATOR = /&&|\|\||;|\||(?<![<>])&(?!>)/;

/** The Alchemy segments of a command: one per part between separators. */
const alchemySegments = (command: string): string[] =>
  joinContinuations(command)
    .split("\n")
    .flatMap((line) => line.split(COMMAND_SEPARATOR))
    .filter((segment) => ALCHEMY_COMMAND.test(segment));

const INLINE_TELEMETRY_OFF = /^\s*(?:[A-Za-z_]\w*=\S*\s+)*DO_NOT_TRACK=1\s/;

function forbidden(where: string, segment: string): Finding[] {
  return FORBIDDEN.filter(({ pattern }) => pattern.test(segment)).map(({ why }) => ({
    where,
    problem: why,
  }));
}

interface Manifest {
  readonly scripts?: Readonly<Record<string, string>>;
}

export function checkPackageScripts(where: string, manifestText: string): Finding[] {
  const manifest = JSON.parse(manifestText) as Manifest;
  const findings: Finding[] = [];
  for (const [name, value] of Object.entries(manifest.scripts ?? {})) {
    const at = `${where} scripts.${name}`;
    for (const segment of alchemySegments(value)) {
      if (!INLINE_TELEMETRY_OFF.test(segment)) {
        findings.push({ where: at, problem: "an Alchemy command must start with DO_NOT_TRACK=1" });
      }
      findings.push(...forbidden(at, segment));
    }
  }
  return findings;
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
    if (typeof step.run !== "string") continue;
    const segments = alchemySegments(step.run);
    if (segments.length === 0) continue;
    const at = `${where}.steps[${index}]`;
    const off = telemetryOff(step.env, ...outer);
    if (!off && !segments.every((segment) => INLINE_TELEMETRY_OFF.test(segment))) {
      findings.push({ where: at, problem: 'an Alchemy step needs DO_NOT_TRACK: "1" in its env' });
    }
    for (const segment of segments) findings.push(...forbidden(at, segment));
  }
  return findings;
}

export function checkWorkflow(where: string, yamlText: string): Finding[] {
  const workflow = (Bun.YAML.parse(yamlText) ?? {}) as Workflow;
  return Object.entries(workflow.jobs ?? {}).flatMap(([jobId, job]) =>
    checkSteps(`${where} jobs.${jobId}`, job.steps ?? [], [job.env, workflow.env]),
  );
}

export function checkCompositeAction(where: string, yamlText: string): Finding[] {
  const action = (Bun.YAML.parse(yamlText) ?? {}) as CompositeAction;
  return checkSteps(`${where} runs`, action.runs?.steps ?? [], []);
}

export function checkStackSource(where: string, text: string): Finding[] {
  const choosesState =
    STATE_CONSTRUCTOR.test(text) || (STATE_PROVIDER_MODULE.test(text) && STATE_CALL.test(text));
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
    ...manifests.flatMap((path) => checkPackageScripts(path, read(path))),
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
