import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import * as BunServices from "@effect/platform-bun/BunServices";
import { LoggingCli } from "alchemy/Cli/LoggingCli";
import type { ResourceStatusChanged as ApplyEvent } from "alchemy/Events";
import type { Plan } from "alchemy/Plan";
import { Cli } from "alchemy/Report";
import { prettyLine } from "alchemy/Util/ConsoleSink";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import { describe, expect, test } from "vitest";

import {
  addedHostRefusals,
  type DeclaredDomains,
  declaredDomains,
  domainRefusals,
  guardPlan,
  holdRefusals,
  messageOf,
  parsePlan,
  planRecord,
  planTextFaults,
  productionSiteKinds,
  renderGuardSummary,
  runPlanGuardCli,
  type ResourceKind,
} from "../src/plan-guard";
import type { AdoptedResources, LiveState } from "../src/production-live";
import type { HostHold } from "../src/production-sites";

/** Each line as Alchemy's console prints a record, with colour (alchemy src/Util/ConsoleSink.ts). */
const pretty = (...lines: string[]) =>
  lines
    .map((text, index) =>
      prettyLine({
        date: new Date(2026, 10, 6, 20, 17, index % 60, 123),
        level: "Info",
        text,
        colors: true,
      }),
    )
    .join("\n");

const KINDS: Readonly<Record<string, ResourceKind>> = {
  CireHost: "custom-domain",
  CireVendor: "custom-domain",
  CireApi: "worker",
  CireInvites: "api-worker",
  CireDb: "d1",
  CireAssets: "r2",
  CireRoute: "route",
};

const refusals = (
  log: string,
  extra: { existing?: ReadonlySet<string>; durableObjectBindings?: readonly string[] } = {},
) => guardPlan({ plan: parsePlan(log), kinds: KINDS, ...extra });

describe("parsePlan", () => {
  test("G10: reads the last Plan line and the tagged lines after it, through colour and Effect's prefix", () => {
    const log = [
      pretty("Plan: 1 to create"),
      pretty("[CireHost] create"),
      "some build output",
      pretty("Plan: 1 to update, 1 binding changes"),
      pretty("[CireApi] update", "[CireApi/DB] create", "[CireApi/ASSETS] noop", "[CireHost] noop"),
      pretty(""),
      pretty("[CireHost] updating"),
    ].join("\n");
    const plan = parsePlan(log);
    expect(plan).toEqual({
      plan: "changes",
      counts: { update: 1, "binding changes": 1 },
      resources: [
        { fqn: "CireApi", action: "update" },
        { fqn: "CireHost", action: "noop" },
      ],
      bindings: [
        { fqn: "CireApi/DB", action: "create" },
        { fqn: "CireApi/ASSETS", action: "noop" },
      ],
      problems: [],
    });
    expect(guardPlan({ plan, kinds: KINDS })).toEqual([]);
  });

  test("G10: a namespaced resource, unbind, `no changes` and `no resources`", () => {
    const namespaced = parsePlan(
      pretty(
        "Plan: 1 to update, 1 binding changes",
        "[Sites/CireHost] update",
        "[Sites/CireHost/ASSETS] unbind",
      ),
    );
    expect(namespaced.resources).toEqual([{ fqn: "Sites/CireHost", action: "update" }]);
    expect(namespaced.bindings).toEqual([{ fqn: "Sites/CireHost/ASSETS", action: "unbind" }]);
    expect(namespaced.problems).toEqual([]);

    const unchanged = parsePlan(pretty("Plan: no changes", "[CireHost] noop", "[CireVendor] noop"));
    expect(unchanged.plan).toBe("no-changes");
    expect(guardPlan({ plan: unchanged, kinds: KINDS })).toEqual([]);
    const empty = parsePlan(pretty("Plan: no resources"));
    expect(empty).toMatchObject({ plan: "no-resources", resources: [], bindings: [] });
    expect(guardPlan({ plan: empty, kinds: KINDS })).toEqual([]);
  });
});

/*
 * Alchemy's own output, so the guard is held to what Alchemy prints rather
 * than to a reading of its source. The two fixtures are the `bun run
 * deploy:dev` output of a dev stack job (deploy.yml tees it to the public run
 * log): cire from run 40524474810 (2026-10-27), musubi from run 40317410716
 * (2026-10-26), Alchemy 2.0.0-beta.83, each from the command line to `Done:`,
 * with GitHub's per-line prefix taken off. The stack outputs printed after
 * `Done:` are left out: they name dev hosts. `deploy --yes` prints the plan,
 * a blank record and the apply; the production plan (`deploy --dry-run`)
 * prints the same plan lines and stops (alchemy src/Cli/LoggingCli.ts
 * `displayPlan`, `startApplySession`).
 */
