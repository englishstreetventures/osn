import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { Effort, EffortLevel } from "../types";

// One colour per model family, matched against the model id or alias that
// `/model` shows.
export const FAMILIES = [
  { match: /fable/i, name: "Fable", color: "#3B82F6" },
  { match: /opus/i, name: "Opus", color: "#D9481C" },
  { match: /haiku/i, name: "Haiku", color: "#22A35A" },
  { match: /sonnet/i, name: "Sonnet", color: "#E5B700" },
] as const;

export const familyOf = (model: string) => FAMILIES.find((f) => f.match.test(model)) ?? null;

const LEVELS: readonly EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];

// The main thread's last request: its model and effort level. Held by the
// host for the session so a hot reload keeps it; a value stored under another
// tag reads as absent.
// oxlint-disable-next-line anti-slop/no-shape-in-symbol-names -- `shape` is the engine's own name for an atom's tag
const effort = atom({ plugin: "prompt-row", key: "effort" } as const, null, { shape: "effort-1" });

const BAR_CELLS = 10;

const currentFamily = async ($: EngineInterface) => familyOf(await $.session.model());

// A text with its control characters removed. Another plugin can rewrite
// every text the row draws, and the engine refuses a tree holding one, which
// would lose the whole row.
// oxlint-disable-next-line no-control-regex -- the point is to remove them
const printable = (text: string) => text.replace(/[\u0000-\u001f\u007f-\u009f]/g, "");

// The session's id, which `claude --resume` takes; null when the read is
// refused.
const sessionIdOf = async ($: EngineInterface) => {
  const id = await $.session.id().catch(() => null);
  return id === null ? null : printable(id) || null;
};

// The context window's fill as a whole percentage, null before the first
// reading of the live window or when the read is refused.
const percentOf = async ($: EngineInterface) => {
  const usage = await $.session.usage().catch(() => null);
  return usage?.context.percent ?? null;
};

const levelOf = (value: unknown): EffortLevel | null =>
  LEVELS.find((level) => level === value) ?? null;

const redraw = ($: EngineInterface) => $.ui.invalidate("ui.render");

// Keeps the main thread's model and level, writing only when either changed;
// a failed read or write leaves the row without the level.
const record = async ($: EngineInterface, seen: Effort) => {
  try {
    const held = await read($, effort);
    if (held?.model !== seen.model || held.level !== seen.level) {
      await update($, effort, () => seen);
    }
  } catch {
    // The level goes undrawn until the next request records it.
  }
};

// The parts of the engine's hint text, which arrives as one string read the
// way a screen reader reads it: the agents count, and what is left once the
// permission mode's key hint is dropped. The terminal draws the mode's pill
// itself, ahead of the row.
const AGENTS = /←\s*\d+\s+agents?/;
const KEY_HINT = /\(shift\+tab to cycle\)/i;

const hintParts = (raw: string) => {
  const hint = printable(raw);
  const agents = hint.match(AGENTS)?.[0] ?? null;
  let rest = hint.replace(KEY_HINT, "");
  if (agents !== null) rest = rest.replace(agents, "");
  const left = rest
    .split("·")
    .map((piece) => piece.trim())
    .filter(Boolean)
    .join(" · ");
  return { agents, rest: left === "" ? null : left };
};

export const register: Register = (on) => {
  // A model switch redraws the tags; a new prompt catches any switch made
  // some other way.
  on("config.set", { key: "model" }, async ($, e, next) => {
    const set = await next(e);
    redraw($);
    return set;
  });

  on("prompt.submit", async ($, e, next) => {
    redraw($);
    return next(e);
  });

  // A /clear, /resume or logout ends the session; the process may go on
  // under another id, with no `session.start`.
  on("session.end", async ($, e, next) => {
    const ended = await next(e);
    redraw($);
    return ended;
  });

  // A compaction empties the reading until the next response.
  on("session.compact", async ($, e, next) => {
    const compacted = await next(e);
    redraw($);
    return compacted;
  });

  on("session.measure", async ($, e, next) => {
    const measured = await next(e);
    if (e.changed.includes("context")) redraw($);
    return measured;
  });

  // Every model request, main and subagent, passes through untouched, and the
  // hook waits on nothing of its own: a main-thread request's model and level
  // are recorded beside it, never ahead of it, so a slow or failing state
  // call costs the row its level and never holds the request. After the
  // response, the row is drawn again for the new reading.
  on("turn.step", async function* ($, e, next) {
    const isMain = e.agentId === undefined;
    if (isMain) void record($, { model: e.model, level: levelOf(e.effort) });
    const result = yield* next(e);
    if (isMain) redraw($);
    return result;
  });

  // One row, drawn by the mod in place of the engine's hint text: the agents
  // count, the model's tag with its effort level, the context bar, the
  // session id, then whatever else the hint held. The engine's own line is a
  // block, so drawing beside it would put the mod's parts on a row of their
  // own.
  on("ui.render", { component: "PromptHint" }, async ($, e) => {
    const [family, session, percent, held] = await Promise.all([
      currentFamily($),
      sessionIdOf($),
      percentOf($),
      read($, effort),
    ]);
    const { agents, rest } = hintParts(e.props.hint);
    const level =
      family && held && familyOf(held.model)?.name === family.name ? levelOf(held.level) : null;
    // A reading outside 0..100 fills the bar to an end rather than throwing,
    // which would lose the whole row.
    const full = Math.min(BAR_CELLS, Math.max(0, Math.floor((percent ?? 0) / 10)));
    const cells = "▰".repeat(full) + "▱".repeat(BAR_CELLS - full);

    const { Box, Text } = $.ui.resolve(e);
    const parts = [
      agents !== null && <Text dimColor>{agents}</Text>,
      family && (
        <Text color={family.color} weight="semibold">
          ● {family.name}
          {level === null ? "" : ` · ${level}`}
        </Text>
      ),
      percent !== null &&
        (percent >= 70 ? (
          <Text color={percent >= 85 ? "error" : "warning"}>
            {cells} {percent}%
          </Text>
        ) : (
          <Text dimColor>
            {cells} {percent}%
          </Text>
        )),
      session !== null && <Text dimColor>session {session}</Text>,
      rest !== null && <Text dimColor>{rest}</Text>,
    ].filter(Boolean);

    return (
      <Box flexDirection="row">
        {parts.flatMap((shown, at) => (at === 0 ? [shown] : [<Text dimColor> | </Text>, shown]))}
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
