import type { On, TurnStepChunk, TurnStepInput, TurnStepResult } from "claude-code";
import { expect, test } from "claude-code/testing";

const HINT = {
  plugin: "prompt-row",
  component: "PromptHint",
  props: { isDraft: false, isWorking: false, hint: "? for shortcuts" },
} as const;

const SPINNER = {
  plugin: "prompt-row",
  component: "Spinner",
  props: { word: "Baking", message: null, suffix: "…", mode: "thinking" },
} as const;

const SESSION = "aef16703-ba2d-4d05-9570-0bab6be386ec";
const NEXT_SESSION = "11111111-2222-3333-4444-555555555555";

const CHUNK: TurnStepChunk = { kind: "text", index: 0, text: "hi" };
const RESULT: TurnStepResult = {
  turnId: "t1",
  index: 0,
  answer: "hi",
  toolUses: [],
  stopReason: "end_turn",
  usage: null,
};

// What the engine beneath the mod answers; each field can change mid-test.
// `session` and `percent` null mean the read is refused; `percent`
// undefined means no reading yet.
type Engine = {
  model: string;
  session: string | null;
  percent: number | null | undefined;
  steps: number;
};

// The engine beneath the mod: the model, the session id, the context window,
// a bottom for each event the mod passes on, and its own hint line, drawn
// with any `tail` a hook handed it after the word `tail:`.
const engine = (on: On, init: Partial<Engine> = {}): Engine => {
  const state: Engine = {
    model: "claude-opus-5-5",
    session: SESSION,
    percent: undefined,
    steps: 0,
    ...init,
  };
  on("session.model", () => ({ value: state.model }));
  on("session.id", () =>
    state.session === null ? { deny: "no session" } : { value: state.session },
  );
  on("session.usage", () =>
    state.percent === null
      ? { deny: "no usage" }
      : {
          value: {
            startedAt: 0,
            context: {
              window: 1_000_000,
              tokens: state.percent ?? undefined,
              percent: state.percent,
            },
            rateLimits: [],
          },
        },
  );
  on("session.end", (_, e) => ({ sessionId: e.sessionId }));
  on("session.measure", (_, e) => ({ changed: e.changed }));
  on("session.compact", () => ({ skip: "test" }));
  on("config.set", (_, e) => ({ value: e.value }));
  on("prompt.submit", (_, e) => ({ text: e.text }));
  on("turn.step", async function* () {
    state.steps += 1;
    yield CHUNK;
    return RESULT;
  });
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    const tail = "tail" in e.props ? e.props.tail : undefined;
    return <Text>{tail === undefined ? "engine" : `engine tail:${tail}`}</Text>;
  });
  return state;
};

type Found = { text: string; props: Record<string, unknown> };
type Drawing = { find: (q: { type: string; text: RegExp }) => Promise<Found | undefined> };

const engineLine = async (ui: Drawing) => (await ui.find({ type: "Text", text: /engine/ }))?.text;
const tagText = async (ui: Drawing) => (await ui.find({ type: "Text", text: /●/ }))?.text.trim();
const bar = (ui: Drawing) => ui.find({ type: "Text", text: /[▰▱]/ });

const step = (overrides: Partial<TurnStepInput> = {}): TurnStepInput => ({
  turnId: "t1",
  index: 0,
  model: "claude-opus-5-5",
  messageCount: 1,
  ...overrides,
});

// Raises one model request through the mod and reads its stream to the end.
const runStep = async (
  $: { turn: { step: (e: TurnStepInput) => AsyncGenerator<TurnStepChunk, TurnStepResult> } },
  e: TurnStepInput,
) => {
  const stream = $.turn.step(e);
  const chunks: TurnStepChunk[] = [];
  for (;;) {
    // oxlint-disable-next-line no-await-in-loop -- a stream is read one chunk at a time
    const read = await stream.next();
    if (read.done) return { chunks, result: read.value };
    chunks.push(read.value);
  }
};

const CASES = [
  ["claude-fable-5-1", "Fable", "#3B82F6"],
  ["claude-opus-5-5", "Opus", "#D9481C"],
  ["claude-haiku-5-5", "Haiku", "#22A35A"],
  ["sonnet", "Sonnet", "#E5B700"],
] as const;

for (const [model, name, color] of CASES) {
  test(`the hint line carries ${name} in its colour`, async ($, on) => {
    engine(on, { model });
    for (const surface of ["terminal", "desktop"] as const) {
      const ui = await $.ui.mount({ ...HINT, surface });
      const tag = await ui.find({ type: "Text", text: /●/ });
      expect(tag?.text.trim()).toBe(`● ${name}`);
      expect(tag?.props.color).toBe(color);
      expect(await engineLine(ui)).toMatch(/^engine/);
      await ui.unmount();
    }
  });
}