describe("parsePlan reads what Alchemy prints", () => {
  const fixture = (name: string) =>
    readFileSync(fileURLToPath(new URL(`fixtures/${name}`, import.meta.url)), "utf8");
  /** Every resource in the plan as a kind, so only the text itself can be refused. */
  const anyKinds = (plan: ReturnType<typeof parsePlan>) =>
    Object.fromEntries(plan.resources.map((resource) => [resource.fqn, "worker" as const]));

  test.each([
    {
      file: "alchemy-dev-cire.log",
      plan: "changes",
      counts: { update: 2 },
      resources: [
        ["CireApi", "noop"],
        ["CireAssets", "noop"],
        ["CireDb", "noop"],
        ["CireHost", "update"],
        ["CireInvites", "update"],
        ["CireLanding", "noop"],
        ["CireSheets", "noop"],
        ["CireVendor", "noop"],
      ],
      owner: "CireApi",
      bindings: 27,
    },
    {
      file: "alchemy-dev-musubi.log",
      plan: "no-changes",
      counts: {},
      resources: [
        ["MusubiLanding", "noop"],
        ["MusubiSocial", "noop"],
        ["OsnApi", "noop"],
        ["OsnDb", "noop"],
      ],
      owner: "OsnApi",
      bindings: 28,
    },
  ])(
    "G15: a real dev deploy log, $file, reads with no fault, up to the blank record before the apply",
    (expected) => {
      const plan = parsePlan(fixture(expected.file));
      expect(plan.plan).toBe(expected.plan);
      expect(plan.counts).toEqual(expected.counts);
      expect(plan.problems).toEqual([]);
      expect(plan.resources.map((resource) => [resource.fqn, resource.action])).toEqual(
        expected.resources,
      );
      expect(plan.bindings).toHaveLength(expected.bindings);
      for (const binding of plan.bindings) {
        expect(binding.fqn.startsWith(`${expected.owner}/`)).toBe(true);
        expect(binding.action).toBe("noop");
      }
      expect(planTextFaults(plan)).toEqual([]);
      expect(guardPlan({ plan, kinds: anyKinds(plan) })).toEqual([]);
    },
  );

  /** One resource row of a plan, as Alchemy's planner hands it to the CLI. */
  interface Row {
    readonly fqn: string;
    readonly action: string;
    readonly mode?: "live" | "local";
    readonly renamedFrom?: readonly string[];
    readonly bindings?: readonly (readonly [string, string])[];
  }
  /** A plan holding the fields `formatPlanLines` reads, and nothing else. */
  function planOf(input: {
    readonly resources?: readonly Row[];
    readonly deletions?: readonly Row[];
    readonly tasks?: readonly (readonly [string, "run" | "delete"])[];
  }): Plan {
    const item = (row: Row) => [
      row.fqn,
      {
        action: row.action,
        resource: { LogicalId: row.fqn.split("/").at(-1), FQN: row.fqn },
        mode: row.mode ?? "live",
        state: { providerMode: row.mode ?? "live" },
        renamedFrom: row.renamedFrom,
        bindings: (row.bindings ?? []).map(([sid, action]) => ({ sid, action })),
      },
    ];
    const plan = {
      resources: Object.fromEntries((input.resources ?? []).map(item)),
      deletions: Object.fromEntries((input.deletions ?? []).map(item)),
      actions: Object.fromEntries(
        (input.tasks ?? []).map(([fqn, action]) => [
          fqn,
          { action, def: { LogicalId: fqn, FQN: fqn } },
        ]),
      ),
      actionDeletions: {},
    };
    return plan as unknown as Plan;
  }
  /**
   * The plan as the production plan step logs it: the installed Alchemy's
   * own CLI service displays it, as `deploy --dry-run` does (alchemy
   * src/Cli/commands/deploy.ts), and its console lines are kept.
   */
  async function printed(plan: Plan): Promise<string> {
    const lines: string[] = [];
    const console = {
      ...globalThis.console,
      log: (...args: unknown[]) => void lines.push(args.map(String).join(" ")),
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const cli = yield* Cli;
        yield* cli.displayPlan(plan, {});
      }).pipe(
        Effect.provide(LoggingCli),
        Effect.provide(BunServices.layer),
        Effect.provideService(Console.Console, console),
      ),
    );
    return lines.join("\n");
  }
  /**
   * The plan and its progress lines as a deploy that applies logs them, the
   * log `plan-summary` reads on dev: the installed Alchemy's CLI service
   * starts its apply session (alchemy src/Cli/LoggingCli.ts
   * `startApplySession`), and each resource reports its statuses.
   */
  async function applied(
    plan: Plan,
    statuses: readonly (readonly [fqn: string, status: ApplyEvent["status"]])[],
  ): Promise<string> {
    const lines: string[] = [];
    const console = {
      ...globalThis.console,
      log: (...args: unknown[]) => void lines.push(args.map(String).join(" ")),
    };
    await Effect.runPromise(
      Effect.gen(function* () {
        const cli = yield* Cli;
        const session = yield* cli.startApplySession(plan, {});
        for (const [fqn, status] of statuses) {
          yield* session.emit({
            type: "apply.resource.status",
            fqn,
            id: fqn,
            resourceType: "Cloudflare.Worker",
            status,
            providerMode: "live",
          });
        }
      }).pipe(
        Effect.provide(LoggingCli),
        Effect.provide(BunServices.layer),
        Effect.provideService(Console.Console, console),
      ),
    );
    return lines.join("\n");
  }

  test("G19: a deploy's progress lines after its plan, tagged as plan lines are, are not read as part of the plan", async () => {
    const log = await applied(
      planOf({
        resources: [
          { fqn: "CireHost", action: "update" },
          { fqn: "CireVendor", action: "noop" },
        ],
      }),
      [
        ["CireHost", "updating"],
        ["CireHost", "updated"],
      ],
    );
    expect(log).toContain("[CireHost] updating");
    const plan = parsePlan(log);
    expect(plan).toMatchObject({ plan: "changes", counts: { update: 1 }, problems: [] });
    expect(plan.resources).toEqual([
      { fqn: "CireHost", action: "update" },
      { fqn: "CireVendor", action: "noop" },
    ]);
    expect(planTextFaults(plan)).toEqual([]);
  });

  test("G16: Alchemy's console prefix, at each level and with colour or none, is removed and nothing else", () => {
    for (const level of ["Trace", "Debug", "Info", "Warn", "Error", "Fatal"] as const) {
      for (const colors of [true, false]) {
        const line = prettyLine({ date: new Date(), level, text: "Plan: 1 to update", colors });
        expect({ level, colors, message: messageOf(line) }).toEqual({
          level,
          colors,
          message: "Plan: 1 to update",
        });
      }
    }
    // A record about one resource carries its tag, which a plan line never does.
    expect(
      messageOf(
        prettyLine({
          date: new Date(),
          level: "Info",
          text: "updating",
          resource: "CireHost",
          colors: false,
        }),
      ),
    ).toBe("[CireHost] updating");
    // A line in another shape keeps its text, so its Plan line is not read.
    expect(parsePlan("INFO [20:17:00.123]: Plan: 1 to update\n").plan).toBe("missing");
  });

  test("G15: every resource action, binding action and note the installed Alchemy prints reads back as itself", async () => {
    const plan = parsePlan(
      await printed(
        planOf({
          resources: [
            { fqn: "CireVendor", action: "create" },
            {
              fqn: "Sites/CireHost",
              action: "update",
              bindings: [
                ["ASSETS", "noop"],
                ["DB", "create"],
                ["KV", "update"],
                ["OLD", "delete"],
              ],
            },
            { fqn: "CireLanding", action: "noop" },
            { fqn: "CireDb", action: "adopted" },
            { fqn: "CireApi", action: "replace" },
          ],
          deletions: [
            { fqn: "CireOld", action: "delete" },
            { fqn: "CireGone", action: "orphaned" },
          ],
        }),
      ),
    );
    expect(plan.plan).toBe("changes");
    expect(plan.counts).toEqual({
      create: 1,
      update: 1,
      adopted: 1,
      replace: 1,
      delete: 1,
      orphaned: 1,
      "binding changes": 3,
    });
    expect(plan.problems).toEqual([]);
    expect(
      plan.resources.map((resource) => `${resource.fqn} ${resource.action}`).toSorted(),
    ).toEqual(
      [
        "CireApi replace",
        "CireDb adopted",
        "CireGone orphaned",
        "CireLanding noop",
        "CireOld delete",
        "CireVendor create",
        "Sites/CireHost update",
      ].toSorted(),
    );
    expect(plan.bindings).toEqual([
      { fqn: "Sites/CireHost/ASSETS", action: "noop" },
      { fqn: "Sites/CireHost/DB", action: "create" },
      { fqn: "Sites/CireHost/KV", action: "update" },
      { fqn: "Sites/CireHost/OLD", action: "unbind" },
    ]);
    expect(planTextFaults(plan)).toEqual([]);

    const quiet = parsePlan(
      await printed(planOf({ resources: [{ fqn: "CireHost", action: "noop" }] })),
    );
    expect(quiet).toMatchObject({ plan: "no-changes", counts: {}, problems: [] });
    expect(parsePlan(await printed(planOf({})))).toMatchObject({
      plan: "no-resources",
      problems: [],
    });

    // What production never runs reads as a fault, not as a resource line.
    const refused = parsePlan(
      await printed(
        planOf({
          resources: [
            { fqn: "CireHost", action: "update", mode: "local" },
            { fqn: "CireVendor", action: "update", renamedFrom: ["Vendor"] },
          ],
          tasks: [["Seed", "run"]],
        }),
      ),
    );
    expect(refused.counts).toEqual({ update: 2, tasks: 1 });
    expect(refused.problems).toEqual([
      "CireHost does not run live; every production resource does",
      "CireVendor moved from another logical id; production ids never change",
      "Seed is a task; a production plan runs none",
    ]);
  });
});

