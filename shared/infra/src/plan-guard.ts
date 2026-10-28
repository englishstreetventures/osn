import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { PRODUCTION_ADOPTIONS, type SiteMode, type SiteSurface } from "./production-sites";

/**
 * What a production plan's resource is, as far as the guard cares. A Worker
 * that holds a custom domain is `custom-domain`: replacing or deleting it
 * takes the domain down with it.
 */
export type ResourceKind = "worker" | "custom-domain" | "d1" | "r2" | "route";

/** Kinds whose replacement, deletion or orphaning loses data or a live domain. */
export const PROTECTED_KINDS: ReadonlySet<ResourceKind> = new Set([
  "custom-domain",
  "d1",
  "r2",
  "route",
]);

/** Resource actions Alchemy prints (alchemy src/Plan.ts `CRUD`). */
export type ResourceAction =
  | "create"
  | "update"
  | "adopted"
  | "replace"
  | "delete"
  | "orphaned"
  | "noop";

/** Binding actions as Alchemy prints them: `delete` reads `unbind` (src/Cli/LoggingCli.ts). */
export type BindingAction = "create" | "update" | "unbind" | "noop";

const COUNTED: readonly Exclude<ResourceAction, "noop">[] = [
  "create",
  "update",
  "adopted",
  "replace",
  "delete",
  "orphaned",
];
const RESOURCE_ACTIONS: ReadonlySet<string> = new Set([...COUNTED, "noop"]);
const BINDING_ACTIONS: ReadonlySet<string> = new Set(["create", "update", "unbind", "noop"]);
const ESCALATING: ReadonlySet<ResourceAction> = new Set(["replace", "delete", "orphaned"]);

export interface PlannedResource {
  readonly fqn: string;
  readonly action: ResourceAction;
}

export interface PlannedBinding {
  /** `<resource FQN>/<binding id>`. */
  readonly fqn: string;
  readonly action: BindingAction;
}

export interface ParsedPlan {
  /** `missing` when the log holds no Plan line. */
  readonly plan: "changes" | "no-changes" | "no-resources" | "missing";
  /** The Plan line's counts: each action, `binding changes` and `tasks`. */
  readonly counts: Readonly<Record<string, number>>;
  readonly resources: readonly PlannedResource[];
  readonly bindings: readonly PlannedBinding[];
  /** Faults in the plan text itself, each a fixed phrase and at most a resource name. */
  readonly problems: readonly string[];
}

// oxlint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
/** The prefix Effect's pretty logger puts on each record (alchemy src/Util/ResourceOutput.ts). */
const EFFECT_PREFIX =
  /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] (?:ALL|TRACE|DEBUG|INFO|WARN|ERROR|FATAL|NONE) \(#\d+\)(?: [^:]+)?: /;
/** A logfmt record's message, quoted or bare (Effect's `formatLogFmt`, the run-log file). */
const LOGFMT = /^(?:\S+=\S*\s+)*?message=("(?:[^"\\]|\\.)*"|\S*)/;
const PLAN = /^Plan:\s+(.+?)\s*$/;
const TAGGED = /^\[([^\]]+)\] (.+)$/;
const PART =
  /^(\d+) (?:to (create|update|adopted|replace|delete|orphaned)|(binding changes|tasks))$/;
const TASK = /^(?:run|drop) \[action\]$/;
const NOTE = /^\(([^)]*)\)$/;

/** One log line's message: colour, Effect's prefix and a logfmt wrapper removed. */
export function messageOf(line: string): string {
  const plain = line.replace(ANSI, "").replace(/\r$/, "");
  const logfmt = /\blevel=/.test(plain) ? LOGFMT.exec(plain) : null;
  if (logfmt !== null) {
    const value = logfmt[1] ?? "";
    if (!value.startsWith('"')) return value;
    try {
      return String(JSON.parse(value));
    } catch {
      return value;
    }
  }
  return plain.replace(EFFECT_PREFIX, "");
}

/** A Plan line read: its counts, and what in it the guard could not read. */
interface PlanLine {
  readonly counts: Record<string, number>;
  readonly problems: string[];
}

