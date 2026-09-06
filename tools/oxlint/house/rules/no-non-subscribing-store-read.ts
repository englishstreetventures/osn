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

/**
 * The name a function is bound to at its declaration site: its own `id` for a
 * `function foo() {}`, the identifier it is assigned/declared into for a
 * `const foo = () => {}` / `foo = () => {}` / `{ foo: () => {} }`, or the key
 * of a class method/field arrow (`class C { peekCachedTasks() {} }` /
 * `class C { peekCachedTasks = () => {} }`). `null` for a genuinely anonymous
 * function — an inline callback passed as an argument.
 */
function boundName(fn: FunctionLike): string | null {
  if (fn.id !== null) return fn.id.name;
  const parent = fn.parent;
  if (parent.type === "VariableDeclarator" && parent.id.type === "Identifier") {
    return parent.id.name;
  }
  if (parent.type === "AssignmentExpression" && parent.left.type === "Identifier") {
    return parent.left.name;
  }
  if (parent.type === "Property" && !parent.computed && parent.key.type === "Identifier") {
    return parent.key.name;
  }
  if (
    (parent.type === "MethodDefinition" || parent.type === "TSAbstractMethodDefinition") &&
    !parent.computed &&
    parent.key.type === "Identifier"
  ) {
    return parent.key.name;
  }
  if (
    (parent.type === "PropertyDefinition" || parent.type === "TSAbstractPropertyDefinition") &&
    !parent.computed &&
    parent.key.type === "Identifier"
  ) {
    return parent.key.name;
  }
  return null;
}

/**
 * The nearest enclosing NAMED function, skipping over anonymous callbacks
 * (`.filter(...)`, `.map(...)`, a bare `if` block's arrow) so that a read
 * nested inside one is still judged by the named function it lives in.
 * `null` when the node sits at the top level, or every enclosing function is
 * itself anonymous.
 */
function enclosingNamedFunction(node: ESTree.Node): FunctionLike | null {
  let current: ESTree.Node | null = node.parent;
  while (current !== null && current.type !== "Program") {
    if (isFunctionLike(current) && boundName(current) !== null) return current;
    current = current.parent;
  }
  return null;
}

const exemptNamePattern = /^(peekCached|hasCached)[A-Z]/;

/**
 * True when `fn` sits at module top level and is exported by name: its own
 * ancestor chain reaches an `ExportNamedDeclaration` and then `Program`
 * without passing through another function first. A same-named helper
 * defined *inside* some other function (a local memo, a nested arrow) does
 * not qualify — the outer function is what actually executes on a cold
 * cache, and it is not one of the two exempt shapes just because something
 * inside it happens to be named `peekCachedXxx`.
 */
function isTopLevelExported(fn: FunctionLike): boolean {
  let current: ESTree.Node | null = fn.parent;
  let exported = false;
  while (current !== null) {
    if (isFunctionLike(current)) return false;
    if (current.type === "ExportNamedDeclaration") exported = true;
    if (current.type === "Program") return exported;
    current = current.parent;
  }
  return false;
}

/**
 * Deliberately non-subscribing reads live only in a `peekCached*`/`hasCached*`
 * function that is itself exported at module top level — the shape every
 * legitimate read in the organiser stores actually takes. The name check is
 * anchored on a capital right after the prefix (`peekCachedTasks`, not a
 * bare `startsWith("peekCached")`) so a name that only coincidentally shares
 * the same letters doesn't slip through, and the top-level check keeps a
 * local helper — nested inside some other, non-exempt function — from
 * inheriting an exemption its *name* suggests but its position doesn't
 * earn. This is a purely syntactic, name-based check: a top-level exported
 * `peekCached*` function whose body doesn't actually behave like one (see
 * the `peekCachedTasksReactively` fixture) is a known limit, not something
 * this rule can see past.
 */
function isExemptRead(node: ESTree.Node): boolean {
  const fn = enclosingNamedFunction(node);
  if (fn === null) return false;
  const name = boundName(fn);
  return name !== null && exemptNamePattern.test(name) && isTopLevelExported(fn);
}

/** True when `node` is a plain (non-optional, non-computed) call to
 *  `cache.get(...)`. */
function isCacheGetCall(node: ESTree.Node): node is ESTree.CallExpression {
  if (node.type !== "CallExpression") return false;
  const callee = node.callee;
  if (callee.type !== "MemberExpression" || callee.computed) return false;
  if (callee.object.type !== "Identifier" || callee.object.name !== "cache") return false;
  if (callee.property.type !== "Identifier" || callee.property.name !== "get") return false;
  return true;
}

/** True when `statement` is `if (!<name>) return …;` (return value, if any,
 *  ignored) — an early exit guarding every statement after it on `<name>`
 *  being non-null. */
function isNegatedReturnGuard(statement: ESTree.Statement, name: string): boolean {
  if (statement.type !== "IfStatement") return false;
  const test = statement.test;
  if (test.type !== "UnaryExpression" || test.operator !== "!") return false;
  if (test.argument.type !== "Identifier" || test.argument.name !== name) return false;
  const consequent = statement.consequent;
  if (consequent.type === "ReturnStatement") return true;
  return (
    consequent.type === "BlockStatement" &&
    consequent.body.length === 1 &&
    consequent.body[0].type === "ReturnStatement"
  );
}

/** The statement list a `BlockStatement`/`Program` node owns — the two shapes
 *  that can hold a `const <x> = cache.get(...)` declaration and a guard
 *  alongside it. */
function statementListOf(node: ESTree.Node): readonly ESTree.Node[] | null {
  if (node.type === "Program" || node.type === "BlockStatement") return node.body;
  return null;
}

