import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import ts from "typescript";

/**
 * The wiring rule behind the entitlement fold, checked over the real source.
 *
 * `weddingEntitlement(db, key)` reads its answer from the role gate mounted
 * directly before it, which folds the check into the query it already runs —
 * but only when that gate folds (`weddingMember`, `weddingEditor`,
 * `weddingOwner`) and was called with the SAME key. Anything else still answers
 * correctly, because the entitlement gate falls back to its own query, so a
 * broken pairing costs a round trip on every request and fails nothing. This
 * test is what fails instead. It holds the rule both ways:
 *
 *  - every `weddingEntitlement(db, key)` sits in `.use()` directly after
 *    `.use(<folding gate>(db, key))`, with the key a string literal;
 *  - every folding gate called with a key has `.use(weddingEntitlement(db,
 *    key))` directly after it, since a key with nothing to read it adds the
 *    check's cost to a route that never asks.
 *
 * It also pins which files mount the entitlement gate and how many times, so a
 * scan that silently reads nothing — or a gate quietly dropped from a route —
 * fails too.
 */

const SRC_DIR = join(import.meta.dir, "../../src");

const ENTITLEMENT_GATE = "weddingEntitlement";
const FOLDING_GATES: ReadonlySet<string> = new Set([
  "weddingMember",
  "weddingEditor",
  "weddingOwner",
]);
const GATE_NAMES: ReadonlySet<string> = new Set([ENTITLEMENT_GATE, ...FOLDING_GATES]);

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

/** A gate's entitlement key: the literal, `undefined` when none is passed, and
 *  `null` when one is passed but is not a string literal. */
