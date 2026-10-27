import type { On, TurnStepChunk, TurnStepInput, TurnStepResult } from "claude-code";
import { expect, test } from "claude-code/testing";

// The hint text in auto mode with six agents, as the owner's terminal showed
// the mod receives it: the mode's own pill is drawn by the terminal, ahead of
// the row, and its key hint arrives in the text.
const LIVE_HINT = "(shift+tab to cycle) · ← 6 agents";

const hint = (text: string) =>
  ({
    plugin: "prompt-row",
    component: "PromptHint",
    props: { isDraft: false, isWorking: false, hint: text },
  }) as const;

const HINT = hint("? for shortcuts");

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
// a bottom for each event the mod passes on, and a drawing of its own that
// reads `engine`, so a test can see whether the mod drew it.
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
    return <Text>engine</Text>;
  });
  return state;
};

type Found = { text: string; props: Record<string, unknown> };
type Drawing = {
  find: (q: { type: string; text: RegExp }) => Promise<Found | undefined>;
  findAll: (q: { type: string }) => Promise<readonly Found[]>;
};

// The row's texts in order, separators included.
const row = async (ui: Drawing) => (await ui.findAll({ type: "Text" })).map((t) => t.text.trim());
const part = (ui: Drawing, text: RegExp) => ui.find({ type: "Text", text });
const tagText = async (ui: Drawing) => (await part(ui, /●/))?.text.trim();
const bar = (ui: Drawing) => part(ui, /[▰▱]/);
const sessionText = async (ui: Drawing) => (await part(ui, /session/))?.text.trim();

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
  test(`the row carries ${name} in its colour`, async ($, on) => {
    engine(on, { model });
    for (const surface of ["terminal", "desktop"] as const) {
      const ui = await $.ui.mount({ ...HINT, surface });
      const tag = await part(ui, /●/);
      expect(tag?.text.trim()).toBe(`● ${name}`);
      expect(tag?.props.color).toBe(color);
      await ui.unmount();
    }
  });
}

test("the row runs agents, model and effort, context, session, on one line, on both surfaces", async ($, on) => {
  engine(on, { percent: 34 });
  await runStep($, step({ effort: "high" }));
  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await $.ui.mount({ ...hint(LIVE_HINT), surface });
    expect(await row(ui)).toEqual([
      "← 6 agents",
      "|",
      "● Opus · high",
      "|",
      "▰▰▰▱▱▱▱▱▱▱ 34%",
      "|",
      `session ${SESSION}`,
    ]);
    expect(await part(ui, /shift\+tab/)).toBe(undefined);
    await ui.unmount();
  }
});

test("what the hint holds besides agents comes last", async ($, on) => {
  engine(on);
  const ui = await $.ui.mount({ ...hint("esc to interrupt · ← 2 agents"), surface: "terminal" });
  expect(await row(ui)).toEqual([
    "← 2 agents",
    "|",
    "● Opus",
    "|",
    `session ${SESSION}`,
    "|",
    "esc to interrupt",
  ]);
  await ui.unmount();
});

test("one agent is counted, and several leftover pieces keep their order", async ($, on) => {
  engine(on, { session: null });
  const ui = await $.ui.mount({
    ...hint("esc to interrupt · ← 1 agent · ctrl+t to show todos"),
    surface: "terminal",
  });
  expect(await row(ui)).toEqual([
    "← 1 agent",
    "|",
    "● Opus",
    "|",
    "esc to interrupt · ctrl+t to show todos",
  ]);
  await ui.unmount();
});

test("the mod draws the row itself, never the engine's line under it", async ($, on) => {
  engine(on);
  const ui = await $.ui.mount({ ...hint(LIVE_HINT), surface: "terminal" });
  expect(await part(ui, /engine/)).toBe(undefined);
  await ui.unmount();
});

test("a /clear redraws the row with the new session id", async ($, on) => {
  const world = engine(on);
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  expect(await sessionText(ui)).toBe(`session ${SESSION}`);

  world.session = NEXT_SESSION;
  expect(await sessionText(ui)).toBe(`session ${SESSION}`);
  await $.session.end({ reason: "clear", sessionId: SESSION, resume: { id: SESSION } });
  expect(await sessionText(ui)).toBe(`session ${NEXT_SESSION}`);
  await ui.unmount();
});

