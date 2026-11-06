import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { formatPlanLines } from "alchemy/Cli/LoggingCli";
import type { Plan } from "alchemy/Plan";
import { describe, expect, test } from "vitest";

import {
  domainChanges,
  type DomainChange,
  type DomainReading,
  domainRefusals,
  guardPlan,
  messageOf,
  parsePlan,
  planRecord,
  planTextFaults,
  productionSiteKinds,
  renderGuardSummary,
  runPlanGuardCli,
  type ResourceKind,
} from "../src/plan-guard";
import { PRODUCTION_SITE_MODES, type SiteMode, type SiteSurface } from "../src/production-sites";

const ESC = String.fromCharCode(27);

/** Each line as Effect's pretty console logger prints it in CI, with colour. */
const pretty = (...lines: string[]) =>
  lines
    .map(
      (line, index) =>
        `${ESC}[2m[20:17:0${index % 10}.123]${ESC}[0m INFO (#12): ${ESC}[36m${line}${ESC}[0m`,
    )
    .join("\n");

const KINDS: Readonly<Record<string, ResourceKind>> = {
  CireHost: "custom-domain",
  CireVendor: "custom-domain",
  CireApi: "worker",
  CireDb: "d1",
  CireAssets: "r2",
  CireRoute: "route",
};

