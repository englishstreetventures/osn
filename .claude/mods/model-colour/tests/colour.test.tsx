import type { On } from "claude-code";
import { expect, test } from "claude-code/testing";

const HINT = {
  plugin: "model-colour",
  component: "PromptHint",
  props: { isDraft: false, isWorking: false, hint: "? for shortcuts" },
} as const;

const SPINNER = {
  plugin: "model-colour",
  component: "Spinner",
  props: { word: "Baking", message: null, suffix: "…", mode: "thinking" },
} as const;

const SESSION = "aef16703-ba2d-4d05-9570-0bab6be386ec";

// The engine beneath the mod: it answers the model and the session id, and
// draws its own line, with any `tail` a hook handed it after the word
// `tail:`.
const engine = (on: On, model: string, session: string | null = SESSION) => {
  on("session.model", () => ({ value: model }));
  on("session.id", () => (session === null ? { deny: "no session" } : { value: session }));
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    const tail = "tail" in e.props ? e.props.tail : undefined;
    return <Text>{tail === undefined ? "engine" : `engine tail:${tail}`}</Text>;
  });
};

const engineLine = async (ui: {
  find: (q: { type: string; text: RegExp }) => Promise<{ text: string } | undefined>;
}) => (await ui.find({ type: "Text", text: /engine/ }))?.text;

const CASES = [
  ["claude-fable-5-1", "Fable", "#3B82F6"],
  ["claude-opus-5-5", "Opus", "#D9481C"],
  ["claude-haiku-5-5", "Haiku", "#22A35A"],
  ["sonnet", "Sonnet", "#E5B700"],
] as const;

for (const [model, name, color] of CASES) {
  test(`the hint line carries ${name} in its colour`, async ($, on) => {
    engine(on, model);
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
  engine(on, "claude-opus-5-5");
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  expect((await ui.find({ type: "Text", text: /●/ }))?.text.trim()).toBe("● Opus");
  expect(await engineLine(ui)).toBe(`engine tail:session ${SESSION}`);
  await ui.unmount();
});

test("on desktop the session id follows the tag", async ($, on) => {
  engine(on, "claude-opus-5-5");
  const ui = await $.ui.mount({ ...HINT, surface: "desktop" });
  expect((await ui.find({ type: "Text", text: /session/ }))?.text.trim()).toBe(
    `· session ${SESSION}`,
  );
  expect(await engineLine(ui)).toBe("engine");
  await ui.unmount();
});

test("a /clear redraws the row with the new session id", async ($, on) => {
  let session = SESSION;
  on("session.model", () => ({ value: "claude-opus-5-5" }));
  on("session.id", () => ({ value: session }));
  on("classic.SessionStart", () => ({}));
  on("ui.render", (host, e) => {
    const { Text } = host.ui.resolve(e);
    const tail = "tail" in e.props ? e.props.tail : undefined;
    return <Text>{`engine tail:${tail ?? ""}`}</Text>;
  });

  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  expect(await engineLine(ui)).toBe(`engine tail:session ${SESSION}`);

  session = "11111111-2222-3333-4444-555555555555";
  await $.classic.SessionStart({ source: "clear" });
  expect(await engineLine(ui)).toBe(`engine tail:session ${session}`);
  await ui.unmount();
});

test("an unknown model still shows the session id, with no dot and no separator", async ($, on) => {
  engine(on, "some-other-model");
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
  engine(on, "claude-opus-5-5", null);
  for (const surface of ["terminal", "desktop"] as const) {
    const ui = await $.ui.mount({ ...HINT, surface });
    expect((await ui.find({ type: "Text", text: /●/ }))?.text.trim()).toBe("● Opus");
    expect(await ui.find({ type: "Text", text: /session/ })).toBe(undefined);
    expect(await engineLine(ui)).toBe("engine");
    await ui.unmount();
  }
});

test("an unknown model and a refused session id leave the engine line alone", async ($, on) => {
  engine(on, "some-other-model", null);
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: /●/ })).toBe(undefined);
  expect(await engineLine(ui)).toBe("engine");
  await ui.unmount();
});

test("control characters in the session id never reach the screen", async ($, on) => {
  engine(on, "claude-opus-5-5", "abc\u001b[31mdef");
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  expect(await engineLine(ui)).toBe("engine tail:session abc[31mdef");
  await ui.unmount();
});

test("the spinner carries the model colour", async ($, on) => {
  engine(on, "claude-opus-5-5");
  const ui = await $.ui.mount({ ...SPINNER, surface: "terminal" });
  expect((await ui.find({ type: "Text", text: /●/ }))?.props.color).toBe("#D9481C");
  await ui.unmount();
});

test("the tag follows a model switch made with config.set", async ($, on) => {
  let model = "claude-opus-5-5";
  on("session.model", () => ({ value: model }));
  on("config.set", (_, e) => ({ value: e.value }));
  on("ui.render", (host, e) => {
    const { Text } = host.ui.resolve(e);
    return <Text>engine</Text>;
  });

  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  const tag = async () => {
    const shown = await ui.find({ type: "Text", text: /●/ });
    return [shown?.text.trim(), shown?.props.color];
  };
  expect(await tag()).toEqual(["● Opus", "#D9481C"]);

  model = "claude-haiku-5-5";
  await $.config.set({
    key: "model",
    value: model,
    previous: "claude-opus-5-5",
    provider: { plugin: "engine", tier: "core" },
    origin: { kind: "composer" },
  });
  expect(await tag()).toEqual(["● Haiku", "#22A35A"]);
  await ui.unmount();
});

test("the tag follows a model switch at the next prompt", async ($, on) => {
  let model = "claude-opus-5-5";
  on("session.model", () => ({ value: model }));
  on("prompt.submit", (_, e) => ({ text: e.text }));
  on("ui.render", (host, e) => {
    const { Text } = host.ui.resolve(e);
    return <Text>engine</Text>;
  });

  const ui = await $.ui.mount({ ...SPINNER, surface: "terminal" });
  const dot = () => ui.find({ type: "Text", text: /●/ });
  expect((await dot())?.props.color).toBe("#D9481C");

  model = "sonnet";
  await $.prompt.submit({ text: "next", wait: false, origin: { kind: "composer" } });
  expect((await dot())?.props.color).toBe("#E5B700");
  await ui.unmount();
});
