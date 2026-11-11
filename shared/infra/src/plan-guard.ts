import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import {
  heldHost,
  HOST_HOLDS_FILE,
  type HostHold,
  PRODUCTION_ADOPTIONS,
  PRODUCTION_HOST_HOLDS,
  SITE_SURFACES,
  type SiteMode,
  type SiteSurface,
} from "./production-sites";

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
/**
 * The prefix on each line of an Alchemy run's console: `[hh:mm:ss.mmm] LEVEL: `,
 * as Alchemy's console sink prints a record and a plan line (alchemy
 * src/Util/ConsoleSink.ts `prettyLine`, src/Cli/Present.ts `present`). A
 * fiber id and span after the level, as Effect's own pretty logger prints a
 * record, are read too: Alchemy's failure line carries them, and so do the
 * dev deploy logs in tests/fixtures.
 */
const LINE_PREFIX =
  /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] (?:TRACE|DEBUG|INFO|WARN|ERROR|FATAL)(?: \(#\d+\)(?: [^:]+)?)?: /;
const PLAN = /^Plan:\s+(.+?)\s*$/;
const TAGGED = /^\[([^\]]+)\] (.+)$/;
const PART =
  /^(\d+) (?:to (create|update|adopted|replace|delete|orphaned)|(binding changes|tasks))$/;
const TASK = /^(?:run|drop) \[action\]$/;
const NOTE = /^\(([^)]*)\)$/;

/** One console line's message: colour and the line's prefix removed. */
export function messageOf(line: string): string {
  return line.replace(ANSI, "").replace(/\r$/, "").replace(LINE_PREFIX, "");
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
 * PRODUCTION_ADOPTIONS is empty, and a protected kind replaced, deleted or
 * orphaned.
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
  return refusals;
}

/**
 * One site's custom-domain change: the hosts its Worker gains and loses when
 * the plan applies. A plan line reads `update` whatever an update changes, so
 * the guard reads the domains apart from the plan, as the Worker holds them
 * now against the host the stack's declaration gives it.
 */
export interface DomainChange {
  readonly site: SiteSurface;
  readonly added: readonly string[];
  readonly removed: readonly string[];
}

/**
 * The host each site a stack declares gives its Worker, null for none. A
 * site the stack does not declare is absent.
 */
export type DeclaredDomains = Readonly<Partial<Record<SiteSurface, string | null>>>;

/**
 * Each declared site's host, from a production declaration's sites by logical
 * id (`ids`, the product's SITE_LOGICAL_IDS). The guard reads these, the
 * values the stack hands Alchemy, rather than working them out again, so its
 * hold check does not lean on the declaration having applied the holds.
 */
export function declaredDomains(
  ids: Readonly<Partial<Record<SiteSurface, string>>>,
  sites: Readonly<Record<string, { readonly domain: string | null }>>,
): DeclaredDomains {
  return Object.fromEntries(
    SITE_SURFACES.flatMap((site): [SiteSurface, string | null][] => {
      const id = ids[site];
      const declared = id === undefined ? undefined : sites[id];
      return declared === undefined ? [] : [[site, declared.domain]];
    }),
  );
}

const declaredSites = (declared: DeclaredDomains): SiteSurface[] =>
  SITE_SURFACES.filter((site) => Object.hasOwn(declared, site)).toSorted();

/** What `domainChanges` found: each site's change, and each site it could not read. */
export interface DomainReading {
  readonly changes: readonly DomainChange[];
  readonly problems: readonly string[];
}

/** The hosts `live` lists for `site`, or undefined unless it lists them as strings. */
function heldBy(live: unknown, site: SiteSurface): readonly string[] | undefined {
  if (typeof live !== "object" || live === null || Array.isArray(live)) return undefined;
  const held = Object.entries(live).find(([key]) => key === site)?.[1];
  if (!Array.isArray(held)) return undefined;
  const hosts = held.filter((host): host is string => typeof host === "string");
  return hosts.length === held.length ? hosts : undefined;
}

/**
 * Each declared site's change, from the hosts its Worker holds now (`live`,
 * as `worker-deployments.ts domains` read them) and the one the declaration
 * gives it; only sites with a change, by site. `problems` names a site whose
 * live hosts were not read.
 */