interface CacheGetBinding {
  /** The argument passed to `cache.get(...)` at the binding site, used to
   *  reconstruct the id text in the diagnostic. `undefined` when the call
   *  was written with no argument at all. */
  idArgument: ESTree.Node | undefined;
  /** Whether an earlier `if (!<name>) return …` sibling statement guards the
   *  binding before it reaches the read under inspection. */
  guarded: boolean;
}

/**
 * Walk outward from `node` through its enclosing blocks — stopping at the
 * nearest enclosing function boundary, since a `const` binding never crosses
 * one — looking for a `const <name> = cache.get(<id>)` declared in an
 * earlier statement of the same or an enclosing block, and for an earlier
 * `if (!<name>) return` guard alongside it. This is deliberately
 * order-insensitive only in the sense that it doesn't model reassignment or
 * shadowing beyond that walk: every organiser store declares `entry` once,
 * with `const`, and never reassigns it, so a straightforward "does an
 * earlier sibling statement do this" scan is enough to match the real code
 * without building a scope resolver.
 */
function resolveCacheGetBinding(node: ESTree.Node, name: string): CacheGetBinding | null {
  let child: ESTree.Node = node;
  let current: ESTree.Node | null = node.parent;
  let idArgument: ESTree.Node | undefined;
  let found = false;
  let guarded = false;

  while (current !== null) {
    const body = statementListOf(current);
    if (body !== null) {
      const index = body.indexOf(child);
      if (index !== -1) {
        for (let i = 0; i < index; i++) {
          const statement = body[i];
          if (!found && statement.type === "VariableDeclaration" && statement.kind === "const") {
            for (const declarator of statement.declarations) {
              if (
                declarator.id.type === "Identifier" &&
                declarator.id.name === name &&
                declarator.init !== null &&
                isCacheGetCall(declarator.init)
              ) {
                found = true;
                idArgument = declarator.init.arguments[0];
              }
            }
          }
          if (
            !guarded &&
            statement.type === "IfStatement" &&
            isNegatedReturnGuard(statement, name)
          ) {
            guarded = true;
          }
        }
      }
    }
    if (isFunctionLike(current)) break;
    child = current;
    current = current.parent;
  }

  return found ? { idArgument, guarded } : null;
}

/** Disallow a non-minting, non-subscribing cache read outside the two function
 *  shapes where it's deliberate. */
export const noNonSubscribingStoreReadRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow `cache.get(id)?.accessor()` — directly, or split across an intermediate `const entry = cache.get(id)` — outside a peekCached*/hasCached* function in a `*-store.ts` organiser cache. Unlike `entryFor(id).accessor()`, this form does not mint the cache entry: when it is absent the read short-circuits before the accessor runs, so a tracked read here registers zero dependencies and never re-runs once the entry is created.",
    },
    messages: {
      nonSubscribingStoreRead:
        "`cache.get({{id}})?.{{accessor}}()` doesn't subscribe: when the entry for {{id}} is absent, the read short-circuits before `{{accessor}}` ever runs, so a tracked read here registers no dependency and never re-runs once the entry is created. Use `entryFor({{id}}).{{accessor}}()` — the subscribing form — instead. This non-minting read is only legitimate inside a `peekCached*`/`hasCached*` function.",
    },
  },
  createOnce(context) {
    return {
      CallExpression(node) {
        // A setter (`entry.setEvents(patch)`) always takes an argument; every
        // signal-accessor read in these stores (`tasks()`, `vendors()`, …) is
        // called with none. That arity is what tells a write apart from a
        // read here, and it's what keeps a guarded setter path like
        // `patchCachedEvent` (`const entry = cache.get(id); if (!entry)
        // return; entry.setEvents(...)`) unflagged without special-casing
        // the accessor name.
        if (node.arguments.length !== 0) return;

        const callee = node.callee;
        if (callee.type !== "MemberExpression" || callee.computed) return;
        if (callee.property.type !== "Identifier") return;
        const accessor = callee.property.name;

        let idArgument: ESTree.Node | undefined;

        if (callee.optional) {
          // `cache.get(id)?.accessor()` — the direct chain — or
          // `entry?.accessor()` where `entry` was bound by an earlier
          // `const entry = cache.get(id)`. Either way the optional chain is
          // what lets a cold cache short-circuit before `accessor` runs, so
          // no guard is required on top of it.
          const object = callee.object;
          if (isCacheGetCall(object)) {
            idArgument = object.arguments[0];
          } else if (object.type === "Identifier") {
            const binding = resolveCacheGetBinding(node, object.name);
            if (binding === null) return;
            idArgument = binding.idArgument;
          } else {
            return;
          }
        } else {
          // The non-optional intermediate-variable form, `entry.accessor()`,
          // is the same bug ONLY when `entry` was guarded by a preceding
          // `if (!entry) return` — without the `?.`, that guard is the only
          // thing standing between a cold cache and a crash, and it bails
          // out before `accessor` ever runs, same as the optional chain
          // does. An unguarded `entry.accessor()` is an ordinary read off a
          // value already known to exist (e.g. `entryFor(id).accessor()`,
          // which mints the entry and is exactly the subscribing form this
          // rule steers readers toward) and must stay silent.
          const object = callee.object;
          if (object.type !== "Identifier") return;
          const binding = resolveCacheGetBinding(node, object.name);
          if (binding === null || !binding.guarded) return;
          idArgument = binding.idArgument;
        }

        if (isExemptRead(node)) return;

        const id = idArgument === undefined ? "id" : context.sourceCode.getText(idArgument);
        context.report({
          node,
          messageId: "nonSubscribingStoreRead",
          data: { id, accessor },
        });
      },
    };
  },
});