test("on the terminal the session id rides at the end of the engine's line", async ($, on) => {
  engine(on);
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  expect(await tagText(ui)).toBe("● Opus");
  expect(await engineLine(ui)).toBe(`engine tail:session ${SESSION}`);
  await ui.unmount();
});

test("on desktop the session id follows the tag", async ($, on) => {
  engine(on);
  const ui = await $.ui.mount({ ...HINT, surface: "desktop" });
  expect((await ui.find({ type: "Text", text: /session/ }))?.text.trim()).toBe(
    `session ${SESSION}`,
  );
  expect(await engineLine(ui)).toBe("engine");
  await ui.unmount();
});

test("a /clear redraws the row with the new session id", async ($, on) => {
  const world = engine(on);
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  expect(await engineLine(ui)).toBe(`engine tail:session ${SESSION}`);

  world.session = NEXT_SESSION;
  expect(await engineLine(ui)).toBe(`engine tail:session ${SESSION}`);
  await $.session.end({ reason: "clear", sessionId: SESSION, resume: { id: SESSION } });
  expect(await engineLine(ui)).toBe(`engine tail:session ${NEXT_SESSION}`);
  await ui.unmount();
});

test("an unknown model still shows the session id, with no dot", async ($, on) => {
  engine(on, { model: "some-other-model" });
  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await $.ui.mount({ ...HINT, surface });
    expect(await ui.find({ type: "Text", text: /●/ })).toBe(undefined);
    if (surface === "terminal") {
      expect(await engineLine(ui)).toBe(`engine tail:session ${SESSION}`);
    } else {
      expect((await ui.find({ type: "Text", text: /session/ }))?.text.trim()).toBe(
        `session ${SESSION}`,
      );
    }
    await ui.unmount();
  }
});

test("a refused session id leaves the tag and the engine line", async ($, on) => {
  engine(on, { session: null });
  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await $.ui.mount({ ...HINT, surface });
    expect(await tagText(ui)).toBe("● Opus");
    expect(await ui.find({ type: "Text", text: /session/ })).toBe(undefined);
    expect(await engineLine(ui)).toBe("engine");
    await ui.unmount();
  }
});

test("an unknown model, a refused session id and no usage leave the engine line alone", async ($, on) => {
  engine(on, { model: "some-other-model", session: null, percent: null });
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: /●/ })).toBe(undefined);
  expect(await bar(ui)).toBe(undefined);
  expect(await engineLine(ui)).toBe("engine");
  await ui.unmount();
});

test("control characters in the session id never reach the screen", async ($, on) => {
  engine(on, { session: "abc\u001b[31mdef" });
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  expect(await engineLine(ui)).toBe("engine tail:session abc[31mdef");
  await ui.unmount();
});

test("a main-thread request's effort joins the tag, on both surfaces", async ($, on) => {
  engine(on);
  const terminal = await $.ui.mount({ ...HINT, surface: "terminal" });
  const desktop = await $.ui.mount({ ...HINT, surface: "desktop" });
  expect(await tagText(terminal)).toBe("● Opus");

  await runStep($, step({ effort: "high" }));
  expect(await tagText(terminal)).toBe("● Opus · high");
  expect(await tagText(desktop)).toBe("● Opus · high");
  await terminal.unmount();
  await desktop.unmount();
});

test("a main-thread request passes through untouched, once", async ($, on) => {
  const world = engine(on);
  const { chunks, result } = await runStep($, step({ effort: "high" }));
  expect(chunks).toEqual([CHUNK]);
  expect(result).toEqual(RESULT);
  expect(world.steps).toBe(1);
});

test("a subagent's request passes through untouched and leaves the level", async ($, on) => {
  const world = engine(on);
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  await runStep($, step({ effort: "high" }));

  const { chunks, result } = await runStep($, step({ effort: "max", agentId: "agent-1" }));
  expect(chunks).toEqual([CHUNK]);
  expect(result).toEqual(RESULT);
  expect(world.steps).toBe(2);
  expect(await tagText(ui)).toBe("● Opus · high");
  await ui.unmount();
});

test("a request with no named level clears the level", async ($, on) => {
  engine(on);
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  await runStep($, step({ effort: "high" }));
  expect(await tagText(ui)).toBe("● Opus · high");

  await runStep($, step({}));
  expect(await tagText(ui)).toBe("● Opus");
  await runStep($, step({ effort: 20_000 }));
  expect(await tagText(ui)).toBe("● Opus");
  await runStep($, step({ effort: "\u001b" as unknown as "high" }));
  expect(await tagText(ui)).toBe("● Opus");
  await ui.unmount();
});

