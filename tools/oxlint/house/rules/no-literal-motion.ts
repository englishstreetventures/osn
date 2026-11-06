/**
 * A motion's duration, delay and curve come from a token chosen by its job:
 * the shared `--ui-dur-*` and `--ui-ease-*` (wiki/shared/design-tokens.md
 * §Motion), or an app's own ladder, as cire's `--dur-*` and `--ease-*`. A
 * number written where it is used follows none of them. Cire's ladder shortens
 * at a desk (`@media (pointer: fine)`), and a written `200ms` keeps the touch
 * pace there; a token whose value changes leaves every literal of its job
 * behind; and two motions with one job drift apart one edit at a time.
 *
 * What counts as a literal is decided in `scripts/lib/motion-literals.ts`,
 * which `scripts/check-motion-literals.ts` also runs over the `.css` and
 * `.astro` files oxlint never parses, so the two halves agree. This rule feeds
 * it every string in a file:
 *
 * - a string or template that holds a brace or a `transition:`/`animation:`
 *   declaration is read as CSS, one finding per declaration (an injected
 *   stylesheet such as `Modal`'s, a boot script's style strings); an
 *   interpolated part is never judged;
 * - any other string is read as a class string, one finding per class token
 *   (JSX `class`, `clsx` arguments, `classList` keys, template quasis);
 * - a style object's motion property (`transition`, `"transition-duration"`,
 *   `animationDuration`), and `x.style.transition = …` or
 *   `x.style.setProperty("transition", …)`, as one declaration.
 *
 * The file's path decides whether Tailwind's `ease-out` and `ease-in-out` read
 * the app's own theme token (cire) or Tailwind's stock curve (everywhere else).
 *
 * A literal no token's job fits stays with its reason: inside CSS,
 * `/* motion-literal: <reason> *\/` in the declaration, which keeps that
 * declaration and no other; anywhere else, the house suppression with the
 * reason after `--`, which keeps every report on the next line.
 */

import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

import {
  checkDeclaration,
  checkString,
  formatLiterals,
  MOTION_ADVICE,
  motionProperty,
  themeEasingsFor,
} from "../../../../scripts/lib/motion-literals.ts";

/** A template literal's text, each interpolation standing in as a token reference. */
function templateText(node: ESTree.TemplateLiteral): string {
  return node.quasis
    .map((quasi) => quasi.value.cooked ?? quasi.value.raw)
    .join(" var(--interpolated) ");
}

/** The text of a string or template node, or undefined for anything else. */
function stringValue(node: ESTree.Node | null | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  if (node.type === "TemplateLiteral") return templateText(node);
  return undefined;
}

/** A property or member name written as an identifier or a string. */
function staticName(node: ESTree.Node, computed: boolean): string | undefined {
  if (!computed && node.type === "Identifier") return node.name;
  if (node.type === "Literal" && typeof node.value === "string") return node.value;
  return undefined;
}

/** Disallow a literal duration, delay or easing where a motion token belongs. */
export const noLiteralMotionRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow a literal duration, delay or easing in a transition or animation, a Tailwind duration-*, delay-*, ease-linear or arbitrary motion class, a named ease-* that reads Tailwind's stock curve, and `transition: all`. A motion takes its timing from a token chosen by its job, so it follows the app's pace.",
    },
    messages: {
      literal: "`{{text}}` writes {{literals}}. {{advice}}",
    },
  },
  createOnce(context) {
    let themeEasings = themeEasingsFor("");

    const report = (node: ESTree.Node, text: string, literals: readonly string[]): void => {
      context.report({
        node,
        messageId: "literal",
        data: { text, literals: formatLiterals(literals), advice: MOTION_ADVICE },
      });
    };

    /** Report one declaration written in code. */
    const declaration = (node: ESTree.Node, property: string, value: string): void => {
      const literals = checkDeclaration(property, value);
      if (literals.length > 0) report(node, `${property}: ${value}`, literals);
    };

    /** Report every literal in a string or template node. */
    const text = (node: ESTree.Node, value: string): void => {
      for (const finding of checkString(value, themeEasings)) {
        report(node, finding.text, finding.literals);
      }
    };

    return {
      before() {
        themeEasings = themeEasingsFor(context.filename);
      },

      Literal(node) {
        if (typeof node.value === "string") text(node, node.value);
      },

      TemplateLiteral(node) {
        text(node, templateText(node));
      },

      Property(node) {
        if (node.type !== "Property" || node.parent.type !== "ObjectExpression") return;
        const name = staticName(node.key, node.computed);
        const property = name === undefined ? undefined : motionProperty(name);
        const value = stringValue(node.value);
        if (property !== undefined && value !== undefined) declaration(node.value, property, value);
      },

      AssignmentExpression(node) {
        const target = node.left;
        if (target.type !== "MemberExpression") return;
        const owner = target.object;
        if (
          owner.type !== "MemberExpression" ||
          staticName(owner.property, owner.computed) !== "style"
        ) {
          return;
        }
        const name = staticName(target.property, target.computed);
        const property = name === undefined ? undefined : motionProperty(name);
        const value = stringValue(node.right);
        if (property !== undefined && value !== undefined) declaration(node.right, property, value);
      },

      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== "MemberExpression") return;
        if (staticName(callee.property, callee.computed) !== "setProperty") return;
        const [first, second] = node.arguments;
        const name = stringValue(first);
        const property = name === undefined ? undefined : motionProperty(name);
        const value = stringValue(second);
        if (property !== undefined && value !== undefined && second) {
          declaration(second, property, value);
        }
      },
    };
  },
});