describe("guardPlan refuses", () => {
  test("G1: a log with no Plan line", () => {
    expect(refusals("planning failed\n")).toEqual(["the Alchemy log holds no Plan line"]);
    expect(refusals("")).toEqual(["the Alchemy log holds no Plan line"]);
  });

  test("G2: a Plan line part it does not know", () => {
    expect(refusals(pretty("Plan: 1 to update, 2 to teleport", "[CireHost] update"))).toContain(
      "the Plan line holds a part the guard does not know",
    );
  });

  test("G3: lines that disagree with the Plan line's counts, as when a log line cuts the list", () => {
    const cut = pretty(
      "Plan: 2 to update",
      "[CireHost] update",
      "warning: slow",
      "[CireVendor] update",
    );
    expect(refusals(cut)).toEqual(["the plan lists 1 to update, and its Plan line counts 2"]);
    expect(
      refusals(pretty("Plan: 1 binding changes", "[CireApi] noop", "[CireApi/DB] noop")),
    ).toEqual(["the plan lists 0 binding changes, and its Plan line counts 1"]);
  });

  test("G4: a resource the stack does not declare on production, whatever its action, a noop included", () => {
    expect(refusals(pretty("Plan: 1 to create", "[ZapApi] create"))).toEqual([
      "ZapApi is not a resource this stack declares on production",
    ]);
    expect(refusals(pretty("Plan: no changes", "[ZapApi] noop"))).toEqual([
      "ZapApi is not a resource this stack declares on production",
    ]);
  });

  test("G5: replacing, deleting or orphaning a protected kind; a plain Worker may be replaced", () => {
    for (const fqn of ["CireHost", "CireInvites", "CireDb", "CireAssets", "CireRoute"]) {
      for (const action of ["replace", "delete", "orphaned"]) {
        const found = refusals(pretty(`Plan: 1 to ${action}`, `[${fqn}] ${action}`));
        expect({ fqn, action, refused: found.length }).toEqual({ fqn, action, refused: 1 });
        expect(found[0]).toMatch(new RegExp(`^${fqn} \\(`));
      }
    }
    for (const action of ["replace", "delete", "orphaned"]) {
      expect(refusals(pretty(`Plan: 1 to ${action}`, `[CireApi] ${action}`))).toEqual([]);
    }
  });

  test("GA1: an adoption of a site Worker or a plain Worker; an API Worker, a database or a bucket may be adopted", () => {
    for (const fqn of ["CireInvites", "CireDb", "CireAssets"]) {
      expect(refusals(pretty("Plan: 1 to adopted", `[${fqn}] adopted`))).toEqual([]);
    }
    expect(refusals(pretty("Plan: 1 to adopted", "[CireHost] adopted"))).toEqual([
      "CireHost (custom-domain) would be adopted; production adopts none of its kind",
    ]);
    expect(refusals(pretty("Plan: 1 to adopted", "[CireApi] adopted"))).toEqual([
      "CireApi (worker) would be adopted; production adopts none of its kind",
    ]);
  });

  test("GA2: a database or a bucket created: no live one has its name", () => {
    expect(refusals(pretty("Plan: 1 to create", "[CireDb] create"))).toEqual([
      "CireDb (d1) would be created: production adopts its storage, and no live database has its name",
    ]);
    expect(refusals(pretty("Plan: 1 to create", "[CireAssets] create"))).toEqual([
      "CireAssets (r2) would be created: production adopts its storage, and no live bucket has its name",
    ]);
  });

  test("GA3: an API Worker created is refused unless the live read found it, which the deploy then adopts", () => {
    const log = pretty("Plan: 1 to create", "[CireInvites] create");
    expect(refusals(log)).toEqual([
      "CireInvites (api-worker) would be created: production adopts its API Workers, and the live read found none of its name",
    ]);
    expect(refusals(log, { existing: new Set(["CireHost"]) })).toHaveLength(1);
    expect(refusals(log, { existing: new Set(["CireInvites"]) })).toEqual([]);
    // A site Worker may be created: a new site's first release.
    expect(refusals(pretty("Plan: 1 to create", "[CireHost] create"))).toEqual([]);
  });

  test("GA4: a Durable Object binding unbound; any other binding may be", () => {
    const log = pretty(
      "Plan: 1 to update, 2 binding changes",
      "[CireApi] update",
      "[CireApi/REALTIME_HUB] unbind",
      "[CireApi/OSN_ENV] unbind",
    );
    expect(refusals(log, { durableObjectBindings: ["CireApi/REALTIME_HUB"] })).toEqual([
      "CireApi/REALTIME_HUB would be unbound, and Cloudflare deletes a Durable Object class no binding names, with its storage",
    ]);
    expect(refusals(log)).toEqual([]);
  });

  test("G7: a task line", () => {
    expect(refusals(pretty("Plan: 1 tasks", "[Seed] run [action]"))).toEqual([
      "Seed is a task; a production plan runs none",
      "the plan runs tasks; a production plan runs none",
    ]);
  });

  test("G8: an action word it does not know", () => {
    expect(refusals(pretty("Plan: no changes", "[CireHost] vaporise"))).toEqual([
      "CireHost has an action the guard does not know",
    ]);
  });

  test("G9: a resource not running live, or moved from another logical id", () => {
    expect(refusals(pretty("Plan: 1 to update", "[CireHost] update (local)"))).toEqual([
      "CireHost does not run live; every production resource does",
    ]);
    expect(refusals(pretty("Plan: 1 to update", "[CireHost] update (remote)"))).toHaveLength(1);
    expect(refusals(pretty("Plan: 1 to update", "[CireHost] update (renamed from Host)"))).toEqual([
      "CireHost moved from another logical id; production ids never change",
    ]);
    // A binding line carries no note; one that does is not read as a binding.
    expect(
      refusals(
        pretty(
          "Plan: 1 to update, 1 binding changes",
          "[CireApi] update",
          "[CireApi/DB] create (local)",
        ),
      ),
    ).toEqual([
      "CireApi/DB has a binding action the guard does not know",
      "the plan lists 0 binding changes, and its Plan line counts 1",
    ]);
  });
});

