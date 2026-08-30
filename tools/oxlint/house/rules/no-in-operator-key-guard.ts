import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

type FunctionLike = ESTree.Function | ESTree.ArrowFunctionExpression;

const functionKinds: ReadonlySet<string> = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
  "TSDeclareFunction",
  "TSEmptyBodyFunctionExpression",
]);

function isFunctionLike(node: ESTree.Node): node is FunctionLike {
  return functionKinds.has(node.type);
}

/** The nearest enclosing function, or null when the node sits at the top level. */
function enclosingFunction(node: ESTree.Node): FunctionLike | null {
  let current: ESTree.Node | null = node.parent;
  while (current !== null && current.type !== "Program") {
    if (isFunctionLike(current)) return current;
    current = current.parent;
  }
  return null;
}

/** The parameter name a `x is T` / `asserts x is T` return type narrows, if there is one. */
function narrowedParameterName(fn: FunctionLike): string | null {
  const annotation = fn.returnType?.typeAnnotation;
  if (annotation === undefined || annotation === null) return null;
  if (annotation.type !== "TSTypePredicate") return null;
  const { parameterName } = annotation;
  return parameterName.type === "Identifier" ? parameterName.name : null;
}

/** Disallow narrowing a type-predicate's own parameter with the `in` operator. */
export const noInOperatorKeyGuardRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow deciding a type predicate with `key in MAP`. `in` walks the prototype chain, so inherited Object.prototype members satisfy the guard. Use Object.hasOwn(MAP, key).",
    },
    messages: {
      inOperatorKeyGuard:
        "`{{name}} in …` walks the prototype chain, so `constructor`, `toString` and `__proto__` pass and this guard then claims an inherited Object.prototype member is a real entry. Test `Object.hasOwn(map, {{name}})` instead.",
    },
  },
  createOnce(context) {
    return {
      BinaryExpression(node) {
        if (node.operator !== "in" || node.left.type !== "Identifier") return;
        const fn = enclosingFunction(node);
        if (fn === null || narrowedParameterName(fn) !== node.left.name) return;
        context.report({
          node,
          messageId: "inOperatorKeyGuard",
          data: { name: node.left.name },
        });
      },
    };
  },
});
