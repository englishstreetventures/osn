/**
 * drizzle's `inArray(column, list)` and `notInArray(column, list)` bind one SQL
 * parameter per element of a JavaScript array. Cloudflare D1 allows 100 bound
 * parameters in one statement (developers.cloudflare.com/d1/platform/limits/),
 * counting every other value the statement binds. `bun:sqlite`, which runs
 * every test tier except the Miniflare one, allows 999, so a list that grows
 * past the cap passes the whole suite and fails only in production, with
 * `D1_ERROR: too many SQL variables`.
 *
 * The rule reports the list argument unless its bind count is fixed by the
 * source or is a single parameter:
 *
 *  - an array literal, spreading nothing but a same-file `as const` tuple;
 *  - `jsonEachIn(…)` imported from `@shared/db-utils` (or its own `jsonEach`
 *    module), which binds the whole array as one JSON parameter;
 *  - a query-builder chain that starts with `.select(` / `.selectDistinct(` /
 *    `.selectDistinctOn(` and calls only builder steps after it (`.from(`,
 *    `.where(`, a join, `.limit(`, `.as(` …) — a subquery, which binds no list.
 *    A chain that runs the query (`.all()`, `.then(`, `.map(` …) is reported;
 *  - a `sql` template, unless it interpolates, at any depth, `sql.join(…)` over
 *    anything but an array literal;
 *  - a conditional whose two branches both pass;
 *  - a same-file `const` bound to one of the above or to an `as const` tuple
 *    (a plain `const ids = []` can still be pushed to);
 *  - a call to a same-file `const` arrow function whose expression body passes.
 *
 * A name is followed through at most four `const` bindings or helpers; a list
 * further away than that is reported. Everything else — a parameter, a `let`,
 * `body.ids`, `[...set]`, a call — is reported. Where a cap the code enforces keeps the whole statement under 100,
 * suppress the line with a reason that states the maximum and names the cap.
 *
 * It cannot see a list built in another module, an array interpolated into a
 * `sql` template by name, or a namespace import (`drizzle.inArray`). The other
 * way to reach the cap, a multi-row `.values(rows)` insert, is not this rule's.
 */

import { defineRule } from "@oxlint/plugins";
import type { ESTree, Scope, Variable } from "@oxlint/plugins";

/** The drizzle functions that bind one parameter per element. */
const CHECKED: ReadonlySet<string> = new Set(["inArray", "notInArray"]);

/** Query-builder methods that start a subquery. */
const SUBQUERY_METHODS: ReadonlySet<string> = new Set([
  "select",
  "selectDistinct",
  "selectDistinctOn",
]);

/**
 * Builder steps that leave a select a query rather than running it. A chain
 * with any other call between the select and the list argument — `.all()`,
 * `.then(`, `.map(` — has already read the rows into an array.
 */
const BUILDER_STEPS: ReadonlySet<string> = new Set([
  "from",
  "where",
  "innerJoin",
  "leftJoin",
  "rightJoin",
  "fullJoin",
  "crossJoin",
  "groupBy",
  "having",
  "orderBy",
  "limit",
  "offset",
  "as",
  "$dynamic",
  "union",
  "unionAll",
  "intersect",
  "except",
]);

/** Where `jsonEachIn` may come from: the package, or its own module inside it. */
const JSON_EACH_SOURCE = /^@shared\/db-utils(\/|$)|(^|\/)jsonEach(\.ts)?$/;

/** How many `const` hops a list is followed through before it counts as unknown. */
const MAX_DEPTH = 4;

const DRIZZLE = /^drizzle-orm(\/|$)/;

type Node = ESTree.Node;
type Identifier = Extract<Node, { type: "Identifier" }>;
type GetScope = (node: Node) => Scope;

/** Strip `as`, `satisfies`, `!`, `<T>` and parentheses. */
function unwrap(node: Node): Node {
  let current = node;
  for (;;) {
    switch (current.type) {
      case "TSAsExpression":
      case "TSSatisfiesExpression":
      case "TSNonNullExpression":
      case "TSTypeAssertion":
      case "ParenthesizedExpression":
        current = current.expression;
        break;
      default:
        return current;
    }
  }
}

