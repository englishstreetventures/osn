import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

/**
 * The wiring rule behind the tier gate, checked over the real source.
 *
 * `weddingTier(db, min)` reads the wedding's tier from the role gate mounted
 * directly before it — `weddingMember`, `weddingEditor`, `weddingOwner` or
 * `weddingRunSheet`, each of which selects the tier with the row it authorises
 * against. Anything else still answers correctly, because the tier gate falls
 * back to its own query, so a broken pairing costs a round trip on every
 * request and fails nothing. This test is what fails instead. Every
 * `weddingTier(db, min)`:
 *
 *  - sits in `.use()` directly after `.use(<role gate>(db))`, so the role gate's
 *    403 answers before the tier gate's 402 and the tier is already on the
 *    context;
 *  - names its tier as a string literal, `"gold"` or `"crimson"`, so the tier a
 *    route needs is readable from the route file.
 *
 * It also pins which files mount the tier gate and how many times, so a scan
 * that silently reads nothing — or a gate quietly dropped from a route — fails
 * too.
 */

const SRC_DIR = join(import.meta.dir, "../../src");

const TIER_GATE = "weddingTier";
const ROLE_GATES: ReadonlySet<string> = new Set([
  "weddingMember",
  "weddingEditor",
  "weddingOwner",
  "weddingRunSheet",
]);
const PAID_TIERS: ReadonlySet<string> = new Set(["gold", "crimson"]);
const GATE_NAMES: ReadonlySet<string> = new Set([TIER_GATE, ...ROLE_GATES]);

type Scan = { problems: string[]; pairs: number };

/** The name a call goes through: `f(…)` and `ns.f(…)` are both `f`. */
function calleeName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return undefined;
}

/** `x.use(…)`'s receiver `x`, or undefined when `call` is not a `.use()`. */
function useReceiver(call: ts.Node): ts.Expression | undefined {
  if (!ts.isCallExpression(call)) return undefined;
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "use") return undefined;
  return callee.expression;
}

/** The gate a `.use(gate(…))` call mounts, or undefined for any other call. */
function mountedGate(call: ts.Node): ts.CallExpression | undefined {
  if (!useReceiver(call) || !ts.isCallExpression(call) || call.arguments.length !== 1) {
    return undefined;
  }
  const [arg] = call.arguments;
  return arg && ts.isCallExpression(arg) ? arg : undefined;
}

/** The `.use()` call whose only argument is `gate`, if it is mounted inline. */
function enclosingUse(gate: ts.CallExpression): ts.CallExpression | undefined {
  const parent = gate.parent;
  return ts.isCallExpression(parent) && mountedGate(parent) === gate ? parent : undefined;
}

function checkSource(fileName: string, text: string): Scan {
  const source = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const problems: string[] = [];
  let pairs = 0;
  const at = (node: ts.Node) =>
    `${fileName}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`;

  function checkTierGate(gate: ts.CallExpression) {
    const arg = gate.arguments[1];
    if (!arg || !ts.isStringLiteralLike(arg) || !PAID_TIERS.has(arg.text)) {
      problems.push(`${at(gate)}: weddingTier needs a string-literal "gold" or "crimson"`);
      return;
    }
    const tier = arg.text;
    const use = enclosingUse(gate);
    if (!use) {
      problems.push(`${at(gate)}: weddingTier(db, "${tier}") must be mounted inline in .use()`);
      return;
    }
    const before = useReceiver(use);
    const roleGate = before && mountedGate(before);
    const roleName = roleGate && calleeName(roleGate);
    if (!roleGate || !roleName || !ROLE_GATES.has(roleName)) {
      problems.push(
        `${at(gate)}: weddingTier(db, "${tier}") must sit directly after ` +
          `weddingMember, weddingEditor, weddingOwner or weddingRunSheet`,
      );
      return;
    }
    pairs++;
  }

  function visit(node: ts.Node) {
    if (ts.isImportSpecifier(node) && node.propertyName) {
      const imported = node.propertyName.text;
      if (GATE_NAMES.has(imported)) {
        problems.push(`${at(node)}: ${imported} is imported under another name`);
      }
    }
    if (ts.isCallExpression(node) && calleeName(node) === TIER_GATE) checkTierGate(node);
    ts.forEachChild(node, visit);
  }
  visit(source);

  return { problems, pairs };
}

/** A route file in the shape the real ones take, around `chain`. */
function route(chain: string, imports = "") {
  return `${imports}
export const routes = (db: Db) =>
  new Elysia({ prefix: "/api/organiser" }).group("/weddings/:weddingId", (group) =>
    group
      ${chain}
      .get("/thing", () => ({ ok: true })),
  );
`;
}