export function domainChanges(input: {
  readonly declared: DeclaredDomains;
  readonly live: unknown;
}): DomainReading {
  const changes: DomainChange[] = [];
  const problems: string[] = [];
  for (const site of declaredSites(input.declared)) {
    const held = heldBy(input.live, site);
    if (held === undefined) {
      problems.push(`the hosts ${site}'s Worker holds now were not read`);
      continue;
    }
    const declared = input.declared[site] ?? null;
    const wanted = declared === null ? [] : [declared];
    const added = wanted.filter((host) => !held.includes(host));
    const removed = [...new Set(held)].filter((host) => !wanted.includes(host)).toSorted();
    if (added.length > 0 || removed.length > 0) changes.push({ site, added, removed });
  }
  return { changes, problems };
}

const holdOn = (host: string, holds: readonly HostHold[]): HostHold | undefined =>
  holds.find((hold) => hold.host === host);

/**
 * No host a Worker holds leaves in a release: its production host, another
 * site's host, or one PRODUCTION_HOSTS no longer names. Taking a host off is
 * done by hand in the Cloudflare dashboard, after which the Worker no longer
 * holds it and the guard sees nothing to refuse. A held host's refusal says
 * it is held.
 */
export function domainRefusals(
  changes: readonly DomainChange[],
  holds: readonly HostHold[] = PRODUCTION_HOST_HOLDS,
): string[] {
  return changes.flatMap(({ site, removed }) =>
    removed.map(
      (host) =>
        `${site}'s Worker would give up ${host}${holdOn(host, holds) === undefined ? "" : `, which PRODUCTION_HOST_HOLDS in ${HOST_HOLDS_FILE} holds off`}; no release takes a production host off its Worker: remove it in the Cloudflare dashboard first`,
    ),
  );
}

/**
 * A site Worker declared with a held host is refused, whichever site it is
 * and whether or not the Worker holds the host now, so no release from a
 * commit that holds the host serves it from a stack's site Worker.
 */
export function holdRefusals(
  declared: DeclaredDomains,
  holds: readonly HostHold[] = PRODUCTION_HOST_HOLDS,
): string[] {
  return declaredSites(declared).flatMap((site) => {
    const host = declared[site] ?? null;
    const hold = host === null ? undefined : holdOn(host, holds);
    return hold === undefined
      ? []
      : [
          `${site}'s Worker would serve ${hold.host}, which PRODUCTION_HOST_HOLDS in ${HOST_HOLDS_FILE} holds off every Worker (${hold.reason}); a release serves it again only once a pull request removes its entry`,
        ];
  });
}

/**
 * A scheduled release adds no host to a site Worker: each host a Worker
 * would gain is refused, so a host comes back, or is first attached, only in
 * a release someone dispatched by hand.
 */
export function addedHostRefusals(changes: readonly DomainChange[]): string[] {
  return changes.flatMap(({ site, added }) =>
    added.map(
      (host) =>
        `${site}'s Worker would gain ${host}, and a scheduled release adds no host: dispatch Production release by hand to add it`,
    ),
  );
}

/** The kinds of a stack's production sites: each worker site is a Worker holding a domain. */
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

/**
 * The guard's record of one plan: names, kinds, actions and counts, and the
 * custom-domain changes, in a fixed order.
 */