function keyOf(gate: ts.CallExpression): string | null | undefined {
  const arg = gate.arguments[1];
  if (!arg) return undefined;
  return ts.isStringLiteralLike(arg) ? arg.text : null;
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

  function checkEntitlementGate(gate: ts.CallExpression) {
    const key = keyOf(gate);
    if (typeof key !== "string") {
      problems.push(`${at(gate)}: weddingEntitlement needs a string-literal key`);
      return;
    }
    const use = enclosingUse(gate);
    if (!use) {
      problems.push(
        `${at(gate)}: weddingEntitlement(db, "${key}") must be mounted inline in .use()`,
      );
      return;
    }
    const before = useReceiver(use);
    const roleGate = before && mountedGate(before);
    const roleName = roleGate && calleeName(roleGate);
    if (!roleGate || !roleName || !FOLDING_GATES.has(roleName)) {
      problems.push(
        `${at(gate)}: weddingEntitlement(db, "${key}") must sit directly after ` +
          `weddingMember, weddingEditor or weddingOwner called with "${key}"`,
      );
      return;
    }
    if (keyOf(roleGate) !== key) {
      problems.push(
        `${at(gate)}: ${roleName} before weddingEntitlement(db, "${key}") must be called ` +
          `with the same key`,
      );
      return;
    }
    pairs++;
  }

  function checkFoldingGate(gate: ts.CallExpression, name: string) {
    const key = keyOf(gate);
    if (key === undefined) return;
    if (key === null) {
      problems.push(`${at(gate)}: ${name}'s entitlement key must be a string literal`);
      return;
    }
    const use = enclosingUse(gate);
    const next = use?.parent.parent;
    const after = next && mountedGate(next);
    const followed =
      use !== undefined &&
      next !== undefined &&
      useReceiver(next) === use &&
      after !== undefined &&
      calleeName(after) === ENTITLEMENT_GATE &&
      keyOf(after) === key;
    if (!followed) {
      problems.push(
        `${at(gate)}: ${name}(db, "${key}") folds an entitlement nothing reads — ` +
          `mount weddingEntitlement(db, "${key}") directly after it, or drop the key`,
      );
    }
  }

  function visit(node: ts.Node) {
    if (ts.isImportSpecifier(node) && node.propertyName) {
      const imported = node.propertyName.text;
      if (GATE_NAMES.has(imported)) {
        problems.push(`${at(node)}: ${imported} is imported under another name`);
      }
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name === ENTITLEMENT_GATE) checkEntitlementGate(node);
      else if (name !== undefined && FOLDING_GATES.has(name)) checkFoldingGate(node, name);
    }
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
  it("accepts a same-key pair for each folding gate", () => {
    for (const gate of FOLDING_GATES) {
      const scan = checkSource(
        "ok.ts",
        route(`.use(${gate}(db, "vendors"))
      .use(weddingEntitlement(db, "vendors"))
      .use(rateLimitMiddlewareByUser(limiter))`),
      );
      expect(scan).toEqual({ problems: [], pairs: 1 });
    }
  });

  it("accepts a comment between the two gates", () => {
    const scan = checkSource(
      "ok.ts",
      route(`.use(weddingEditor(db, "registry"))
      // Gate order: role (403) then entitlement (402).
      .use(weddingEntitlement(db, "registry"))`),
    );
    expect(scan).toEqual({ problems: [], pairs: 1 });
  });

  it("ignores a role gate with no key and no entitlement gate", () => {
    expect(checkSource("ok.ts", route(`.use(weddingMember(db))`))).toEqual({
      problems: [],
      pairs: 0,
    });
  });

  it("follows a namespace import like a named one", () => {
    const scan = checkSource(
      "ok.ts",
      route(`.use(gates.weddingOwner(db, "registry"))
      .use(gates.weddingEntitlement(db, "registry"))`),
    );
    expect(scan).toEqual({ problems: [], pairs: 1 });
  });

  // Each fixture names every problem it expects by a fragment of its message,
  // and all but one trip a single rule, so deleting any one rule turns its own
  // case red.
  const failures: Record<string, { source: string; reports: string[] }> = {
    "a role gate with no key": {
      source: route(`.use(weddingOwner(db))
      .use(weddingEntitlement(db, "registry"))`),
      reports: ["must be called with the same key"],
    },
    "a role gate with a different key": {
      source: route(`.use(weddingMember(db, "vendors"))
      .use(weddingEntitlement(db, "registry"))`),
      // A keyed role gate before a different-key entitlement gate breaks the
      // pairing in both directions.
      reports: ["must be called with the same key", "folds an entitlement nothing reads"],
    },
    "a gate that cannot fold": {
      source: route(`.use(weddingRunSheet(db, "vendors"))
      .use(weddingEntitlement(db, "vendors"))`),
      reports: ["must sit directly after"],
    },
    "another plugin between the two": {
      source: route(`.use(weddingMember(db))
      .use(rateLimitMiddlewareByUser(limiter))
      .use(weddingEntitlement(db, "vendors"))`),
      reports: ["must sit directly after"],
    },
    "the entitlement gate first": {
      source: route(`.use(weddingEntitlement(db, "vendors"))
      .use(weddingMember(db))`),
      reports: ["must sit directly after"],
    },
    "a key with no entitlement gate after it": {
      source: route(`.use(weddingEditor(db, "vendors"))`),
      reports: ["folds an entitlement nothing reads"],
    },
    "an entitlement key that is not a literal": {
      source: route(`.use(weddingMember(db))
      .use(weddingEntitlement(db, key))`),
      reports: ["weddingEntitlement needs a string-literal key"],
    },
    "a role-gate key that is not a literal": {
      source: route(`.use(weddingMember(db, key))`),
      reports: ["entitlement key must be a string literal"],
    },
    "a gate built outside the chain": {
      source: route(`.use(gate)`, `const gate = weddingEntitlement(db, "vendors");`),
      reports: ["must be mounted inline"],
    },
    "a mismatched call through a namespace import": {
      source: route(`.use(weddingMember(db))
      .use(gates.weddingEntitlement(db, "vendors"))`),
      reports: ["must be called with the same key"],
    },
    "an aliased import": {
      source: route(
        `.use(weddingMember(db))
      .use(entitled(db, "vendors"))`,
        `import { weddingEntitlement as entitled } from "../middleware/wedding-entitlement";`,
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

describe("weddingEntitlement mounts in cire/api/src", () => {
  const files = readdirSync(SRC_DIR, { recursive: true, encoding: "utf8" }).filter((path) =>
    path.endsWith(".ts"),
  );
  const scans = files.map((path) => {
    const { problems, pairs } = checkSource(path, readFileSync(join(SRC_DIR, path), "utf8"));
    return { path, problems, pairs };
  });

  it("each sits directly behind a folding role gate with the same key, and every key is read", () => {
    expect(scans.flatMap((scan) => scan.problems)).toEqual([]);
  });

  it("are the ones this test knows about", () => {
    const inventory = Object.fromEntries(
      scans.filter((scan) => scan.pairs > 0).map((scan) => [scan.path, scan.pairs]),
    );
    // A new gated route, or one un-gated, changes this list on purpose.
    expect(inventory).toEqual({
      "routes/organiser-enquiries.ts": 2,
      "routes/registry-stripe.ts": 1,
      "routes/registry.ts": 5,
      "routes/vendor-directory.ts": 2,
      "routes/vendors.ts": 2,
    });
  });
});
