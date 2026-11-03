import { defineRule } from "@oxlint/plugins";

/** Disallow `{ concurrency: 1 }`, which runs an Effect batch one item at a time. */
export const noSerialEffectConcurrencyRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Disallow `concurrency: 1` in shipped source. It makes `Effect.forEach` and `Effect.all` wait for each item in turn, which is the default and so only worth writing down to say the order matters.",
    },
    messages: {
      serialConcurrency:
        '`concurrency: 1` runs these one at a time. If the items are independent, use a bound that fits (`"unbounded"` for a handful, a number for a page). If the order is the point, suppress this line and say what depends on it.',
    },
  },
  createOnce(context) {
    return {
      Property(node) {
        const { key, value } = node;
        const named =
          (key.type === "Identifier" && key.name === "concurrency") ||
          (key.type === "Literal" && key.value === "concurrency");
        if (!named || value.type !== "Literal" || value.value !== 1) return;
        context.report({ node, messageId: "serialConcurrency" });
      },
    };
  },
});
