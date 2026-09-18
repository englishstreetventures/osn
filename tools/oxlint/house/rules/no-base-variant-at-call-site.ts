/**
 * `base:` is Tailwind's `:where(&)` variant, and in this repo it means "this is
 * a component's own default, so a caller's utility beats it". That is only true
 * when the caller's utility is **plain**.
 *
 * Two `base:` utilities on the same property have the same specificity — zero —
 * so the cascade falls through to source order, which here is the order
 * Tailwind emitted the rules in. That is neither the order of the `class`
 * attribute nor anything visible at the call site, so the loser is decided
 * somewhere nobody is looking.
 *
 * It cost nine `Modal` call sites across three cire apps before anything
 * noticed, the worst of them the consent preferences dialog: it asked for
 * `base:max-w-lg` and `base:bg-bg` and got the component's `base:max-w-ui-sm`
 * and `base:bg-ui-surface-raised`, because `.base\:max-w-ui-sm` happens to be
 * emitted later. 480px instead of 512px, on the wrong surface, with every
 * string assertion in the suite still green.
 *
 * Scope is two conditions, and both are needed.
 *
 * The tag must start upper-case: `base:` on a plain `<div>` is a component
 * styling its own markup, which is the entire point of the variant.
 *
 * And the component must be **ours** — imported from `@shared/ui`,
 * `@osn/auth-ui` or `@cire/ui`, or through a relative path. A wrapper passing
 * `base:fixed` down to Kobalte's `Dialog.Overlay` is not a tie at all: Kobalte
 * sets no `base:` defaults, so the wrapper is declaring the zero-specificity
 * default that ITS consumer will override. Without this half the rule reports
 * 199 sites, essentially every component in the shared layers, and says nothing
 * true about any of them.
 */

import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/** Import sources whose components carry `base:` defaults of their own. */
const OURS = /^(@shared\/ui|@osn\/auth-ui|@cire\/ui)(\/|$)|^\.{1,2}\//;

/** A JSX tag name that starts upper-case is a component, not an element. */
function isComponentName(name: ESTree.JSXElementName): boolean {
  if (name.type === "JSXIdentifier") return /^[A-Z]/.test(name.name);
  // `<Foo.Bar>` — a member expression is always a component.
  return name.type === "JSXMemberExpression";
}

/** The binding a tag resolves to — `Dialog` for both `<Dialog>` and `<Dialog.Panel>`. */
function rootIdentifier(name: ESTree.JSXElementName): string {
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXMemberExpression") return rootIdentifier(name.object);
  return "";
}

/** A readable name for the message — `Modal`, `Dialog.Panel`. */
function componentName(name: ESTree.JSXElementName): string {
  if (name.type === "JSXIdentifier") return name.name;
  if (name.type === "JSXMemberExpression") {
    return `${componentName(name.object)}.${name.property.name}`;
  }
  return "component";
}

/**
 * The `base:` utilities in a class string, with any preceding variants intact
 * so the message quotes what was written (`md:base:p-0`, not `p-0`).
 */
function baseUtilities(value: string): string[] {
  return value.split(/\s+/).filter((token) => token.length > 0 && /(^|:)base:/.test(token));
}

/**
 * Static class text reachable from a JSX attribute value, however it is nested.
 *
 * `clsx(…)` and a conditional both carry classes, and `classList={{ "…": on }}`
 * carries them in the KEY, so each shape has to be walked rather than only the
 * bare string. An interpolated class is `require-static-classes`' problem and
 * this returns only the static chunks of a template.
 */
function classText(node: ESTree.Node | null | undefined, out: string[]): void {
  if (!node) return;
  switch (node.type) {
    case "Literal":
      if (typeof node.value === "string") out.push(node.value);
      return;
    case "TemplateLiteral":
      for (const quasi of node.quasis) out.push(quasi.value.raw);
      return;
    case "JSXExpressionContainer":
      classText(node.expression, out);
      return;
    case "ConditionalExpression":
      classText(node.consequent, out);
      classText(node.alternate, out);
      return;
    case "LogicalExpression":
      classText(node.left, out);
      classText(node.right, out);
      return;
    case "CallExpression":
      for (const argument of node.arguments) classText(argument, out);
      return;
    case "ArrayExpression":
      for (const element of node.elements) classText(element, out);
      return;
    case "ObjectExpression":
      for (const property of node.properties) {
        if (property.type === "Property") classText(property.key, out);
      }
      return;
    default:
      return;
  }
}

const CLASS_ATTRIBUTES = new Set(["class", "className", "classList"]);

/** Disallow the `base:` variant in a class passed to a component. */
export const noBaseVariantAtCallSiteRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow Tailwind's `base:` variant in a class passed to a component. `base:` compiles to `:where(&)` — zero specificity — so a component's defaults lose to a caller's PLAIN utility by design. A caller who writes `base:` too ties instead, and the tie is resolved by Tailwind's stylesheet order rather than by anything at the call site.",
    },
    messages: {
      baseAtCallSite:
        "`{{utility}}` is passed to <{{component}}>, and `base:` there does not do what it looks like. It compiles to `:where(…)`, the same zero specificity the component's own defaults have, so the two tie and Tailwind's stylesheet order decides — not this file. Drop the prefix: a plain utility wins every time.",
    },
  },
  createOnce(context) {
    /** Local binding name -> the module it was imported from, per file. */
    let importSources = new Map<string, string>();

    return {
      Program() {
        importSources = new Map();
      },

      ImportDeclaration(node: ESTree.ImportDeclaration) {
        const source = node.source.value;
        if (typeof source !== "string") return;
        for (const specifier of node.specifiers) {
          importSources.set(specifier.local.name, source);
        }
      },

      JSXAttribute(node: ESTree.JSXAttribute) {
        if (node.name.type !== "JSXIdentifier") return;
        if (!CLASS_ATTRIBUTES.has(node.name.name)) return;

        // The enclosing element decides whether this is a call site at all.
        const parent = node.parent;
        if (!parent || parent.type !== "JSXOpeningElement") return;
        if (!isComponentName(parent.name)) return;

        // …and whose component it is decides whether there is a tie to have.
        const source = importSources.get(rootIdentifier(parent.name));
        if (!source || !OURS.test(source)) return;

        const texts: string[] = [];
        classText(node.value, texts);

        for (const text of texts) {
          for (const utility of baseUtilities(text)) {
            context.report({
              node,
              messageId: "baseAtCallSite",
              data: { utility, component: componentName(parent.name) },
            });
          }
        }
      },
    };
  },
});