export function planRecord(input: {
  readonly stack: string;
  readonly plan: ParsedPlan;
  readonly kinds: Readonly<Record<string, ResourceKind>>;
  readonly domains?: readonly DomainChange[];
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
    domains: (input.domains ?? []).map(({ site, added, removed }) => ({ site, added, removed })),
  };
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * The run summary's section: the plan's resource names, kinds and actions,
 * each site's domain change, the holds on the stack's sites (`held`), and
 * why it was refused.
 */
export function renderGuardSummary(input: {
  readonly stack: string;
  readonly plan: ParsedPlan;
  readonly kinds: Readonly<Record<string, ResourceKind>>;
  readonly refusals: readonly string[];
  readonly domains?: readonly DomainChange[];
  readonly held?: readonly HostHold[];
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
  const listed = (hosts: readonly string[]) =>
    hosts.length === 0 ? "—" : hosts.map((host) => `\`${host}\``).join(", ");
  const domains = input.domains ?? [];
  const domainTable =
    domains.length === 0
      ? ["", "No site's custom domains change."]
      : [
          "",
          "| Site | Domains added | Domains removed |",
          "|---|---|---|",
          ...domains.map(
            (change) =>
              `| \`${change.site}\` | ${listed(change.added)} | ${listed(change.removed)} |`,
          ),
        ];
  const held = input.held ?? [];
  const holdLines =
    held.length === 0
      ? []
      : [
          "",
          `Held off their Workers by \`PRODUCTION_HOST_HOLDS\` (\`${HOST_HOLDS_FILE}\`):`,
          ...held.map((hold) => `- \`${hold.host}\` (\`${hold.site}\`): ${hold.reason}`),
        ];
  const refused =
    input.refusals.length === 0
      ? ["", "The guard allows this plan."]
      : ["", "**Refused:**", ...input.refusals.map((reason) => `- ${reason}`)];
  return [heading, ...table, ...domainTable, ...holdLines, ...refused, ""].join("\n");
}

const escapeData = (text: string) =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");

/** What one product's guard entry hands the CLI. */
export interface PlanGuardCliInput {
  readonly stack: string;
  readonly kinds: Readonly<Record<string, ResourceKind>>;
  /**
   * The host the product's production declaration gives each site's Worker
   * (its PRODUCTION_SITE_DOMAINS): the sites whose live custom domains
   * `--domains` must hold.
   */
  readonly declared: DeclaredDomains;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (text: string) => void;
  readonly adoptions?: readonly string[];
  /** The host holds, PRODUCTION_HOST_HOLDS unless a test passes its own. */
  readonly holds?: readonly HostHold[];
}

/**
 * The plan guard as a product's `plan:guard` script runs it: `--log <alchemy
 * log> --out <record.json> --domains <live domains.json> [--approved
 * <record.json>] [--scheduled]`. `--domains` is what
 * `worker-deployments.ts domains` read for the stack's sites; `--scheduled`,
 * which a release started by its schedule passes, refuses every host a Worker
 * would gain. Writes the record to `--out` and a summary to
 * $GITHUB_STEP_SUMMARY (the output when unset). Exits 1 when the guard
 * refuses the plan, its domain changes or a held host, or when `--approved`
 * names a record this one differs from; 2 on bad arguments.
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
  const domainsFile = value("domains");
  if (
    log === undefined ||
    outFile === undefined ||
    domainsFile === undefined ||
    log.startsWith("--") ||
    outFile.startsWith("--") ||
    domainsFile.startsWith("--")
  ) {
    return usage("pass --log <alchemy log>, --out <record file> and --domains <live domains file>");
  }
  let text = "";
  try {
    text = readFileSync(log, "utf8");
  } catch {
    // An unreadable log holds no Plan line, which the guard refuses.
  }
  let live: unknown;
  try {
    live = JSON.parse(readFileSync(domainsFile, "utf8"));
  } catch {
    // An unreadable or malformed file names no site's hosts, which the guard refuses.
  }
  const holds = input.holds ?? PRODUCTION_HOST_HOLDS;
  const domains = domainChanges({ declared: input.declared, live });
  const plan = parsePlan(text);
  const refusals = [
    ...guardPlan({ plan, kinds: input.kinds, adoptions: input.adoptions }),
    ...domains.problems,
    ...domainRefusals(domains.changes, holds),
    ...holdRefusals(input.declared, holds),
    ...(args.includes("--scheduled") ? addedHostRefusals(domains.changes) : []),
  ];
  const record = planRecord({
    stack: input.stack,
    plan,
    kinds: input.kinds,
    domains: domains.changes,
  });
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, record);
  const summary = renderGuardSummary({
    stack: input.stack,
    plan,
    kinds: input.kinds,
    refusals,
    domains: domains.changes,
    held: declaredSites(input.declared).flatMap((site) => heldHost(site, holds) ?? []),
  });
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
