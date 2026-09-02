// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import { bindCommandShortcut } from "../../src/lib/command-shortcut";

/**
 * These tests used to live in CommandPalette's file, because the binding used
 * to live in its component. It moved out so the palette could be code-split —
 * which is exactly the thing worth pinning here: the shortcut has to work
 * before the palette exists.
 */

const disposers: Array<() => void> = [];

function bind() {
  const toggle = vi.fn();
  disposers.push(bindCommandShortcut(toggle));
  return toggle;
}

function press(init: KeyboardEventInit) {
  const event = new KeyboardEvent("keydown", { cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
}

describe("bindCommandShortcut", () => {
  afterEach(() => {
    while (disposers.length) disposers.pop()!();
  });

  it("fires on ⌘K", () => {
    const toggle = bind();
    press({ key: "k", metaKey: true });
    expect(toggle).toHaveBeenCalledOnce();
  });

  it("takes Ctrl+K and a capitalised K too", () => {
    const toggle = bind();
    press({ key: "K", ctrlKey: true });
    press({ key: "k", ctrlKey: true });
    expect(toggle).toHaveBeenCalledTimes(2);
  });

  it("ignores a bare k", () => {
    const toggle = bind();
    press({ key: "k" });
    expect(toggle).not.toHaveBeenCalled();
  });

  it("ignores every other key, modified or not", () => {
    const toggle = bind();
    press({ key: "j", metaKey: true });
    press({ key: "Enter", ctrlKey: true });
    expect(toggle).not.toHaveBeenCalled();
  });

  it("takes the keystroke away from the browser", () => {
    // Deliberate: ⌘K is a browser binding in Chrome and Firefox (focus the
    // address bar in search mode). The portal claims it, so it has to say so.
    bind();
    expect(press({ key: "k", metaKey: true }).defaultPrevented).toBe(true);
  });

  it("fires from inside a text field", () => {
    // A host mid-sentence in the invite builder pressing ⌘K is asking to leave
    // that field, so inputs get no exemption.
    const toggle = bind();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
    expect(toggle).toHaveBeenCalledOnce();
    input.remove();
  });

  it("stops listening once disposed", () => {
    const toggle = vi.fn();
    bindCommandShortcut(toggle)();
    press({ key: "k", metaKey: true });
    expect(toggle).not.toHaveBeenCalled();
  });
});