describe("the guard's record and summary", () => {
  test("G13: the record holds names, kinds, actions and counts only, sorted, the same every run", () => {
    const log = pretty("Plan: 1 to update", "[CireVendor] update", "[CireHost] noop");
    const record = planRecord({ stack: "cire", plan: parsePlan(log), kinds: KINDS });
    expect(record).toBe(planRecord({ stack: "cire", plan: parsePlan(log), kinds: KINDS }));
    expect(JSON.parse(record)).toEqual({
      stack: "cire",
      plan: "changes",
      counts: { update: 1 },
      resources: [
        { fqn: "CireHost", kind: "custom-domain", action: "noop" },
        { fqn: "CireVendor", kind: "custom-domain", action: "update" },
      ],
      bindings: [],
      domains: [],
    });
    expect(record).not.toContain("INFO");
    expect(record).not.toContain("20:17");
    const summary = renderGuardSummary({
      stack: "cire",
      plan: parsePlan(log),
      kinds: KINDS,
      refusals: [],
    });
    expect(summary).toContain("### cire production plan: 1 to update");
    expect(summary).toContain("| `CireVendor` | custom-domain | update |");
    expect(summary).not.toContain("INFO");
  });

  test("a stack's site kinds: every worker site is a Worker holding a domain", () => {
    expect(
      productionSiteKinds(
        { cire_host: "CireHost", cire_vendor: "CireVendor", cire_landing: "CireLanding" },
        {
          cire_host: "worker",
          cire_vendor: "worker",
          cire_landing: "off",
          osn_social: "worker",
          musubi_landing: "worker",
          pulse_landing: "off",
        },
      ),
    ).toEqual({ CireHost: "custom-domain", CireVendor: "custom-domain" });
  });

  test("the domains a stack's guard reads are the ones its declaration gives each site's Worker", () => {
    expect(
      declaredDomains(
        { cire_host: "CireHost", cire_vendor: "CireVendor", cire_landing: "CireLanding" },
        {
          CireHost: { domain: "host.cireweddings.com" },
          CireVendor: { domain: null },
        },
      ),
    ).toEqual({ cire_host: "host.cireweddings.com", cire_vendor: null });
  });
});