/** True when an `as const` sits anywhere in the wrapper chain around a value. */
function hasConstAssertion(node: Node): boolean {
  let current = node;
  for (;;) {
    switch (current.type) {
      case "TSAsExpression": {
        const annotation = current.typeAnnotation;
        if (
          annotation.type === "TSTypeReference" &&
          annotation.typeName.type === "Identifier" &&
          annotation.typeName.name === "const"
        ) {
          return true;
        }
        current = current.expression;
        break;
      }
      case "TSSatisfiesExpression":
      case "TSNonNullExpression":
      case "TSTypeAssertion":
      case "ParenthesizedExpression":
        current = current.expression;
        break;
      default:
        return false;
    }
  }
}

/** The variable an identifier refers to, walking out from the scope it sits in. */
function resolve(identifier: Identifier, getScope: GetScope): Variable | null {
  for (let scope: Scope | null = getScope(identifier); scope !== null; scope = scope.upper) {
    const variable = scope.set.get(identifier.name);
    if (variable !== undefined) return variable;
  }
  return null;
}

/** The initialiser of a same-file `const name = …`, or null for anything else. */
function constInitialiser(node: Node, getScope: GetScope): Node | null {
  if (node.type !== "Identifier") return null;
  const variable = resolve(node, getScope);
  if (variable === null || variable.defs.length !== 1) return null;
  const [definition] = variable.defs;
  if (definition === undefined || definition.type !== "Variable") return null;
  const { node: declarator, parent } = definition;
  if (parent?.type !== "VariableDeclaration" || parent.kind !== "const") return null;
  if (declarator.type !== "VariableDeclarator" || declarator.id.type !== "Identifier") return null;
  return declarator.init ?? null;
}

/** A spread source whose length is written in the source: an `as const` tuple. */
function isFixedTuple(node: Node, depth: number, getScope: GetScope): boolean {
  const inner = unwrap(node);
  if (inner.type === "ArrayExpression") return isBounded(inner, depth + 1, getScope);
  const init = constInitialiser(inner, getScope);
  if (init === null) return false;
  return (
    hasConstAssertion(init) &&
    unwrap(init).type === "ArrayExpression" &&
    isBounded(init, depth + 1, getScope)
  );
}

/** A call to `jsonEachIn` imported from `@shared/db-utils`. */
function isJsonEachIn(call: ESTree.CallExpression, getScope: GetScope): boolean {
  const { callee } = call;
  if (callee.type !== "Identifier") return false;
  const definition = resolve(callee, getScope)?.defs[0];
  if (definition === undefined || definition.type !== "ImportBinding") return false;
  const { node: specifier, parent } = definition;
  if (specifier.type !== "ImportSpecifier" || parent?.type !== "ImportDeclaration") return false;
  const imported =
    specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;
  return (
    imported === "jsonEachIn" &&
    typeof parent.source.value === "string" &&
    JSON_EACH_SOURCE.test(parent.source.value)
  );
}

/**
 * A select still being built: the outermost call and every call down to the
 * `.select(`-family call that starts it are builder steps.
 */
function isSubqueryChain(call: ESTree.CallExpression): boolean {
  let current: Node = call;
  while (current.type === "CallExpression") {
    const callee: Node = current.callee;
    if (callee.type !== "MemberExpression" || callee.property.type !== "Identifier") return false;
    const method = callee.property.name;
    if (SUBQUERY_METHODS.has(method)) return true;
    if (!BUILDER_STEPS.has(method)) return false;
    current = callee.object;
  }
  return false;
}

/**
 * `sql.join(x, …)` where `x` is not an array literal — one parameter per
 * element of `x` — anywhere inside an interpolation, nested templates included.
 */
function hasUnboundedJoin(node: Node): boolean {
  switch (node.type) {
    case "CallExpression": {
      const { callee } = node;
      if (
        callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        callee.object.name === "sql" &&
        callee.property.type === "Identifier" &&
        callee.property.name === "join"
      ) {
        const [first] = node.arguments;
        if (first === undefined || unwrap(first).type !== "ArrayExpression") return true;
      }
      return node.arguments.some((argument) => hasUnboundedJoin(argument));
    }
    case "TaggedTemplateExpression":
      return node.quasi.expressions.some(hasUnboundedJoin);
    case "ArrayExpression":
      return node.elements.some((element) => element !== null && hasUnboundedJoin(element));
    case "SpreadElement":
      return hasUnboundedJoin(node.argument);
    default:
      return false;
  }
}

