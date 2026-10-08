// @vitest-environment happy-dom
import { createRoot } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createPointerDwell } from "../../src/lib/pointer-dwell";

const mouse = { pointerType: "mouse" } as PointerEvent;
const pen = { pointerType: "pen" } as PointerEvent;
const touch = { pointerType: "touch" } as PointerEvent;

/** A dwell with 3000ms in and 300ms out, inside a root the test can dispose. */
function setup() {
  const onDwell = vi.fn();
  const onLeave = vi.fn();
  let dispose!: () => void;
  const dwell = createRoot((d) => {
    dispose = d;
    return createPointerDwell({ openDelay: 3000, closeDelay: 300, onDwell, onLeave });
  });
  return { dwell, onDwell, onLeave, dispose };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createPointerDwell", () => {
  it("fires once the pointer has rested on the trigger for the whole delay", () => {
    const { dwell, onDwell } = setup();
    dwell.enterTrigger(mouse);

    vi.advanceTimersByTime(2999);
    expect(onDwell).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onDwell).toHaveBeenCalledTimes(1);
  });

  it("does not restart the delay when the trigger reports a second enter", () => {
    const { dwell, onDwell } = setup();
    dwell.enterTrigger(mouse);
    vi.advanceTimersByTime(2000);
    dwell.enterTrigger(mouse);

    vi.advanceTimersByTime(1000);
    expect(onDwell).toHaveBeenCalledTimes(1);
  });

  it("fires nothing when the pointer leaves before the delay is up", () => {
    const { dwell, onDwell, onLeave } = setup();
    dwell.enterTrigger(mouse);
    vi.advanceTimersByTime(2000);
    dwell.leave(mouse);

    vi.advanceTimersByTime(10_000);
    expect(onDwell).not.toHaveBeenCalled();
    // Leaving schedules the leave callback; the caller decides whether there
    // is anything open to close.
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("counts a pen as a pointer that rests", () => {
    const { dwell, onDwell } = setup();
    dwell.enterTrigger(pen);
    vi.advanceTimersByTime(3000);
    expect(onDwell).toHaveBeenCalledTimes(1);
  });

  it("ignores touch outright, in and out", () => {
    // A touch has no hover; the press path is how a touch opens anything.
    const { dwell, onDwell, onLeave } = setup();
    dwell.enterTrigger(touch);
    dwell.leave(touch);
    vi.advanceTimersByTime(10_000);
    expect(onDwell).not.toHaveBeenCalled();
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("fires the leave callback once the pointer has been off for the close delay", () => {
    const { dwell, onLeave } = setup();
    dwell.enterTrigger(mouse);
    vi.advanceTimersByTime(3000);
    dwell.leave(mouse);

    vi.advanceTimersByTime(299);
    expect(onLeave).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onLeave).toHaveBeenCalledTimes(1);
  });

  it("treats crossing from the trigger to the card as staying", () => {
    const { dwell, onLeave } = setup();
    dwell.enterTrigger(mouse);
    vi.advanceTimersByTime(3000);

    dwell.leave(mouse);
    vi.advanceTimersByTime(100);
    dwell.enterCard(mouse);

    vi.advanceTimersByTime(10_000);
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("treats crossing from the card back to the trigger as staying", () => {
    const { dwell, onLeave } = setup();
    dwell.enterTrigger(mouse);
    vi.advanceTimersByTime(3000);

    dwell.leave(mouse);
    vi.advanceTimersByTime(100);
    dwell.enterTrigger(mouse);

    vi.advanceTimersByTime(10_000);
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("starts no close delay when the caller says a leave has nothing to close", () => {
    const onLeave = vi.fn();
    let armed = false;
    let dispose!: () => void;
    const dwell = createRoot((d) => {
      dispose = d;
      return createPointerDwell({
        openDelay: 3000,
        closeDelay: 300,
        onDwell: () => {},
        onLeave,
        armLeave: () => armed,
      });
    });
    const timersBefore = vi.getTimerCount();

    dwell.leave(mouse);
    expect(vi.getTimerCount()).toBe(timersBefore);

    armed = true;
    dwell.leave(mouse);
    vi.advanceTimersByTime(300);
    expect(onLeave).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("never starts the open delay from the card", () => {
    // The card is what the dwell opened; resting on it is not asking again.
    const { dwell, onDwell } = setup();
    dwell.enterCard(mouse);
    vi.advanceTimersByTime(10_000);
    expect(onDwell).not.toHaveBeenCalled();
  });

  it("drops both timers on cancel", () => {
    const { dwell, onDwell, onLeave } = setup();
    dwell.enterTrigger(mouse);
    dwell.cancel();
    vi.advanceTimersByTime(10_000);
    expect(onDwell).not.toHaveBeenCalled();

    dwell.leave(mouse);
    dwell.cancel();
    vi.advanceTimersByTime(10_000);
    expect(onLeave).not.toHaveBeenCalled();
  });

  it("drops both timers when its owner is disposed", () => {
    const { dwell, onDwell, dispose } = setup();
    dwell.enterTrigger(mouse);
    dispose();
    vi.advanceTimersByTime(10_000);
    expect(onDwell).not.toHaveBeenCalled();
  });
});