/** A hold on cire vendor's host, as an entry in PRODUCTION_HOST_HOLDS reads. */
const VENDOR_HELD: readonly HostHold[] = [
  {
    site: "cire_vendor",
    host: "vendor.cireweddings.com",
    reason: "Serves nothing until the vendor export ships.",
  },
];

/** What the guard says when a site Worker would serve a held host. */
const holdRefusal = (site: string, host: string, reason: string) =>
  `${site}'s Worker would serve ${host}, which PRODUCTION_HOST_HOLDS in shared/infra/src/production-sites.ts holds off every Worker (${reason}); a release serves it again only once a pull request removes its entry`;

/** What the guard says when a Worker would give up a host. */
const removalRefusal = (site: string, host: string) =>
  `${site}'s Worker would give up ${host}; no release takes a production host off its Worker: remove it in the Cloudflare dashboard first`;

/** What the guard says when a scheduled release would add a host. */
const scheduledAddRefusal = (site: string, host: string) =>
  `${site}'s Worker would gain ${host}, and a scheduled release adds no host: dispatch Production release by hand to add it`;

/** What the guard says when a Worker would give up a held host. */
const heldRemovalRefusal = (site: string, host: string) =>
  `${site}'s Worker would give up ${host}, which PRODUCTION_HOST_HOLDS in shared/infra/src/production-sites.ts holds off; no release takes a production host off its Worker: remove it in the Cloudflare dashboard first`;

