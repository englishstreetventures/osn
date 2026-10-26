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

const engine = (on: On, model: string) => {
  on("session.model", () => ({ value: model }));
  on("ui.render", ($, e) => {
    const { Text } = $.ui.resolve(e);
    return <Text>engine</Text>;
  });
};

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
      expect((await ui.find({ type: "Text", text: /engine/ }))?.text).toBe("engine");
      await ui.unmount();
    }
  });
}

test("the spinner carries the model colour", async ($, on) => {
  engine(on, "claude-opus-5-5");
  const ui = await $.ui.mount({ ...SPINNER, surface: "terminal" });
  expect((await ui.find({ type: "Text", text: /●/ }))?.props.color).toBe("#D9481C");
  await ui.unmount();
});

test("an unknown model leaves the engine line alone", async ($, on) => {
  engine(on, "some-other-model");
  const ui = await $.ui.mount({ ...HINT, surface: "terminal" });
  expect(await ui.find({ type: "Text", text: /●/ })).toBe(undefined);
  expect((await ui.find({ type: "Text", text: /engine/ }))?.text).toBe("engine");
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