test("an unknown model still shows the session id, with no dot", async ($, on) => {
  engine(on, { model: "some-other-model" });
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  expect(await part(ui, /●/)).toBe(undefined);
  expect(await sessionText(ui)).toBe(`session ${SESSION}`);
  await ui.unmount();
});

test("a refused session id leaves the rest of the row", async ($, on) => {
  engine(on, { session: null });
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  expect(await row(ui)).toEqual(["● Opus", "|", "? for shortcuts"]);
  await ui.unmount();
});

test("with nothing of its own to show, the row is the hint alone", async ($, on) => {
  engine(on, { model: "some-other-model", session: null, percent: null });
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  expect(await row(ui)).toEqual(["? for shortcuts"]);
  await ui.unmount();
});

test("control characters in the session id never reach the screen", async ($, on) => {
  engine(on, { session: "abc\u001b[31mdef" });
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  expect(await sessionText(ui)).toBe("session abc[31mdef");
  await ui.unmount();
});

test("control characters in the hint never reach the screen", async ($, on) => {
  engine(on, { session: null });
  const ui = await $.ui.mount({
    ...hint("\u001b]52;c;eA==\u0007esc to interrupt · ← 2\u001b[2J agents"),
    surface: "terminal",
  });
  const shown = await row(ui);
  // oxlint-disable-next-line no-control-regex -- the point is to find them
  for (const text of shown) expect(/[\u0000-\u001f\u007f-\u009f]/.test(text)).toBe(false);
  expect(shown).toEqual(["● Opus", "|", "]52;c;eA==esc to interrupt · ← 2[2J agents"]);
  await ui.unmount();
});

test("a state read that never settles holds no request", async ($, on) => {
  const world = engine(on);
  on("state.get", () => new Promise(() => {}));
  const { chunks, result } = await runStep($, step({ effort: "high" }));
  expect(chunks).toEqual([CHUNK]);
  expect(result).toEqual(RESULT);
  expect(world.steps).toBe(1);
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

test("the bar follows the window after each main-thread request, the level unchanged", async ($, on) => {
  const world = engine(on, { percent: 10 });
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  await runStep($, step({ effort: "high" }));
  expect((await bar(ui))?.text.trim()).toBe("▰▱▱▱▱▱▱▱▱▱ 10%");

  world.percent = 20;
  expect((await bar(ui))?.text.trim()).toBe("▰▱▱▱▱▱▱▱▱▱ 10%");
  await runStep($, step({ effort: "high" }));
  expect((await bar(ui))?.text.trim()).toBe("▰▰▱▱▱▱▱▱▱▱ 20%");
  await ui.unmount();
});

test("a reading outside 0 to 100 fills the bar to its ends and keeps the row", async ($, on) => {
  const world = engine(on, { percent: 120 });
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  expect((await bar(ui))?.text.trim()).toBe("▰▰▰▰▰▰▰▰▰▰ 120%");
  expect(await sessionText(ui)).toBe(`session ${SESSION}`);
  await ui.unmount();

  world.percent = -5;
  const again = await $.ui.mount({ ...HINT, surface: "terminal" });
  expect((await bar(again))?.text.trim()).toBe("▱▱▱▱▱▱▱▱▱▱ -5%");
  await again.unmount();
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

test("a refused usage read leaves the rest of the row", async ($, on) => {
  engine(on, { percent: null });
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  expect(await row(ui)).toEqual(["● Opus", "|", `session ${SESSION}`, "|", "? for shortcuts"]);
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
  expect((await part(ui, /●/))?.props.color).toBe("#D9481C");
  await ui.unmount();
});

test("the tag follows a model switch made with config.set", async ($, on) => {
  const world = engine(on);
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  const tag = async () => {
    const shown = await part(ui, /●/);
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
  const dot = () => part(ui, /●/);
  expect((await dot())?.props.color).toBe("#D9481C");

  world.model = "sonnet";
  await $.prompt.submit({ text: "next", wait: false, origin: { kind: "composer" } });
  expect((await dot())?.props.color).toBe("#E5B700");
  await ui.unmount();
});