/** A stack that adopts nothing, and the live read of it. */
const NO_ADOPTIONS: AdoptedResources = { workers: {}, databases: {}, buckets: {} };
const NOTHING_LIVE: LiveState = { workers: {}, databases: {}, buckets: {} };

describe("runPlanGuardCli", () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-guard-"));
  const domainsFile = join(dir, "domains.json");
  const liveFile = join(dir, "live.json");
  writeFileSync(liveFile, JSON.stringify(NOTHING_LIVE));
  /** The host each of the stack's two site Workers is declared with: its production host. */
  const DECLARED: DeclaredDomains = {
    cire_host: "host.cireweddings.com",
    cire_vendor: "vendor.cireweddings.com",
  };
  /** The hosts each site Worker holds while nothing moves: its production host. */
  const LIVE = {
    cire_host: ["host.cireweddings.com"],
    cire_vendor: ["vendor.cireweddings.com"],
  };
  const run = (
    argv: string[],
    log?: string,
    live: unknown = LIVE,
    declared: DeclaredDomains = DECLARED,
    holds: readonly HostHold[] = [],
  ) => {
    if (log !== undefined) writeFileSync(join(dir, "plan.log"), log);
    writeFileSync(domainsFile, typeof live === "string" ? live : JSON.stringify(live));
    const out: string[] = [];
    const code = runPlanGuardCli({
      stack: "cire",
      kinds: KINDS,
      declared,
      adopted: NO_ADOPTIONS,
      argv,
      env: {},
      out: (text) => out.push(text),
      holds,
    });
    return { code, out: out.join("") };
  };
  const logArgs = [
    "--log",
    join(dir, "plan.log"),
    "--out",
    join(dir, "record.json"),
    "--domains",
    domainsFile,
    "--live",
    liveFile,
  ];

  test("G12: a re-plan that differs from the approved record is refused; an equal one passes", () => {
    const approved = join(dir, "approved.json");
    expect(run(logArgs, pretty("Plan: 1 to update", "[CireHost] update")).code).toBe(0);
    writeFileSync(approved, readFileSync(join(dir, "record.json")));
    expect(run([...logArgs, "--approved", approved]).code).toBe(0);
    const changed = run(
      [...logArgs, "--approved", approved],
      pretty("Plan: 1 to update", "[CireVendor] update"),
    );
    expect(changed.code).toBe(1);
    expect(changed.out).toContain("not the one approved");
    expect(run([...logArgs, "--approved", join(dir, "missing.json")]).code).toBe(1);
  });

  test("G12: a refused plan exits 1, naming each reason, and still writes its record", () => {
    const refused = run(logArgs, pretty("Plan: 1 to delete", "[CireDb] delete"));
    expect(refused.code).toBe(1);
    expect(refused.out).toContain(
      "::error::cire production plan refused: CireDb (d1) would be deleted",
    );
    expect(JSON.parse(readFileSync(join(dir, "record.json"), "utf8"))).toMatchObject({
      resources: [{ fqn: "CireDb", kind: "d1", action: "delete" }],
    });
  });

  test("G14: missing arguments exit 2", () => {
    expect(run(["--log", join(dir, "plan.log")]).code).toBe(2);
    // --live is required: every production stack adopts something.
    expect(run(logArgs.slice(0, -2), pretty("Plan: no changes", "[CireHost] noop")).code).toBe(2);
  });

  test("GL0: an unreadable or malformed live file refuses", () => {
    for (const content of ["not json", "[]", "{}"]) {
      writeFileSync(liveFile, content);
      const result = run(logArgs, pretty("Plan: no changes", "[CireHost] noop"));
      expect({ content, code: result.code }).toEqual({ content, code: 1 });
      expect(result.out).toContain("the live state of the adopted resources was not read");
    }
    writeFileSync(liveFile, JSON.stringify(NOTHING_LIVE));
  });

  const UPDATE = pretty("Plan: 1 to update", "[CireVendor] update", "[CireHost] noop");
  const record = () => JSON.parse(readFileSync(join(dir, "record.json"), "utf8")) as unknown;

  test("GD1: no --domains is a usage error; an unreadable, malformed or partial file refuses", () => {
    const bare = ["--log", join(dir, "plan.log"), "--out", join(dir, "record.json")];
    expect(run(bare, UPDATE).code).toBe(2);
    expect(run([...bare, "--domains"], UPDATE).code).toBe(2);
    const missing = run(
      [...bare, "--domains", join(dir, "nowhere.json"), "--live", liveFile],
      UPDATE,
    );
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("the hosts cire_host's Worker holds now were not read");
    for (const live of [
      "not json",
      "[]",
      { ...LIVE, cire_host: "host.cireweddings.com" },
      { ...LIVE, cire_host: [1] },
    ]) {
      const result = run(logArgs, UPDATE, live);
      expect({ live, code: result.code }).toEqual({ live, code: 1 });
      expect(result.out).toContain("cire_host's Worker holds now were not read");
    }
  });

  test("GD5: a site of the stack missing from the file refuses", () => {
    const result = run(logArgs, UPDATE, { cire_host: LIVE.cire_host });
    expect(result.code).toBe(1);
    expect(result.out).toContain("the hosts cire_vendor's Worker holds now were not read");
  });

  test("GD2: the record and the summary name each site's added and removed hosts, the same every run; a host coming back is allowed", () => {
    // A first attach, or a host back once its hold is removed: the Worker
    // holds nothing and takes its production host.
    const fresh = { ...LIVE, cire_vendor: [] };
    const attached = run(logArgs, UPDATE, fresh);
    expect(attached.code).toBe(0);
    const first = readFileSync(join(dir, "record.json"), "utf8");
    expect(record()).toEqual(
      expect.objectContaining({
        domains: [{ surface: "cire_vendor", added: ["vendor.cireweddings.com"], removed: [] }],
      }),
    );
    expect(Object.keys(record() as object)).not.toContain("flip");
    expect(Object.keys(record() as object)).not.toContain("unflip");
    expect(attached.out).toContain("| `cire_vendor` | `vendor.cireweddings.com` | — |");
    expect(attached.out).toContain("The guard allows this plan.");
    run(logArgs, UPDATE, fresh);
    expect(readFileSync(join(dir, "record.json"), "utf8")).toBe(first);
    const quiet = run(logArgs, UPDATE);
    expect(quiet.code).toBe(0);
    expect(quiet.out).toContain("No Worker's custom domains change.");
    expect(quiet.out).not.toContain("Held off");
  });

  test("GD3: a Worker giving up its production host, or a host the code no longer names, refuses in every release; an unknown flag lets nothing through", () => {
    const declared = { ...DECLARED, cire_vendor: null };
    const refused = run(logArgs, UPDATE, LIVE, declared);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain(removalRefusal("cire_vendor", "vendor.cireweddings.com"));
    const flagged = run([...logArgs, "--unflip", "cire_vendor"], UPDATE, LIVE, declared);
    expect(flagged.code).toBe(1);
    expect(flagged.out).toContain(removalRefusal("cire_vendor", "vendor.cireweddings.com"));
    // Once the dashboard has taken the host off, the Worker gives up nothing.
    expect(run(logArgs, UPDATE, { ...LIVE, cire_vendor: [] }, declared).code).toBe(0);
    // A host the code no longer names refuses too.
    const old = run(logArgs, UPDATE, {
      ...LIVE,
      cire_vendor: ["old.cireweddings.com", "vendor.cireweddings.com"],
    });
    expect(old.code).toBe(1);
    expect(old.out).toContain(removalRefusal("cire_vendor", "old.cireweddings.com"));
  });

  test("GD4: a re-plan whose domain change differs from the approved one is refused", () => {
    const approved = join(dir, "approved-domains.json");
    expect(run(logArgs, UPDATE).code).toBe(0);
    writeFileSync(approved, readFileSync(join(dir, "record.json")));
    expect(run([...logArgs, "--approved", approved], UPDATE).code).toBe(0);
    const changed = run([...logArgs, "--approved", approved], UPDATE, {
      ...LIVE,
      cire_host: [],
    });
    expect(changed.code).toBe(1);
    expect(changed.out).toContain("not the one approved");
  });

  test("H1: a plan whose site Worker would take a held host is refused, naming the host, the list, its file and the reason, and still writes its record", () => {
    const result = run(logArgs, UPDATE, { ...LIVE, cire_vendor: [] }, DECLARED, VENDOR_HELD);
    expect(result.code).toBe(1);
    expect(result.out).toContain(
      `::error::cire production plan refused: ${holdRefusal("cire_vendor", "vendor.cireweddings.com", "Serves nothing until the vendor export ships.")}`,
    );
    expect(record()).toMatchObject({
      domains: [{ surface: "cire_vendor", added: ["vendor.cireweddings.com"], removed: [] }],
    });
  });

  test("H1b: a held host its site Worker still serves and is declared with is refused, though nothing changes", () => {
    const result = run(logArgs, UPDATE, LIVE, DECLARED, VENDOR_HELD);
    expect(result.code).toBe(1);
    expect(result.out).toContain(
      holdRefusal(
        "cire_vendor",
        "vendor.cireweddings.com",
        "Serves nothing until the vendor export ships.",
      ),
    );
    expect(result.out).toContain("No Worker's custom domains change.");
  });

  test("H3: a held site whose host is already off its Worker plans no change and passes; the summary names the held host and the list's file", () => {
    const declared = { ...DECLARED, cire_vendor: null };
    const result = run(logArgs, UPDATE, { ...LIVE, cire_vendor: [] }, declared, VENDOR_HELD);
    expect(result.code).toBe(0);
    expect(result.out).toContain("No Worker's custom domains change.");
    expect(result.out).toContain(
      "Held off their Workers by `PRODUCTION_HOST_HOLDS` (`shared/infra/src/production-sites.ts`):\n- `vendor.cireweddings.com` (`cire_vendor`): Serves nothing until the vendor export ships.",
    );
    expect(result.out).toContain("The guard allows this plan.");
  });

  test("H4: a held host still on its Worker refuses, sending it to the dashboard first", () => {
    const declared = { ...DECLARED, cire_vendor: null };
    const result = run(logArgs, UPDATE, LIVE, declared, VENDOR_HELD);
    expect(result.code).toBe(1);
    expect(result.out).toContain(heldRemovalRefusal("cire_vendor", "vendor.cireweddings.com"));
  });

  test("GS1: a scheduled release's plan that adds a host is refused, naming the host and sending it to a release dispatched by hand", () => {
    const result = run([...logArgs, "--scheduled"], UPDATE, { ...LIVE, cire_vendor: [] });
    expect(result.code).toBe(1);
    expect(result.out).toContain(
      `::error::cire production plan refused: ${scheduledAddRefusal("cire_vendor", "vendor.cireweddings.com")}`,
    );
    // Its record is still written, as for any refusal.
    expect(record()).toMatchObject({
      domains: [{ surface: "cire_vendor", added: ["vendor.cireweddings.com"], removed: [] }],
    });
  });

  test("GS2: a release dispatched by hand may add a host", () => {
    const result = run(logArgs, UPDATE, { ...LIVE, cire_vendor: [] });
    expect(result.code).toBe(0);
    expect(result.out).not.toContain("scheduled release");
  });

  test("GS3: a scheduled release with no domain change passes", () => {
    const result = run([...logArgs, "--scheduled"], UPDATE);
    expect(result.code).toBe(0);
    expect(result.out).toContain("No Worker's custom domains change.");
  });
});

