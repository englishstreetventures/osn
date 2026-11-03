import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/**
 * A callee whose name says it only reads. Two reads in a row that share no
 * data can run together; a write, a gate (`verify`, `rateLimit`, `assert`) or an
 * unnamed call can depend on order in ways the source does not show, so the
 * rule leaves those alone.
 */
const READ_NAME = /^(get|find|list|load|fetch|read|query|count|select|lookup|resolve|has|is)[A-Z_]/;

type Awaited = {
  /** The `await x` or `yield* x` expression. */
  expression: ESTree.Node;
  /** Names the statement binds, empty for a bare expression statement. */
  bound: readonly string[];
};

/** Last identifier of `a.b.c(...)` or `a(...)`. */
function calleeName(call: ESTree.Node): string | null {
  if (call.type !== "CallExpression") return null;
  const { callee } = call;
  if (callee.type === "Identifier") return callee.name;
  if (
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier"
  ) {
    return callee.property.name;
  }
  return null;
}

/** The operand of `await x` or `yield* x`, or null for anything else. */
function awaitedOperand(node: ESTree.Node | null | undefined): ESTree.Node | null {
  if (node === null || node === undefined) return null;
  if (node.type === "AwaitExpression") return node.argument;
  if (node.type === "YieldExpression" && node.delegate) return node.argument ?? null;
  return null;
}

function bindingNames(pattern: ESTree.Node, into: string[]): void {
  switch (pattern.type) {
    case "Identifier":
      into.push(pattern.name);
      return;
    case "ObjectPattern":
      for (const p of pattern.properties) {
        bindingNames(p.type === "Property" ? p.value : p.argument, into);
      }
      return;
    case "ArrayPattern":
      for (const element of pattern.elements) {
        if (element !== null) bindingNames(element, into);
      }
      return;
    case "AssignmentPattern":
      bindingNames(pattern.left, into);
      return;
    case "RestElement":
      bindingNames(pattern.argument, into);
      return;
    default:
  }
}

/** `const x = await read(...)` or `await read(...)` as a whole statement. */
function readAwaited(statement: ESTree.Node): Awaited | null {
  if (statement.type === "ExpressionStatement") {
    const operand = awaitedOperand(statement.expression);
    if (operand === null) return null;
    return { expression: operand, bound: [] };
  }
  if (statement.type !== "VariableDeclaration" || statement.declarations.length !== 1) return null;
  const [declarator] = statement.declarations;
  if (declarator === undefined) return null;
  const operand = awaitedOperand(declarator.init);
  if (operand === null) return null;
  const bound: string[] = [];
  bindingNames(declarator.id, bound);
  return { expression: operand, bound };
}

/** Whether any identifier under `node` is one of `names`. */
function mentions(node: unknown, names: ReadonlySet<string>): boolean {
  if (node === null || typeof node !== "object") return false;
  if (Array.isArray(node)) return node.some((child) => mentions(child, names));
  if ("type" in node && node.type === "Identifier" && "name" in node) {
    return typeof node.name === "string" && names.has(node.name);
  }
  for (const [key, child] of Object.entries(node)) {
    if (key === "parent" || key === "loc" || key === "range") continue;
    if (mentions(child, names)) return true;
  }
  return false;
}

function isRead(awaited: Awaited): boolean {
  const name = calleeName(awaited.expression);
  return name !== null && READ_NAME.test(name);
}

/** Disallow two adjacent awaited reads where the second ignores the first's result. */
export const noSequentialIndependentAwaitRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow awaiting two independent reads one after the other. The second read does not use the first's result, so the pair waits for the sum of two round trips where one would do.",
    },
    messages: {
      sequentialAwait:
        'This read does not use the result of the read above it, so the two wait one after the other. Start both, then wait once: `Promise.all([...])`, or `Effect.all([...], { concurrency: "unbounded" })` inside an Effect. If the order is a gate (the first read must settle, or fail, before the second runs), suppress this line and say which.',
    },
  },
  createOnce(context) {
    const check = (body: readonly ESTree.Node[]): void => {
      for (let i = 1; i < body.length; i += 1) {
        const previousStatement = body[i - 1];
        const statement = body[i];
        if (previousStatement === undefined || statement === undefined) continue;
        const previous = readAwaited(previousStatement);
        const current = readAwaited(statement);
        if (previous === null || current === null) continue;
        if (!isRead(previous) || !isRead(current)) continue;
        if (mentions(current.expression, new Set(previous.bound))) continue;
        context.report({ node: statement, messageId: "sequentialAwait" });
      }
    };
    return {
      BlockStatement(node) {
        check(node.body);
      },
      Program(node) {
        check(node.body);
      },
    };
  },
});