const refusals = (log: string, extra: { adoptions?: string[]; flip?: string } = {}) =>
  guardPlan({ plan: parsePlan(log), kinds: KINDS, ...extra });

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

  test("G10: a logfmt record, a namespaced resource, unbind, `no changes` and `no resources`", () => {
    expect(
      messageOf('timestamp=2026-10-27T20:17:00Z level=INFO fiber=#3 message="[CireHost] update"'),
    ).toBe("[CireHost] update");
    const namespaced = parsePlan(
      [
        'level=INFO message="Plan: 1 to update, 1 binding changes"',
        'level=INFO message="[Sites/CireHost] update"',
        'level=INFO message="[Sites/CireHost/ASSETS] unbind"',
      ].join("\n"),
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
  /** The plan as the production plan step logs it: each line one record, nothing after. */
  const printed = (plan: Plan) => pretty(...formatPlanLines(plan));

  test("G15: every resource action, binding action and note the installed Alchemy prints reads back as itself", () => {
    const plan = parsePlan(
      printed(
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

    const quiet = parsePlan(printed(planOf({ resources: [{ fqn: "CireHost", action: "noop" }] })));
    expect(quiet).toMatchObject({ plan: "no-changes", counts: {}, problems: [] });
    expect(parsePlan(printed(planOf({})))).toMatchObject({ plan: "no-resources", problems: [] });

    // What production never runs reads as a fault, not as a resource line.
    const refused = parsePlan(
      printed(
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
    for (const fqn of ["CireHost", "CireDb", "CireAssets", "CireRoute"]) {
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

  test("G6: an adoption while PRODUCTION_ADOPTIONS is empty", () => {
    const log = pretty("Plan: 1 to adopted", "[CireDb] adopted");
    expect(refusals(log)).toEqual(["CireDb would be adopted, and PRODUCTION_ADOPTIONS is empty"]);
    expect(refusals(log, { adoptions: ["cire-db"] })).toEqual([]);
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

  test("G11: in a flip release told nothing of the stack's sites, anything but the flip's own update, and the update itself, since nothing shows it attaches a host", () => {
    const flip = "CireVendor";
    const unproven =
      "a flip release must attach CireVendor's production host, and no site names it";
    const one = pretty("Plan: 1 to update", "[CireHost] noop", "[CireVendor] update");
    expect(refusals(one, { flip })).toEqual([unproven]);
    expect(
      refusals(pretty("Plan: no changes", "[CireHost] noop", "[CireVendor] noop"), { flip }),
    ).toEqual(["a flip release must update CireVendor", unproven]);
    expect(
      refusals(pretty("Plan: 2 to update", "[CireHost] update", "[CireVendor] update"), { flip }),
    ).toEqual([unproven, "a flip release changes only CireVendor, and CireHost would update"]);
    expect(
      refusals(
        pretty(
          "Plan: 1 to update, 1 binding changes",
          "[CireVendor] update",
          "[CireVendor/X] create",
        ),
        { flip },
      ),
    ).toEqual([unproven, "a flip release changes no binding"]);
  });
});

describe("FG: a flip release beside its stack's other site Workers", () => {
  const SITES = {
    cire_host: "CireHost",
    cire_vendor: "CireVendor",
    cire_landing: "CireLanding",
  } as const;
  const SITE_KINDS: Readonly<Record<string, ResourceKind>> = {
    CireHost: "custom-domain",
    CireVendor: "custom-domain",
    CireLanding: "custom-domain",
    CireApi: "worker",
  };
  /**
   * Release 42140585413's cire plan, its `alchemy-plan` artifact `cire.json`:
   * each site's build bakes the release commit, so every site Worker updates.
   */
  const RELEASE = [
    "Plan: 3 to update",
    "[CireHost] update",
    "[CireLanding] update",
    "[CireVendor] update",
  ];
  /** What a flip of cire_vendor changes: its Worker leaves its spare host for its production host. */
  const VENDOR_MOVES: DomainChange = {
    site: "cire_vendor",
    added: ["vendor.cireweddings.com"],
    removed: ["next.vendor.cireweddings.com"],
  };
  const ALL_READ: readonly SiteSurface[] = ["cire_host", "cire_landing", "cire_vendor"];
  const reading = (
    changes: readonly DomainChange[] = [VENDOR_MOVES],
    read: readonly SiteSurface[] = ALL_READ,
  ): DomainReading => ({ changes, problems: [], read });
  const flipped = (
    lines: readonly string[],
    domains: DomainReading | null = reading(),
    extra: { adoptions?: string[] } = {},
  ) =>
    guardPlan({
      plan: parsePlan(pretty(...lines)),
      kinds: SITE_KINDS,
      flip: "CireVendor",
      sites: SITES,
      ...(domains === null ? {} : { domains }),
      ...extra,
    });

  test("FG1: allows release 42140585413's shape: the flip site and the stack's other site Workers update, only the flip site's domains change", () => {
    expect(flipped(RELEASE)).toEqual([]);
    expect(
      flipped([
        "Plan: 1 to update",
        "[CireHost] noop",
        "[CireLanding] noop",
        "[CireVendor] update",
      ]),
    ).toEqual([]);
  });

  test("FG2: refuses another site Worker whose custom domains change, an update or a noop, gaining or giving up a host", () => {
    const gains: DomainChange = {
      site: "cire_host",
      added: ["next.host.cireweddings.com"],
      removed: [],
    };
    const leaves: DomainChange = {
      site: "cire_landing",
      added: [],
      removed: ["old.cireweddings.com"],
    };
    expect(flipped(RELEASE, reading([VENDOR_MOVES, gains]))).toEqual([
      "a flip release moves only CireVendor's domain, and cire_host's Worker would gain next.host.cireweddings.com and give up nothing",
    ]);
    expect(flipped(RELEASE, reading([VENDOR_MOVES, leaves]))).toEqual([
      "a flip release moves only CireVendor's domain, and cire_landing's Worker would gain nothing and give up old.cireweddings.com",
    ]);
    // A noop Worker whose live hosts differ from the declared one, as a domain
    // changed in the dashboard leaves it.
    expect(
      flipped(
        ["Plan: 1 to update", "[CireHost] noop", "[CireLanding] noop", "[CireVendor] update"],
        reading([VENDOR_MOVES, gains]),
      ),
    ).toEqual([
      "a flip release moves only CireVendor's domain, and cire_host's Worker would gain next.host.cireweddings.com and give up nothing",
    ]);
  });

  test("FG3: refuses another site Worker's update when its custom domains were not read, or when no reading was passed", () => {
    expect(flipped(RELEASE, reading([VENDOR_MOVES], ["cire_landing", "cire_vendor"]))).toEqual([
      "a flip release updates CireHost beside CireVendor only when cire_host's custom domains were read",
    ]);
    // The same Worker unread but unchanged in the plan: nothing to allow.
    expect(
      flipped(
        ["Plan: 2 to update", "[CireHost] noop", "[CireLanding] update", "[CireVendor] update"],
        reading([VENDOR_MOVES], ["cire_landing", "cire_vendor"]),
      ),
    ).toEqual([]);
    expect(flipped(RELEASE, null)).toEqual([
      "a flip release must attach vendor.cireweddings.com to CireVendor",
      "a flip release updates CireHost beside CireVendor only when cire_host's custom domains were read",
      "a flip release updates CireLanding beside CireVendor only when cire_landing's custom domains were read",
    ]);
  });

  test("FG4: refuses another site Worker created, deleted, replaced, adopted or orphaned", () => {
    const own = ["[CireLanding] noop", "[CireVendor] update"];
    expect(flipped(["Plan: 1 to update, 1 to create", "[CireHost] create", ...own])).toEqual([
      "a flip release changes only CireVendor, and CireHost would create",
    ]);
    expect(
      flipped(["Plan: 1 to update, 1 to adopted", "[CireHost] adopted", ...own], reading(), {
        adoptions: ["cire-host"],
      }),
    ).toEqual(["a flip release changes only CireVendor, and CireHost would be adopted"]);
    for (const action of ["replace", "delete", "orphaned"]) {
      expect(
        flipped([`Plan: 1 to update, 1 to ${action}`, `[CireHost] ${action}`, ...own]),
      ).toEqual([
        `CireHost (custom-domain) would be ${action === "orphaned" ? "orphaned" : `${action}d`}`,
        `a flip release changes only CireVendor, and CireHost would ${action}`,
      ]);
    }
  });

  test("FG5: refuses an update of a resource that is not one of the stack's site Workers", () => {
    expect(
      flipped([
        "Plan: 2 to update",
        "[CireApi] update",
        "[CireHost] noop",
        "[CireLanding] noop",
        "[CireVendor] update",
      ]),
    ).toEqual(["a flip release changes only CireVendor, and CireApi would update"]);
  });

  test("FG6: refuses a binding change on another site Worker, as on the flip site", () => {
    expect(
      flipped([
        "Plan: 3 to update, 1 binding changes",
        "[CireHost] update",
        "[CireHost/X] create",
        "[CireLanding] update",
        "[CireVendor] update",
      ]),
    ).toEqual(["a flip release changes no binding"]);
  });

  test("FG7: refuses a flip that does not update its site, or whose site would not gain its production host", () => {
    expect(
      flipped([
        "Plan: 2 to update",
        "[CireHost] update",
        "[CireLanding] update",
        "[CireVendor] noop",
      ]),
    ).toEqual(["a flip release must update CireVendor"]);
    // Its Worker holds the production host already: nothing to move.
    expect(flipped(RELEASE, reading([]))).toEqual([
      "a flip release must attach vendor.cireweddings.com to CireVendor",
    ]);
    expect(
      flipped(
        RELEASE,
        reading([{ site: "cire_vendor", added: ["next.vendor.cireweddings.com"], removed: [] }]),
      ),
    ).toEqual(["a flip release must attach vendor.cireweddings.com to CireVendor"]);
  });

  test("FG8: domainChanges names each site it read, and only those", () => {
    const read = domainChanges({
      sites: ["cire_vendor", "cire_host"],
      modes: { ...PRODUCTION_SITE_MODES, cire_vendor: "worker" },
      live: { cire_host: ["next.host.cireweddings.com"], cire_landing: ["next.cireweddings.com"] },
    });
    expect(read).toEqual({
      changes: [],
      problems: ["the hosts cire_vendor's Worker holds now were not read"],
      read: ["cire_host"],
    });
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
      flip: null,
      domains: [],
      unflip: null,
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

  test("a stack's site kinds: every staged or worker site is a Worker holding a domain", () => {
    expect(
      productionSiteKinds(
        { cire_host: "CireHost", cire_vendor: "CireVendor", cire_landing: "CireLanding" },
        {
          cire_host: "staged",
          cire_vendor: "worker",
          cire_landing: "off",
          osn_social: "staged",
          musubi_landing: "worker",
          pulse_landing: "off",
        },
      ),
    ).toEqual({ CireHost: "custom-domain", CireVendor: "custom-domain" });
  });
});

describe("runPlanGuardCli", () => {
  const dir = mkdtempSync(join(tmpdir(), "plan-guard-"));
  const domainsFile = join(dir, "domains.json");
  /** The hosts each staged site's Worker holds while nothing moves: its spare host. */
  const STAGED_LIVE = {
    cire_host: ["next.host.cireweddings.com"],
    cire_vendor: ["next.vendor.cireweddings.com"],
  };
  const run = (
    argv: string[],
    log?: string,
    live: unknown = STAGED_LIVE,
    modes: Readonly<Record<SiteSurface, SiteMode>> = PRODUCTION_SITE_MODES,
  ) => {
    if (log !== undefined) writeFileSync(join(dir, "plan.log"), log);
    writeFileSync(domainsFile, typeof live === "string" ? live : JSON.stringify(live));
    const out: string[] = [];
    const code = runPlanGuardCli({
      stack: "cire",
      kinds: KINDS,
      sites: { cire_host: "CireHost", cire_vendor: "CireVendor" },
      argv,
      env: {},
      out: (text) => out.push(text),
      modes,
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

  test("G14: --flip naming a surface outside the stack, --flip with --unflip, or missing arguments, exit 2", () => {
    expect(run([...logArgs, "--flip", "osn_social"], pretty("Plan: no changes")).code).toBe(2);
    expect(run(["--log", join(dir, "plan.log")]).code).toBe(2);
    const both = run(
      [...logArgs, "--flip", "cire_vendor", "--unflip", "cire_vendor"],
      pretty("Plan: 1 to update", "[CireVendor] update"),
      STAGED_LIVE,
      vendorWorker,
    );
    expect(both.code).toBe(2);
    expect(both.out).toBe(
      "::error::plan-guard: a release moves a domain one way: pass --flip or --unflip, never both\n",
    );
    const flipped = run(
      [...logArgs, "--flip", "cire_vendor"],
      pretty("Plan: 1 to update", "[CireVendor] update"),
      STAGED_LIVE,
      vendorWorker,
    );
    expect(flipped.code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "record.json"), "utf8")).flip).toBe("CireVendor");
  });

  const UPDATE = pretty("Plan: 1 to update", "[CireVendor] update", "[CireHost] noop");
  const record = () => JSON.parse(readFileSync(join(dir, "record.json"), "utf8")) as unknown;
  const vendorWorker = { ...PRODUCTION_SITE_MODES, cire_vendor: "worker" } as const;

  test("GD1: no --domains is a usage error; an unreadable, malformed or partial file refuses", () => {
    const bare = ["--log", join(dir, "plan.log"), "--out", join(dir, "record.json")];
    expect(run(bare, UPDATE).code).toBe(2);
    expect(run([...bare, "--domains"], UPDATE).code).toBe(2);
    const missing = run([...bare, "--domains", join(dir, "nowhere.json")], UPDATE);
    expect(missing.code).toBe(1);
    expect(missing.out).toContain("the hosts cire_host's Worker holds now were not read");
    for (const live of [
      "not json",
      "[]",
      { ...STAGED_LIVE, cire_host: "next.host.cireweddings.com" },
      { ...STAGED_LIVE, cire_host: [1] },
    ]) {
      const result = run(logArgs, UPDATE, live);
      expect({ live, code: result.code }).toEqual({ live, code: 1 });
      expect(result.out).toContain("cire_host's Worker holds now were not read");
    }
  });

  test("GD5: a site of the stack missing from the file refuses", () => {
    const result = run(logArgs, UPDATE, { cire_host: STAGED_LIVE.cire_host });
    expect(result.code).toBe(1);
    expect(result.out).toContain("the hosts cire_vendor's Worker holds now were not read");
  });

  test("GD2: the record and the summary name each site's added and removed hosts, the same every run", () => {
    // A flip of cire_vendor: its Worker gives up its spare host and takes its production host.
    const flip = run([...logArgs, "--flip", "cire_vendor"], UPDATE, STAGED_LIVE, vendorWorker);
    expect(flip.code).toBe(0);
    const first = readFileSync(join(dir, "record.json"), "utf8");
    expect(record()).toMatchObject({
      flip: "CireVendor",
      domains: [
        {
          site: "cire_vendor",
          added: ["vendor.cireweddings.com"],
          removed: ["next.vendor.cireweddings.com"],
        },
      ],
      unflip: null,
    });
    expect(flip.out).toContain(
      "| `cire_vendor` | `vendor.cireweddings.com` | `next.vendor.cireweddings.com` |",
    );
    run([...logArgs, "--flip", "cire_vendor"], UPDATE, STAGED_LIVE, vendorWorker);
    expect(readFileSync(join(dir, "record.json"), "utf8")).toBe(first);
    // A first staged deploy: nothing to remove.
    const fresh = run(logArgs, UPDATE, { cire_host: [], cire_vendor: [] });
    expect(fresh.code).toBe(0);
    expect(record()).toMatchObject({
      domains: [
        { site: "cire_host", added: ["next.host.cireweddings.com"], removed: [] },
        { site: "cire_vendor", added: ["next.vendor.cireweddings.com"], removed: [] },
      ],
    });
    const quiet = run(logArgs, UPDATE);
    expect(quiet.out).toContain("No site's custom domains change.");
  });

  test("GD3: a Worker giving up its production host, or a host the code no longer names, refuses unless unflip names its site", () => {
    // Set back from worker to staged: the Worker holds the production host.
    const back = { cire_host: STAGED_LIVE.cire_host, cire_vendor: ["vendor.cireweddings.com"] };
    const refused = run(logArgs, UPDATE, back);
    expect(refused.code).toBe(1);
    expect(refused.out).toContain(
      "cire_vendor's Worker would give up vendor.cireweddings.com; only a release dispatched with unflip: cire_vendor takes a production host off its Worker",
    );
    const unflipped = run([...logArgs, "--unflip", "cire_vendor"], UPDATE, back);
    expect(unflipped.code).toBe(0);
    expect(record()).toMatchObject({
      domains: [
        {
          site: "cire_vendor",
          added: ["next.vendor.cireweddings.com"],
          removed: ["vendor.cireweddings.com"],
        },
      ],
      unflip: "cire_vendor",
    });
    // unflip names one site: another site's production host still refuses.
    const hostBack = { ...back, cire_host: ["host.cireweddings.com"] };
    const other = run([...logArgs, "--unflip", "cire_vendor"], UPDATE, hostBack);
    expect(other.code).toBe(1);
    expect(other.out).toContain("cire_host's Worker would give up host.cireweddings.com");
    // A worker site whose host the code changed: the old host refuses too.
    const moved = run(
      logArgs,
      UPDATE,
      { ...STAGED_LIVE, cire_vendor: ["old.cireweddings.com"] },
      vendorWorker,
    );
    expect(moved.code).toBe(1);
    expect(moved.out).toContain("cire_vendor's Worker would give up old.cireweddings.com");
    // --unflip naming a site outside the stack is a usage error.
    expect(run([...logArgs, "--unflip", "osn_social"], UPDATE).code).toBe(2);
  });

  test("GD4: a re-plan whose domain change differs from the approved one is refused", () => {
    const approved = join(dir, "approved-domains.json");
    expect(run(logArgs, UPDATE).code).toBe(0);
    writeFileSync(approved, readFileSync(join(dir, "record.json")));
    expect(run([...logArgs, "--approved", approved], UPDATE).code).toBe(0);
    const changed = run([...logArgs, "--approved", approved], UPDATE, {
      ...STAGED_LIVE,
      cire_host: [],
    });
    expect(changed.code).toBe(1);
    expect(changed.out).toContain("not the one approved");
  });

  test("GD6: a Worker gives up its own site's retired spare host with no flip or unflip; another site's retired host refuses", () => {
    const retiredLive = {
      cire_host: ["next-host.cireweddings.com"],
      cire_vendor: ["next-vendor.cireweddings.com"],
    };
    const swap = run(
      logArgs,
      pretty("Plan: 2 to update", "[CireHost] update", "[CireVendor] update"),
      retiredLive,
    );
    expect(swap.out).not.toContain("::error::");
    expect(swap.code).toBe(0);
    expect(record()).toMatchObject({
      flip: null,
      domains: [
        {
          site: "cire_host",
          added: ["next.host.cireweddings.com"],
          removed: ["next-host.cireweddings.com"],
        },
        {
          site: "cire_vendor",
          added: ["next.vendor.cireweddings.com"],
          removed: ["next-vendor.cireweddings.com"],
        },
      ],
      unflip: null,
    });
    const crossed = run(logArgs, UPDATE, {
      ...STAGED_LIVE,
      cire_host: ["next-vendor.cireweddings.com"],
    });
    expect(crossed.code).toBe(1);
    expect(crossed.out).toContain(
      "cire_host's Worker would give up next-vendor.cireweddings.com; only a release dispatched with unflip: cire_host",
    );
  });

  describe("FG9: a flip of cire_vendor as the release workflow runs the guard, the three cire sites declared", () => {
    const THREE = { cire_host: "CireHost", cire_vendor: "CireVendor", cire_landing: "CireLanding" };
    const THREE_KINDS: Readonly<Record<string, ResourceKind>> = {
      CireHost: "custom-domain",
      CireVendor: "custom-domain",
      CireLanding: "custom-domain",
    };
    /** Every Worker on its spare host, as release 42140585413's record found them (`"domains": []`). */
    const SPARE = {
      cire_host: ["next.host.cireweddings.com"],
      cire_vendor: ["next.vendor.cireweddings.com"],
      cire_landing: ["next.cireweddings.com"],
    };
    /** Release 42140585413's cire plan: every site Worker updates. */
    const RELEASE_LOG = pretty(
      "Plan: 3 to update",
      "[CireHost] update",
      "[CireLanding] update",
      "[CireVendor] update",
    );
    const flip = (live: unknown) => {
      writeFileSync(join(dir, "plan.log"), RELEASE_LOG);
      writeFileSync(domainsFile, JSON.stringify(live));
      const out: string[] = [];
      const code = runPlanGuardCli({
        stack: "cire",
        kinds: THREE_KINDS,
        sites: THREE,
        argv: [...logArgs, "--flip", "cire_vendor"],
        env: {},
        out: (text) => out.push(text),
        modes: vendorWorker,
      });
      return { code, out: out.join("") };
    };

    test("allows the flip with the other two Workers updating on their spare hosts, recording vendor's move alone", () => {
      const result = flip(SPARE);
      expect(result.out).not.toContain("::error::");
      expect(result.code).toBe(0);
      expect(record()).toEqual({
        stack: "cire",
        plan: "changes",
        counts: { update: 3 },
        resources: [
          { fqn: "CireHost", kind: "custom-domain", action: "update" },
          { fqn: "CireLanding", kind: "custom-domain", action: "update" },
          { fqn: "CireVendor", kind: "custom-domain", action: "update" },
        ],
        bindings: [],
        flip: "CireVendor",
        domains: [
          {
            site: "cire_vendor",
            added: ["vendor.cireweddings.com"],
            removed: ["next.vendor.cireweddings.com"],
          },
        ],
        unflip: null,
      });
    });

    test("refuses it while another Worker's hosts would change, naming that change alone", () => {
      const result = flip({ ...SPARE, cire_host: [] });
      expect(result.code).toBe(1);
      expect(result.out.split("\n").filter((line) => line.startsWith("::error::"))).toEqual([
        "::error::cire production plan refused: a flip release moves only CireVendor's domain, and cire_host's Worker would gain next.host.cireweddings.com and give up nothing",
      ]);
      expect(result.out).not.toContain("a flip release changes only");
    });
  });
});

describe("domainRefusals", () => {
  test("GD7: a retired host that is a production host or a current spare host never leaves on its strength", () => {
    const removed = [
      "host.cireweddings.com",
      "id.musubi.social",
      "next.vendor.cireweddings.com",
      "old.host.cireweddings.com",
    ];
    const refused = domainRefusals([{ site: "cire_host", added: [], removed }], undefined, {
      cire_host: removed,
    });
    expect(refused).toEqual(
      ["host.cireweddings.com", "id.musubi.social", "next.vendor.cireweddings.com"].map(
        (host) =>
          `cire_host's Worker would give up ${host}; only a release dispatched with unflip: cire_host takes a production host off its Worker`,
      ),
    );
  });

  test("GD8: with the shipped list, a site with no retired entry gives up its spare host freely and refuses any other host", () => {
    expect(
      domainRefusals([{ site: "cire_landing", added: [], removed: ["next.cireweddings.com"] }]),
    ).toEqual([]);
    expect(
      domainRefusals([{ site: "cire_landing", added: [], removed: ["old.cireweddings.com"] }]),
    ).toEqual([
      "cire_landing's Worker would give up old.cireweddings.com; only a release dispatched with unflip: cire_landing takes a production host off its Worker",
    ]);
  });
});