describe("addedHostRefusals", () => {
  test("GS4: refuses each host each Worker would gain, and nothing a Worker gives up", () => {
    expect(
      addedHostRefusals([
        { surface: "cire_host", added: ["host.cireweddings.com"], removed: [] },
        { surface: "cire_landing", added: [], removed: ["old.cireweddings.com"] },
      ]),
    ).toEqual([scheduledAddRefusal("cire_host", "host.cireweddings.com")]);
    expect(addedHostRefusals([])).toEqual([]);
  });
});

describe("holdRefusals", () => {
  test("H2: refuses each site Worker declared with a held host, whichever site holds it, and nothing else", () => {
    expect(holdRefusals({ cire_host: "vendor.cireweddings.com" }, VENDOR_HELD)).toEqual([
      holdRefusal(
        "cire_host",
        "vendor.cireweddings.com",
        "Serves nothing until the vendor export ships.",
      ),
    ]);
    expect(
      holdRefusals(
        { cire_host: "host.cireweddings.com", cire_vendor: null, cire_landing: "cireweddings.com" },
        VENDOR_HELD,
      ),
    ).toEqual([]);
    expect(holdRefusals({ cire_vendor: "vendor.cireweddings.com" }, [])).toEqual([]);
  });
});

describe("domainRefusals", () => {
  test("GD8: a Worker giving up any host refuses: its production host, another site's, or one the code no longer names", () => {
    const removed = ["cireweddings.com", "host.cireweddings.com", "old.cireweddings.com"];
    expect(domainRefusals([{ surface: "cire_landing", added: [], removed }], [])).toEqual(
      removed.map((host) => removalRefusal("cire_landing", host)),
    );
    expect(
      domainRefusals([{ surface: "cire_landing", added: ["cireweddings.com"], removed: [] }], []),
    ).toEqual([]);
  });

  test("H4: giving up a held host names the hold, and still refuses", () => {
    expect(
      domainRefusals(
        [{ surface: "cire_vendor", added: [], removed: ["vendor.cireweddings.com"] }],
        VENDOR_HELD,
      ),
    ).toEqual([heldRemovalRefusal("cire_vendor", "vendor.cireweddings.com")]);
  });
});