test("a switch to another model family hides the level", async ($, on) => {
  const world = engine(on);
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  await runStep($, step({ effort: "high" }));

  world.model = "claude-haiku-5-5";
  await $.config.set({
    key: "model",
    value: world.model,
    previous: "claude-opus-5-5",
    provider: { plugin: "engine", tier: "core" },
    origin: { kind: "composer" },
  });
  expect(await tagText(ui)).toBe("● Haiku");
  await ui.unmount();
});

test("the context bar shows the window's fill", async ($, on) => {
  engine(on, { percent: 34 });
  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await $.ui.mount({ ...HINT, surface });
    expect((await bar(ui))?.text.trim()).toBe("▰▰▰▱▱▱▱▱▱▱ 34%");
    await ui.unmount();
  }
});

test("the bar follows a new measure of the context", async ($, on) => {
  const world = engine(on, { percent: 34 });
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  world.percent = 51;
  await $.session.measure({
    context: { window: 1_000_000, tokens: 510_000, percent: 51 },
    rateLimits: [],
    changed: ["context"],
  });
  expect((await bar(ui))?.text.trim()).toBe("▰▰▰▰▰▱▱▱▱▱ 51%");
  await ui.unmount();
});

test("the bar follows the window after each main-thread request", async ($, on) => {
  const world = engine(on, { percent: 10 });
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  world.percent = 20;
  await runStep($, step({ effort: "high" }));
  expect((await bar(ui))?.text.trim()).toBe("▰▰▱▱▱▱▱▱▱▱ 20%");
  await ui.unmount();
});

test("no reading yet draws no bar", async ($, on) => {
  engine(on);
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  expect(await bar(ui)).toBe(undefined);
  expect(await tagText(ui)).toBe("● Opus");
  await ui.unmount();
});

test("the bar is dim below 70%, a warning from 70% and an error from 85%", async ($, on) => {
  const world = engine(on);
  for (const [percent, tone] of [
    [69, "dim"],
    [70, "warning"],
    [84, "warning"],
    [85, "error"],
  ] as const) {
    world.percent = percent;
    const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
    const shown = await bar(ui);
    if (tone === "dim") {
      expect(shown?.props.dimColor).toBe(true);
      expect(shown?.props.color).toBe(undefined);
    } else {
      expect(shown?.props.color).toBe(tone);
    }
    await ui.unmount();
  }
});

test("a refused usage read leaves the tag and the engine line", async ($, on) => {
  engine(on, { percent: null });
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  expect(await bar(ui)).toBe(undefined);
  expect(await tagText(ui)).toBe("● Opus");
  expect(await engineLine(ui)).toBe(`engine tail:session ${SESSION}`);
  await ui.unmount();
});

test("a compaction clears the bar", async ($, on) => {
  const world = engine(on, { percent: 88 });
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  expect((await bar(ui))?.text.trim()).toBe("▰▰▰▰▰▰▰▰▱▱ 88%");

  world.percent = undefined;
  expect((await bar(ui))?.text.trim()).toBe("▰▰▰▰▰▰▰▰▱▱ 88%");
  await $.session.compact({
    trigger: "manual",
    messages: [{ role: "user", text: "summary", toolUses: [] }],
  });
  expect(await bar(ui)).toBe(undefined);
  await ui.unmount();
});

test("the spinner carries the model colour", async ($, on) => {
  engine(on);
  const ui = await $.ui.mount({ ...SPINNER, surface: "terminal" });
  expect((await ui.find({ type: "Text", text: /●/ }))?.props.color).toBe("#D9481C");
  await ui.unmount();
});

test("the tag follows a model switch made with config.set", async ($, on) => {
  const world = engine(on);
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  const tag = async () => {
    const shown = await ui.find({ type: "Text", text: /●/ });
    return [shown?.text.trim(), shown?.props.color];
  };
  expect(await tag()).toEqual(["● Opus", "#D9481C"]);

  world.model = "claude-haiku-5-5";
  await $.config.set({
    key: "model",
    value: world.model,
    previous: "claude-opus-5-5",
    provider: { plugin: "engine", tier: "core" },
    origin: { kind: "composer" },
  });
  expect(await tag()).toEqual(["● Haiku", "#22A35A"]);
  await ui.unmount();
});

test("the tag follows a model switch at the next prompt", async ($, on) => {
  const world = engine(on);
  const ui = await $.ui.mount({ ...SPINNER, surface: "terminal" });
  const dot = () => ui.find({ type: "Text", text: /●/ });
  expect((await dot())?.props.color).toBe("#D9481C");

  world.model = "sonnet";
  await $.prompt.submit({ text: "next", wait: false, origin: { kind: "composer" } });
  expect((await dot())?.props.color).toBe("#E5B700");
  await ui.unmount();
});