/** A call to a same-file `const` arrow function whose expression body is bounded. */
function isBoundedHelperCall(call: ESTree.CallExpression, depth: number, getScope: GetScope) {
  const init = constInitialiser(call.callee, getScope);
  if (init === null) return false;
  const fn = unwrap(init);
  if (fn.type !== "ArrowFunctionExpression" || fn.body.type === "BlockStatement") return false;
  return isBounded(fn.body, depth + 1, getScope);
}

/** Whether `node`, as the list argument, binds a number of parameters the source fixes. */
function isBounded(node: Node, depth: number, getScope: GetScope): boolean {
  if (depth > MAX_DEPTH) return false;
  const inner = unwrap(node);
  switch (inner.type) {
    case "ArrayExpression":
      return inner.elements.every(
        (element) =>
          element !== null &&
          (element.type !== "SpreadElement" || isFixedTuple(element.argument, depth, getScope)),
      );
    case "CallExpression":
      return (
        isJsonEachIn(inner, getScope) ||
        isSubqueryChain(inner) ||
        isBoundedHelperCall(inner, depth, getScope)
      );
    case "TaggedTemplateExpression":
      return (
        inner.tag.type === "Identifier" && inner.tag.name === "sql" && !hasUnboundedJoin(inner)
      );
    case "ConditionalExpression":
      return (
        isBounded(inner.consequent, depth, getScope) && isBounded(inner.alternate, depth, getScope)
      );
    case "Identifier": {
      const init = constInitialiser(inner, getScope);
      if (init === null) return false;
      if (unwrap(init).type === "ArrayExpression") {
        return hasConstAssertion(init) && isBounded(init, depth + 1, getScope);
      }
      return isBounded(init, depth + 1, getScope);
    }
    default:
      return false;
  }
}

/** The drizzle function a callee names, when it is an import of one from drizzle-orm. */
function drizzleFunction(callee: Node, getScope: GetScope): string | null {
  if (callee.type !== "Identifier") return null;
  const variable = resolve(callee, getScope);
  const definition = variable?.defs[0];
  if (definition === undefined || definition.type !== "ImportBinding") return null;
  const { node: specifier, parent } = definition;
  if (specifier.type !== "ImportSpecifier" || parent?.type !== "ImportDeclaration") return null;
  if (typeof parent.source.value !== "string" || !DRIZZLE.test(parent.source.value)) return null;
  const imported =
    specifier.imported.type === "Identifier" ? specifier.imported.name : specifier.imported.value;
  return CHECKED.has(imported) ? imported : null;
}

/** The list as the message quotes it: one line, at most 60 characters. */
function quote(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
}

/** Disallow a variable-length list as the second argument to drizzle's `inArray`/`notInArray`. */
export const noUnboundedInArrayRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow passing drizzle's `inArray` / `notInArray` a list whose length the source does not fix. Each element is one bound parameter, D1 allows 100 per statement, and bun:sqlite allows 999, so the overflow shows only in production. Pass `jsonEachIn(list)` (one bound JSON parameter) or a subquery.",
    },
    messages: {
      unboundedList:
        "`{{fn}}` binds one parameter per element of `{{list}}`, and D1 allows 100 in a statement — bun:sqlite allows 999, so no test sees it. Pass `jsonEachIn({{list}})` from @shared/db-utils (one bound JSON parameter) or a subquery. If a cap the code enforces keeps the whole statement under 100, suppress this line with a reason that states the maximum and names the cap.",
    },
  },
  createOnce(context) {
    const getScope: GetScope = (node) => context.sourceCode.getScope(node);
    return {
      CallExpression(node: ESTree.CallExpression) {
        const fn = drizzleFunction(node.callee, getScope);
        if (fn === null) return;
        const list = node.arguments[1];
        if (list === undefined || list.type === "SpreadElement") return;
        if (isBounded(list, 0, getScope)) return;
        context.report({
          node: list,
          messageId: "unboundedList",
          data: { fn, list: quote(context.sourceCode.getText(list)) },
        });
      },
    };
  },
});
