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

// The session's id, which `claude --resume` takes, with control characters
// removed; null when the read is refused.
const sessionIdOf = async ($: EngineInterface) => {
  const id = await $.session.id().catch(() => null);
  // oxlint-disable-next-line no-control-regex -- the point is to remove them
  return id === null ? null : id.replace(/[\u0000-\u001f\u007f-\u009f]/g, "") || null;
};

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

  // A /clear, /resume or fork moves the process to another session id
  // without a `session.start`.
  on("classic.SessionStart", async ($, e, next) => {
    $.ui.invalidate("ui.render");
    return next(e);
  });

  // One row: the model's tag, the engine's own hint line with its mode pills,
  // and the session id. The terminal draws the id as the line's `tail`, cut
  // at the row's edge before any pill is; desktop draws no `tail`, so the id
  // follows the tag there.
  on("ui.render", { component: "PromptHint" }, async ($, e, next) => {
    const [family, session] = await Promise.all([currentFamily($), sessionIdOf($)]);
    const label = session === null ? null : `session ${session}`;
    const isTail = e.surface === "terminal" && label !== null;
    const drawn = await next(isTail ? { ...e, props: { ...e.props, tail: label } } : e);
    if (!family && (label === null || isTail)) return drawn;

    const { Box, Text } = $.ui.resolve(e);

    return (
      <Box flexDirection="row">
        {family && (
          <Text color={family.color} weight="semibold">
            ● {family.name}
            {"  "}
          </Text>
        )}
        {label !== null && !isTail && (
          <Text dimColor>
            {family ? `· ${label}` : label}
            {"  "}
          </Text>
        )}
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
