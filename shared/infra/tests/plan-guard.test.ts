import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

import {
  guardPlan,
  messageOf,
  parsePlan,
  planRecord,
  productionSiteKinds,
  renderGuardSummary,
  runPlanGuardCli,
  type ResourceKind,
} from "../src/plan-guard";

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

  test("G4: a resource the stack does not declare on production", () => {
    expect(refusals(pretty("Plan: 1 to create", "[ZapApi] create"))).toEqual([
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
  });

  test("G11: in a flip release, anything but the flip's own update with every other line a noop", () => {
    const flip = "CireVendor";
    const one = pretty("Plan: 1 to update", "[CireHost] noop", "[CireVendor] update");
    expect(refusals(one, { flip })).toEqual([]);
    expect(
      refusals(pretty("Plan: no changes", "[CireHost] noop", "[CireVendor] noop"), { flip }),
    ).toEqual(["a flip release must update CireVendor"]);
    expect(
      refusals(pretty("Plan: 2 to update", "[CireHost] update", "[CireVendor] update"), { flip }),
    ).toEqual(["a flip release changes only CireVendor, and CireHost would update"]);
    expect(
      refusals(
        pretty(
          "Plan: 1 to update, 1 binding changes",
          "[CireVendor] update",
          "[CireVendor/X] create",
        ),
        { flip },
      ),
    ).toEqual(["a flip release changes no binding"]);
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
  const run = (argv: string[], log?: string) => {
    if (log !== undefined) writeFileSync(join(dir, "plan.log"), log);
    const out: string[] = [];
    const code = runPlanGuardCli({
      stack: "cire",
      kinds: KINDS,
      sites: { cire_host: "CireHost", cire_vendor: "CireVendor" },
      argv,
      env: {},
      out: (text) => out.push(text),
    });
    return { code, out: out.join("") };
  };
  const logArgs = ["--log", join(dir, "plan.log"), "--out", join(dir, "record.json")];

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

  test("G14: --flip naming a surface outside the stack, or missing arguments, exit 2", () => {
    expect(run([...logArgs, "--flip", "osn_social"], pretty("Plan: no changes")).code).toBe(2);
    expect(run(["--log", join(dir, "plan.log")]).code).toBe(2);
    const flipped = run(
      [...logArgs, "--flip", "cire_vendor"],
      pretty("Plan: 1 to update", "[CireVendor] update"),
    );
    expect(flipped.code).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "record.json"), "utf8")).flip).toBe("CireVendor");
  });
});
