import type { EngineInterface, Register } from "claude-code";

// One colour per model family, matched against the model id or alias that
// `/model` shows.
export const FAMILIES = [
  { match: /fable/i, name: "Fable", color: "#3B82F6" },
  { match: /opus/i, name: "Opus", color: "#D9481C" },
  { match: /haiku/i, name: "Haiku", color: "#22A35A" },
  { match: /sonnet/i, name: "Sonnet", color: "#E5B700" },
] as const;

export const familyOf = (model: string) => FAMILIES.find((f) => f.match.test(model)) ?? null;

const currentFamily = async ($: EngineInterface) => familyOf(await $.session.model());

export const register: Register = (on) => {
  // A model switch redraws the tags; a new prompt catches any switch made
  // some other way.
  on("config.set", { key: "model" }, async ($, e, next) => {
    const set = await next(e);
    $.ui.invalidate("ui.render");
    return set;
  });

  on("prompt.submit", async ($, e, next) => {
    $.ui.invalidate("ui.render");
    return next(e);
  });

  on("ui.render", { component: "PromptHint" }, async ($, e, next) => {
    const [family, drawn] = await Promise.all([currentFamily($), next(e)]);
    if (!family) return drawn;

    const { Box, Text } = $.ui.resolve(e);

    return (
      <Box flexDirection="row">
        <Text color={family.color} weight="semibold">
          ● {family.name}
          {"  "}
        </Text>
        {drawn}
      </Box>
    );
  });

  on("ui.render", { component: "Spinner" }, async ($, e, next) => {
    const [family, drawn] = await Promise.all([currentFamily($), next(e)]);
    if (!family) return drawn;

    const { Box, Text } = $.ui.resolve(e);

    return (
      <Box flexDirection="row">
        <Text color={family.color}>● </Text>
        {drawn}
      </Box>
    );
  });
};
