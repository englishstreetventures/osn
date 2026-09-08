import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

/**
 * Node types that can carry a leading doc block. `export const x` is reached
 * through the export, not the declaration inside it, because the declaration's
 * preceding token is `export` and no comment sits between the two.
 */
const declarationTypes = [
  "ExportNamedDeclaration",
  "ExportDefaultDeclaration",
  "FunctionDeclaration",
  "VariableDeclaration",
  "ClassDeclaration",
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration",
  "TSEnumDeclaration",
  "TSDeclareFunction",
  "MethodDefinition",
  "PropertyDefinition",
] as const;

/** A `/** … *\/` block, as opposed to a `//` line or a plain `/* … *\/`. */
function isDocBlock(comment: ESTree.Comment): boolean {
  return comment.type === "Block" && comment.value.startsWith("*");
}

/** Disallow more than one doc block leading the same declaration. */
export const noStackedDocBlockRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow stacking two or more doc blocks in front of one declaration. Only the last one is attached, so the earlier blocks describe nothing — an editor shows the reader the wrong text, and whatever the first block was really documenting has silently lost its comment.",
    },
    messages: {
      stackedDocBlock:
        "This declaration has {{count}} doc blocks in front of it. Only the last is attached to it, so this one documents nothing and a reader hovering the declaration never sees it. Merge them, or move this block to whatever it was describing.",
    },
  },
  createOnce(context) {
    const visitDeclaration = (node: ESTree.Node) => {
      const leading = context.sourceCode.getCommentsBefore(node).filter(isDocBlock);
      // A block opening the file documents the module, not the declaration it
      // happens to precede, so it is never the stacked one.
      const stacked = leading[0]?.loc.start.line === 1 ? leading.slice(1) : leading;
      if (stacked.length < 2) return;
      context.report({
        node: stacked[0]!,
        messageId: "stackedDocBlock",
        data: { count: String(stacked.length) },
      });
    };

    return Object.fromEntries(declarationTypes.map((type) => [type, visitDeclaration]));
  },
});
