import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const functionKinds: ReadonlySet<string> = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

/**
 * Whether code at `node` runs during module evaluation.
 *
 * A function body, a default parameter and an instance class-field initialiser
 * all run later, when something calls or constructs them. A static field or a
 * static block runs while the module loads, as does everything outside any of
 * these. An immediately invoked function also runs at load, but this walk sees
 * a function and stops: that is a known gap, not a guarantee.
 */
function runsAtModuleLoad(node: ESTree.Node): boolean {
  let child: ESTree.Node = node;
  let current: ESTree.Node | null = node.parent;
  while (current !== null && current.type !== "Program") {
    if (functionKinds.has(current.type)) return false;
    if (current.type === "PropertyDefinition" && !current.static && current.value === child) {
      return false;
    }
    child = current;
    current = current.parent;
  }
  return true;
}

/** `process` or `globalThis.process`. */
function isProcessIdentifier(node: ESTree.Node): boolean {
  if (node.type === "Identifier") return node.name === "process";
  return (
    node.type === "MemberExpression" &&
    !node.computed &&
    node.object.type === "Identifier" &&
    node.object.name === "globalThis" &&
    node.property.type === "Identifier" &&
    node.property.name === "process"
  );
}

/** `process.env` or `process["env"]`, optional chaining included. */
function isProcessEnv(node: ESTree.MemberExpression): boolean {
  if (!isProcessIdentifier(node.object)) return false;
  const { property } = node;
  if (!node.computed) return property.type === "Identifier" && property.name === "env";
  return property.type === "Literal" && property.value === "env";
}

/** `const { env } = process` (or `{ env: e }`). */
function destructuresEnv(node: ESTree.VariableDeclarator): boolean {
  if (node.init === null || node.init === undefined || !isProcessIdentifier(node.init)) {
    return false;
  }
  if (node.id.type !== "ObjectPattern") return false;
  return node.id.properties.some(
    (p) =>
      p.type === "Property" &&
      ((p.key.type === "Identifier" && p.key.name === "env") ||
        (p.key.type === "Literal" && p.key.value === "env")),
  );
}

/** Disallow reading `process.env` while a Worker module is being evaluated. */
export const noModuleScopeProcessEnvRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow reading process.env at module scope in Worker source. workerd fills process.env on first access inside a request or cron handler, never during module evaluation, so a module-scope read sees an empty object.",
    },
    messages: {
      moduleScopeProcessEnv:
        "`process.env` is read while the module loads. On workerd it is empty then (it fills on first access inside a handler), so this value is always the fallback in a deployed Worker. Read the handler's `env` binding, or move the read into a function that runs per request.",
    },
  },
  createOnce(context) {
    return {
      MemberExpression(node) {
        if (!isProcessEnv(node) || !runsAtModuleLoad(node)) return;
        context.report({ node, messageId: "moduleScopeProcessEnv" });
      },
      VariableDeclarator(node) {
        if (!destructuresEnv(node) || !runsAtModuleLoad(node)) return;
        context.report({ node, messageId: "moduleScopeProcessEnv" });
      },
    };
  },
});