describe("the pairing checker", () => {
  it("accepts a tier gate directly after each role gate", () => {
    for (const gate of ROLE_GATES) {
      for (const tier of PAID_TIERS) {
        const scan = checkSource(
          "ok.ts",
          route(`.use(${gate}(db))
      .use(weddingTier(db, "${tier}"))
      .use(rateLimitMiddlewareByUser(limiter))`),
        );
        expect(scan).toEqual({ problems: [], pairs: 1 });
      }
    }
  });

  it("accepts a comment between the two gates", () => {
    const scan = checkSource(
      "ok.ts",
      route(`.use(weddingEditor(db))
      // Gate order: role (403) then tier (402).
      .use(weddingTier(db, "gold"))`),
    );
    expect(scan).toEqual({ problems: [], pairs: 1 });
  });

  it("ignores a role gate with no tier gate", () => {
    expect(checkSource("ok.ts", route(`.use(weddingMember(db))`))).toEqual({
      problems: [],
      pairs: 0,
    });
  });

  it("follows a namespace import like a named one", () => {
    const scan = checkSource(
      "ok.ts",
      route(`.use(gates.weddingOwner(db))
      .use(gates.weddingTier(db, "gold"))`),
    );
    expect(scan).toEqual({ problems: [], pairs: 1 });
  });

  // Each fixture names every problem it expects by a fragment of its message,
  // and each trips a single rule, so deleting any one rule turns its own case
  // red.
  const failures: Record<string, { source: string; reports: string[] }> = {
    "a gate that reads no tier": {
      source: route(`.use(osnAuth(opts))
      .use(weddingTier(db, "gold"))`),
      reports: ["must sit directly after"],
    },
    "another plugin between the two": {
      source: route(`.use(weddingMember(db))
      .use(rateLimitMiddlewareByUser(limiter))
      .use(weddingTier(db, "crimson"))`),
      reports: ["must sit directly after"],
    },
    "the tier gate first": {
      source: route(`.use(weddingTier(db, "gold"))
      .use(weddingMember(db))`),
      reports: ["must sit directly after"],
    },
    "a tier that is not a literal": {
      source: route(`.use(weddingMember(db))
      .use(weddingTier(db, tier))`),
      reports: ['needs a string-literal "gold" or "crimson"'],
    },
    "the free tier": {
      source: route(`.use(weddingMember(db))
      .use(weddingTier(db, "ivory"))`),
      reports: ['needs a string-literal "gold" or "crimson"'],
    },
    "a legacy entitlement key": {
      source: route(`.use(weddingMember(db))
      .use(weddingTier(db, "vendors"))`),
      reports: ['needs a string-literal "gold" or "crimson"'],
    },
    "a gate built outside the chain": {
      source: route(`.use(gate)`, `const gate = weddingTier(db, "gold");`),
      reports: ["must be mounted inline"],
    },
    "an aliased import": {
      source: route(
        `.use(weddingMember(db))
      .use(paid(db, "gold"))`,
        `import { weddingTier as paid } from "../middleware/wedding-tier";`,
      ),
      reports: ["imported under another name"],
    },
  };

  for (const [shape, { source, reports }] of Object.entries(failures)) {
    it(`reports ${shape}`, () => {
      const { problems } = checkSource("bad.ts", source);
      expect(problems).toHaveLength(reports.length);
      for (const fragment of reports) {
        expect(problems.some((problem) => problem.includes(fragment))).toBe(true);
      }
    });
  }
});

describe("weddingTier mounts in cire/api/src", () => {
  const files = readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" }).filter((path) =>
    path.endsWith(".ts"),
  );
  const scans = files.map((path) => {
    const { problems, pairs } = checkSource(path, readFileSync(join(SRC_DIR, path), "utf8"));
    return { path, problems, pairs };
  });

  it("each sits directly behind a role gate and names a paid tier", () => {
    expect(scans.flatMap((scan) => scan.problems)).toEqual([]);
  });

  it("are the ones this test knows about", () => {
    const inventory = Object.fromEntries(
      scans.filter((scan) => scan.pairs > 0).map((scan) => [scan.path, scan.pairs]),
    );
    // A new gated route, or one un-gated, changes this list on purpose.
    expect(inventory).toEqual({
      "routes/budget.ts": 3,
      "routes/organiser-enquiries.ts": 2,
      "routes/registry-stripe.ts": 1,
      "routes/registry.ts": 6,
      "routes/tasks.ts": 2,
      "routes/vendor-directory.ts": 2,
      "routes/vendors.ts": 2,
    });
  });
});