function countsOf(text: string): PlanLine {
  const counts: Record<string, number> = {};
  const problems: string[] = [];
  if (text === "no changes" || text === "no resources") return { counts, problems };
  for (const part of text.split(", ")) {
    const match = PART.exec(part);
    if (match === null) {
      problems.push("the Plan line holds a part the guard does not know");
      continue;
    }
    const name = match[2] ?? match[3] ?? "";
    counts[name] = (counts[name] ?? 0) + Number(match[1]);
  }
  return { counts, problems };
}

/**
 * The plan in an Alchemy run's log (src/Cli/LoggingCli.ts `formatPlanLines`):
 * the last Plan line, then each `[<FQN>] <action>` line after it, up to the
 * first line that is not one. A binding line follows its resource and names
 * `<FQN>/<binding id>`. Every line Alchemy prints for a resource is read,
 * noops included; the Plan line counts all but noops.
 */
export function parsePlan(log: string): ParsedPlan {
  const messages = log.split("\n").map(messageOf);
  const at = messages.findLastIndex((message) => PLAN.test(message));
  if (at === -1) {
    return { plan: "missing", counts: {}, resources: [], bindings: [], problems: [] };
  }
  const text = PLAN.exec(messages[at] ?? "")?.[1] ?? "";
  const { counts, problems } = countsOf(text);
  const resources: PlannedResource[] = [];
  const bindings: PlannedBinding[] = [];
  let owner: string | undefined;
  for (const message of messages.slice(at + 1)) {
    const tagged = TAGGED.exec(message);
    if (tagged === null) break;
    const fqn = tagged[1] ?? "";
    const rest = tagged[2] ?? "";
    if (TASK.test(rest)) {
      problems.push(`${fqn} is a task; a production plan runs none`);
      continue;
    }
    const [action = "", ...notes] = rest.split(/ (?=\()/);
    if (owner !== undefined && fqn.startsWith(`${owner}/`)) {
      if (!BINDING_ACTIONS.has(action) || notes.length > 0) {
        problems.push(`${fqn} has a binding action the guard does not know`);
        continue;
      }
      bindings.push({ fqn, action: action as BindingAction });
      continue;
    }
    if (!RESOURCE_ACTIONS.has(action)) {
      problems.push(`${fqn} has an action the guard does not know`);
      continue;
    }
    for (const note of notes) {
      const inner = NOTE.exec(note)?.[1] ?? "";
      problems.push(
        inner.startsWith("renamed from ")
          ? `${fqn} moved from another logical id; production ids never change`
          : `${fqn} does not run live; every production resource does`,
      );
    }
    resources.push({ fqn, action: action as ResourceAction });
    owner = fqn;
  }
  const plan =
    text === "no changes" ? "no-changes" : text === "no resources" ? "no-resources" : "changes";
  return { plan, counts, resources, bindings, problems };
}

/** What the guard is told about one stack's production plan. */
export interface GuardInput {
  readonly plan: ParsedPlan;
  /** Every logical id the stack may declare on production, with its kind. */
  readonly kinds: Readonly<Record<string, ResourceKind>>;
  readonly adoptions?: readonly string[];
  /** In a flip release, the one resource whose update moves a domain. */
  readonly flip?: string;
}

/**
 * What the guard refuses in a plan's text alone, whatever the stack: what
 * `parsePlan` could not read or will not run, and lines that disagree with
 * the Plan line's counts. Empty for a plan with no Plan line, which
 * `guardPlan` refuses on its own.
 */
export function planTextFaults(plan: ParsedPlan): string[] {
  if (plan.plan === "missing") return [];
  const faults = [...plan.problems];
  for (const action of COUNTED) {
    const listed = plan.resources.filter((resource) => resource.action === action).length;
    const counted = plan.counts[action] ?? 0;
    if (listed !== counted) {
      faults.push(`the plan lists ${listed} to ${action}, and its Plan line counts ${counted}`);
    }
  }
  const changedBindings = plan.bindings.filter((binding) => binding.action !== "noop").length;
  if (changedBindings !== (plan.counts["binding changes"] ?? 0)) {
    faults.push(
      `the plan lists ${changedBindings} binding changes, and its Plan line counts ${plan.counts["binding changes"] ?? 0}`,
    );
  }
  return faults;
}

/**
 * Every reason to refuse `plan`, empty when it may be applied: no Plan line,
 * plan text the guard cannot read or whose lines disagree with its counts,
 * a resource the stack does not declare on production, an adoption while
 * PRODUCTION_ADOPTIONS is empty, a protected kind replaced, deleted or
 * orphaned, and in a flip release anything but the flip's own update.
 */
export function guardPlan(input: GuardInput): string[] {
  const { plan, kinds } = input;
  if (plan.plan === "missing") return ["the Alchemy log holds no Plan line"];
  const refusals = planTextFaults(plan);
  if ((plan.counts.tasks ?? 0) > 0)
    refusals.push("the plan runs tasks; a production plan runs none");
  const adoptions = input.adoptions ?? PRODUCTION_ADOPTIONS;
  for (const resource of plan.resources) {
    const kind = kinds[resource.fqn];
    if (kind === undefined) {
      refusals.push(`${resource.fqn} is not a resource this stack declares on production`);
      continue;
    }
    if (resource.action === "adopted" && adoptions.length === 0) {
      refusals.push(`${resource.fqn} would be adopted, and PRODUCTION_ADOPTIONS is empty`);
    }
    if (ESCALATING.has(resource.action) && PROTECTED_KINDS.has(kind)) {
      refusals.push(
        `${resource.fqn} (${kind}) would be ${resource.action === "orphaned" ? "orphaned" : `${resource.action}d`}`,
      );
    }
  }
  if (input.flip !== undefined) refusals.push(...flipRefusals(plan, input.flip));
  return refusals;
}

/** A flip release changes one thing: the flip's own update. */
function flipRefusals(plan: ParsedPlan, flip: string): string[] {
  const refusals: string[] = [];
  const own = plan.resources.find((resource) => resource.fqn === flip);
  if (own?.action !== "update") refusals.push(`a flip release must update ${flip}`);
  for (const resource of plan.resources) {
    if (resource.fqn !== flip && resource.action !== "noop") {
      refusals.push(
        `a flip release changes only ${flip}, and ${resource.fqn} would ${resource.action === "adopted" ? "be adopted" : resource.action}`,
      );
    }
  }
  if (plan.bindings.some((binding) => binding.action !== "noop")) {
    refusals.push("a flip release changes no binding");
  }
  return refusals;
}

/** The kinds of a stack's production sites: each staged or worker site is a Worker holding a domain. */
export function productionSiteKinds(
  sites: Readonly<Partial<Record<SiteSurface, string>>>,
  modes: Readonly<Record<SiteSurface, SiteMode>>,
): Record<string, ResourceKind> {
  return Object.fromEntries(
    Object.entries(sites).flatMap(([surface, logicalId]) =>
      logicalId !== undefined && modes[surface as SiteSurface] !== "off"
        ? [[logicalId, "custom-domain" as const]]
        : [],
    ),
  );
}

/** The guard's record of one plan: names, kinds, actions and counts, in a fixed order. */
export function planRecord(input: {
  readonly stack: string;
  readonly plan: ParsedPlan;
  readonly kinds: Readonly<Record<string, ResourceKind>>;
  readonly flip?: string;
}): string {
  const byFqn = (a: { readonly fqn: string }, b: { readonly fqn: string }) =>
    a.fqn.localeCompare(b.fqn);
  const counts = Object.fromEntries(
    Object.entries(input.plan.counts).toSorted(([a], [b]) => a.localeCompare(b)),
  );
  const record = {
    stack: input.stack,
    plan: input.plan.plan,
    counts,
    resources: input.plan.resources.toSorted(byFqn).map((resource) => ({
      fqn: resource.fqn,
      kind: input.kinds[resource.fqn] ?? "unknown",
      action: resource.action,
    })),
    bindings: input.plan.bindings.toSorted(byFqn).map((binding) => ({
      fqn: binding.fqn,
      action: binding.action,
    })),
    flip: input.flip ?? null,
  };
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** The run summary's section: the plan's resource names, kinds and actions, and why it was refused. */
export function renderGuardSummary(input: {
  readonly stack: string;
  readonly plan: ParsedPlan;
  readonly kinds: Readonly<Record<string, ResourceKind>>;
  readonly refusals: readonly string[];
}): string {
  const { plan } = input;
  const counts = Object.entries(plan.counts)
    .map(([name, count]) =>
      COUNTED.includes(name as never) ? `${count} to ${name}` : `${count} ${name}`,
    )
    .join(", ");
  const heading = `### ${input.stack} production plan: ${plan.plan === "changes" ? counts : plan.plan}`;
  const rows = plan.resources.map(
    (resource) =>
      `| \`${resource.fqn}\` | ${input.kinds[resource.fqn] ?? "unknown"} | ${resource.action} |`,
  );
  const table =
    rows.length === 0 ? [] : ["", "| Resource | Kind | Action |", "|---|---|---|", ...rows];
  const refused =
    input.refusals.length === 0
      ? ["", "The guard allows this plan."]
      : ["", "**Refused:**", ...input.refusals.map((reason) => `- ${reason}`)];
  return [heading, ...table, ...refused, ""].join("\n");
}

const escapeData = (text: string) =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

/** What one product's guard entry hands the CLI. */
export interface PlanGuardCliInput {
  readonly stack: string;
  readonly kinds: Readonly<Record<string, ResourceKind>>;
  /** The product's site logical ids, which `--flip <surface>` names. */
  readonly sites: Readonly<Partial<Record<SiteSurface, string>>>;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (text: string) => void;
  readonly adoptions?: readonly string[];
}

/**
 * The plan guard as a product's `plan:guard` script runs it:
 * `--log <alchemy log> --out <record.json> [--flip <surface>] [--approved <record.json>]`.
 * Writes the record to `--out` and a summary to $GITHUB_STEP_SUMMARY (the
 * output when unset). Exits 1 when the guard refuses the plan, or when
 * `--approved` names a record this one differs from; 2 on bad arguments.
 */
export function runPlanGuardCli(input: PlanGuardCliInput): number {
  const args = input.argv.filter((arg) => arg !== "--");
  const value = (name: string): string | undefined => {
    const at = args.indexOf(`--${name}`);
    return at === -1 ? undefined : args[at + 1];
  };
  const usage = (message: string): number => {
    input.out(`::error::plan-guard: ${escapeData(message)}\n`);
    return 2;
  };
  const log = value("log");
  const outFile = value("out");
  if (
    log === undefined ||
    outFile === undefined ||
    log.startsWith("--") ||
    outFile.startsWith("--")
  ) {
    return usage("pass --log <alchemy log> and --out <record file>");
  }
  const flipSurface = value("flip");
  let flip: string | undefined;
  if (flipSurface !== undefined && flipSurface !== "") {
    flip = input.sites[flipSurface as SiteSurface];
    if (flip === undefined) {
      return usage(`--flip names ${flipSurface}, which is not a site of the ${input.stack} stack`);
    }
  }
  let text = "";
  try {
    text = readFileSync(log, "utf8");
  } catch {
    // An unreadable log holds no Plan line, which the guard refuses.
  }
  const plan = parsePlan(text);
  const refusals = guardPlan({ plan, kinds: input.kinds, adoptions: input.adoptions, flip });
  const record = planRecord({ stack: input.stack, plan, kinds: input.kinds, flip });
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, record);
  const summary = renderGuardSummary({ stack: input.stack, plan, kinds: input.kinds, refusals });
  const summaryFile = input.env.GITHUB_STEP_SUMMARY ?? "";
  if (summaryFile === "") input.out(summary);
  else appendFileSync(summaryFile, summary);
  for (const reason of refusals) {
    input.out(`::error::${input.stack} production plan refused: ${escapeData(reason)}\n`);
  }
  if (refusals.length > 0) return 1;
  const approved = value("approved");
  if (approved !== undefined) {
    let approvedRecord: string | undefined;
    try {
      approvedRecord = readFileSync(approved, "utf8");
    } catch {
      approvedRecord = undefined;
    }
    if (approvedRecord !== record) {
      input.out(
        `::error::${input.stack}: this plan is not the one approved at the plan step, so it is not applied. Dispatch a new release to approve the plan as it stands.\n`,
      );
      return 1;
    }
  }
  return 0;
}
