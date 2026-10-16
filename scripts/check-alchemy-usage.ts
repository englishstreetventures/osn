#!/usr/bin/env bun
/**
 * Guard: every Alchemy CLI run sends no telemetry, no committed command prints
 * or deletes Alchemy state or the state store, and no stack chooses its own
 * state store.
 *
 *  - package.json scripts: an Alchemy command starts with `DO_NOT_TRACK=1 `.
 *  - workflows: a step that runs Alchemy has `DO_NOT_TRACK: "1"` in the
 *    workflow, job or step `env`, or the inline prefix on each Alchemy line.
 *    Composite actions: on the step or the line.
 *  - all three: `alchemy state ls`/`list` is the only `state` command allowed
 *    (bare `state` opens an explorer that reads records; `provider cloudflare
 *    state logs` reads the store's logs), and never `nuke`, `drift … --repair`
 *    or `teardown`.
 *  - stack files (`*\/infra/**\/*.ts`, `*alchemy.run.ts`, tests excluded): no
 *    state constructor and no `state` import from `alchemy/Cloudflare`;
 *    `shared/infra/src/stack.ts` alone calls `Cloudflare.state()`.
 *
 * Unit tests: scripts/tests/check-alchemy-usage.test.ts. CI runs this file
 * against the committed tree in the `script-tests` job of .github/workflows/ci.yml.
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
];

const STATE_CONSTRUCTOR =
  /\b(?:localState|inMemoryState|postgresState)\s*\(|\bCloudflare\.state\b|\bimport\s*\{[^}]*\bstate\b[^}]*\}\s*from\s*["']alchemy\/Cloudflare["']/;

function forbidden(where: string, command: string): Finding[] {
  return FORBIDDEN.filter(({ pattern }) => pattern.test(command)).map(({ why }) => ({
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
    if (!ALCHEMY_COMMAND.test(value)) continue;
    const at = `${where} scripts.${name}`;
    if (!value.startsWith("DO_NOT_TRACK=1 ")) {
      findings.push({ where: at, problem: "an Alchemy command must start with DO_NOT_TRACK=1" });
    }
    findings.push(...forbidden(at, value));
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

const telemetryOff = (env: EnvBlock | undefined): boolean =>
  env !== undefined && String(env.DO_NOT_TRACK) === "1";

function checkSteps(where: string, steps: readonly Step[], inheritedOff: boolean): Finding[] {
  const findings: Finding[] = [];
  for (const [index, step] of steps.entries()) {
    if (typeof step.run !== "string" || !ALCHEMY_COMMAND.test(step.run)) continue;
    const at = `${where}.steps[${index}]`;
    const inline = step.run
      .split("\n")
      .filter((line) => ALCHEMY_COMMAND.test(line))
      .every((line) => /(?:^|\s)DO_NOT_TRACK=1\s/.test(line));
    if (!(inheritedOff || telemetryOff(step.env) || inline)) {
      findings.push({ where: at, problem: 'an Alchemy step needs DO_NOT_TRACK: "1" in its env' });
    }
    findings.push(...forbidden(at, step.run));
  }
  return findings;
}

export function checkWorkflow(where: string, yamlText: string): Finding[] {
  const workflow = (Bun.YAML.parse(yamlText) ?? {}) as Workflow;
  return Object.entries(workflow.jobs ?? {}).flatMap(([jobId, job]) =>
    checkSteps(
      `${where} jobs.${jobId}`,
      job.steps ?? [],
      telemetryOff(workflow.env) || telemetryOff(job.env),
    ),
  );
}

export function checkCompositeAction(where: string, yamlText: string): Finding[] {
  const action = (Bun.YAML.parse(yamlText) ?? {}) as CompositeAction;
  return checkSteps(`${where} runs`, action.runs?.steps ?? [], false);
}

export function checkStackSource(where: string, text: string): Finding[] {
  return STATE_CONSTRUCTOR.test(text)
    ? [{ where, problem: `a stack takes its state from stackOptions() (${STATE_STORE_FILE})` }]
    : [];
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const tracked = (...patterns: string[]): string[] =>
    spawnSync("git", ["ls-files", "--", ...patterns], { cwd: root, encoding: "utf8" })
      .stdout.split("\n")
      .filter((path) => path !== "");
  const read = (path: string): string => readFileSync(resolve(root, path), "utf8");
  const findings = [
    ...tracked("package.json", "*/package.json").flatMap((path) =>
      checkPackageScripts(path, read(path)),
    ),
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
  for (const finding of findings) process.stderr.write(`${finding.where}: ${finding.problem}\n`);
  process.stdout.write(
    findings.length === 0
      ? "check-alchemy-usage: every Alchemy use passes.\n"
      : `check-alchemy-usage: ${findings.length} finding(s).\n`,
  );
  process.exit(findings.length === 0 ? 0 : 1);
}
