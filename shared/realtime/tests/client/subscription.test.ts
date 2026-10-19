import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTopicSubscription, type SignalEvent } from "../../src/client/subscription";
import { FakeVisibility } from "../support/fake-visibility";
import { FakeSocketClass, FakeWebSocket, latest } from "../support/fake-websocket";

const URL = "wss://api.example.test/realtime/cire%3Awedding%3Awed_1";
const SIGNAL = JSON.stringify({ topic: "cire:wedding:wed_1", kind: "members-changed", at: 1 });

const base = {
  WebSocket: FakeSocketClass,
  pingIntervalMs: 1_000,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
  maxAttempts: 3,
  random: () => 0.5,
  // Each test gets its own, so one test's fallback never shortens another's.
  get fallbackMemory() {
    return new Map<string, number>();
  },
};

let events: SignalEvent[];
const onSignal = (event: SignalEvent) => events.push(event);

beforeEach(() => {
  vi.useFakeTimers();
  FakeWebSocket.reset();
  events = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createTopicSubscription", () => {
  it("opens one socket to the URL and says nothing on the first open", () => {
    createTopicSubscription(URL, onSignal, base);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(latest().url).toBe(URL);
    latest().serverOpen();
    expect(events).toEqual([]);
  });

  it("passes a well-formed signal on", () => {
    createTopicSubscription(URL, onSignal, base);
    latest().serverOpen();
    latest().serverSend(SIGNAL);
    expect(events).toEqual([{ reason: "message", signal: JSON.parse(SIGNAL) }]);
  });

  it.each([
    ["pong", "pong"],
    ["text that is not JSON", "{nope"],
    ["JSON that is not a signal", JSON.stringify({ hello: 1 })],
    [
      "a signal of an unknown kind",
      JSON.stringify({ topic: "cire:wedding:wed_1", kind: "rows", at: 1 }),
    ],
  ])("ignores %s", (_label, frame) => {
    createTopicSubscription(URL, onSignal, base);
    latest().serverOpen();
    latest().serverSend(frame);
    expect(events).toEqual([]);
  });

  it("pings each interval while answered", () => {
    createTopicSubscription(URL, onSignal, base);
    const socket = latest();
    socket.serverOpen();
    vi.advanceTimersByTime(1_000);
    expect(socket.sent).toEqual(["ping"]);
    socket.serverSend("pong");
    vi.advanceTimersByTime(1_000);
    expect(socket.sent).toEqual(["ping", "ping"]);
    expect(events).toEqual([]);
  });

  it("drops a socket whose ping went unanswered, and reconnects", () => {
    createTopicSubscription(URL, onSignal, base);
    const first = latest();
    first.serverOpen();
    vi.advanceTimersByTime(1_000); // ping sent
    vi.advanceTimersByTime(1_000); // still unanswered: dead
    // With a code: a code-less close reaches the hub as 1005, which it cannot echo.
    expect(first.closedWith?.code).toBe(1000);
    expect(events).toEqual([{ reason: "dropped" }]);

    first.serverClose(1006); // the late close of the abandoned socket changes nothing
    expect(events).toEqual([{ reason: "dropped" }]);

    vi.advanceTimersByTime(50); // 0.5 × min(1000, 100 × 2^0)
    expect(FakeWebSocket.instances).toHaveLength(2);
    latest().serverOpen();
    expect(events).toEqual([{ reason: "dropped" }, { reason: "reconnected" }]);
  });

  it("treats a lost open socket as a signal, then a successful reconnect as another", () => {
    createTopicSubscription(URL, onSignal, base);
    latest().serverOpen();
    latest().serverClose(1006);
    expect(events).toEqual([{ reason: "dropped" }]);
    vi.advanceTimersByTime(50);
    latest().serverOpen();
    expect(events).toEqual([{ reason: "dropped" }, { reason: "reconnected" }]);
  });

  it("reconnects after an eviction (4001)", () => {
    createTopicSubscription(URL, onSignal, base);
    latest().serverOpen();
    latest().serverClose(4001);
    expect(events).toEqual([{ reason: "dropped" }]);
    vi.advanceTimersByTime(50);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("backs off within the ceiling and falls back after maxAttempts failed attempts", () => {
    const onFallback = vi.fn();
    createTopicSubscription(URL, onSignal, { ...base, random: () => 0.999, onFallback });

    latest().serverClose(1006); // attempt 1 never opened
    vi.advanceTimersByTime(98);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1); // floor(0.999 × 100) = 99
    expect(FakeWebSocket.instances).toHaveLength(2);

    latest().serverClose(1006); // attempt 2
    vi.advanceTimersByTime(199); // floor(0.999 × 200)
    expect(FakeWebSocket.instances).toHaveLength(3);

    latest().serverClose(1006); // attempt 3 = maxAttempts
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(events).toEqual([]);
  });

  it("never waits longer than maxDelayMs", () => {
    createTopicSubscription(URL, onSignal, { ...base, maxAttempts: 10, random: () => 0.999 });
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      latest().serverClose(1006);
      vi.advanceTimersByTime(999);
      expect(FakeWebSocket.instances).toHaveLength(attempt + 1);
    }
  });

  it("stops at once on 1008 — the topic is full or a frame was refused", () => {
    const onFallback = vi.fn();
    createTopicSubscription(URL, onSignal, { ...base, onFallback });
    latest().serverOpen();
    latest().serverClose(1008);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ reason: "stopped" }]);
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("prompts one last re-read when it gives up after having been open", () => {
    const onFallback = vi.fn();
    createTopicSubscription(URL, onSignal, { ...base, onFallback });
    latest().serverOpen();
    latest().serverClose(1006); // open socket lost: dropped
    for (let attempt = 0; attempt < 3; attempt += 1) {
      vi.advanceTimersByTime(1_000);
      latest().serverClose(1006); // every reconnect refused
    }
    expect(events).toEqual([{ reason: "dropped" }, { reason: "stopped" }]);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps reconnecting when the subscriber throws", () => {
    createTopicSubscription(
      URL,
      () => {
        throw new Error("subscriber bug");
      },
      base,
    );
    latest().serverOpen();
    latest().serverClose(1006);
    vi.advanceTimersByTime(50);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("arms no retry when the subscriber closes the subscription from inside a signal", () => {
    const holder: { subscription?: { close(): void } } = {};
    holder.subscription = createTopicSubscription(URL, () => holder.subscription?.close(), base);
    latest().serverOpen();
    latest().serverClose(1006);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("counts a constructor that throws (a blocked URL) as a failed attempt", () => {
    const onFallback = vi.fn();
    FakeWebSocket.throwOnConstruct = true;
    createTopicSubscription(URL, onSignal, { ...base, onFallback });
    vi.advanceTimersByTime(10_000);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("survives an onFallback that throws, even on the first, synchronous attempt", () => {
    const onFallback = vi.fn(() => {
      throw new Error("product bug");
    });
    FakeWebSocket.throwOnConstruct = true;
    expect(() =>
      createTopicSubscription(URL, onSignal, { ...base, maxAttempts: 1, onFallback }),
    ).not.toThrow();
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("close() cancels its timers and closes the socket with 1000", () => {
    const subscription = createTopicSubscription(URL, onSignal, base);
    const socket = latest();
    socket.serverOpen();
    subscription.close();
    expect(socket.closedWith?.code).toBe(1000);
    expect(vi.getTimerCount()).toBe(0);
    socket.serverSend(SIGNAL);
    socket.serverClose(1006);
    expect(events).toEqual([]);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("close() during a retry wait cancels the retry", () => {
    const subscription = createTopicSubscription(URL, onSignal, base);
    latest().serverClose(1006);
    subscription.close();
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("counts a socket that opens but is cut before answering as a failed attempt, and falls back after maxAttempts", () => {
    const onFallback = vi.fn();
    createTopicSubscription(URL, onSignal, { ...base, random: () => 0.999, onFallback });

    latest().serverOpen();
    latest().serverClose(1006); // attempt 1: opened, never answered
    vi.advanceTimersByTime(99); // floor(0.999 × 100)
    expect(FakeWebSocket.instances).toHaveLength(2);

    latest().serverOpen();
    latest().serverClose(1006); // attempt 2: opened, never answered
    vi.advanceTimersByTime(199); // floor(0.999 × 200): backoff grew
    expect(FakeWebSocket.instances).toHaveLength(3);

    latest().serverOpen();
    latest().serverClose(1006); // attempt 3 = maxAttempts: opened, never answered
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      { reason: "dropped" },
      { reason: "reconnected" },
      { reason: "dropped" },
      { reason: "reconnected" },
      { reason: "dropped" },
      { reason: "stopped" },
    ]);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(3);
  });

  it("resets the failure count once a socket answers, rather than counting failures over its lifetime", () => {
    const onFallback = vi.fn();
    createTopicSubscription(URL, onSignal, { ...base, random: () => 0.999, onFallback });

    latest().serverOpen();
    latest().serverClose(1006); // failure 1: opened, never answered
    vi.advanceTimersByTime(99);
    expect(FakeWebSocket.instances).toHaveLength(2);

    latest().serverOpen();
    latest().serverClose(1006); // failure 2: opened, never answered
    vi.advanceTimersByTime(199);
    expect(FakeWebSocket.instances).toHaveLength(3);

    // This socket answers (a pong), which resets the count, then is lost.
    const answered = latest();
    answered.serverOpen();
    answered.serverSend("pong");
    answered.serverClose(1006);
    expect(onFallback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99); // reset: ceiling is baseDelayMs again, not the grown one
    expect(FakeWebSocket.instances).toHaveLength(4);

    // maxAttempts (3) more failed attempts are needed now, not just one more.
    latest().serverOpen();
    latest().serverClose(1006); // failure 1 post-reset
    expect(onFallback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(99);
    expect(FakeWebSocket.instances).toHaveLength(5);

    latest().serverOpen();
    latest().serverClose(1006); // failure 2 post-reset
    expect(onFallback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(199);
    expect(FakeWebSocket.instances).toHaveLength(6);

    latest().serverOpen();
    latest().serverClose(1006); // failure 3 post-reset = maxAttempts
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("createTopicSubscription in a hidden tab", () => {
  it("closes the socket and stops pinging once the tab has been hidden for two ping intervals", () => {
    const visibility = new FakeVisibility();
    const onFallback = vi.fn();
    createTopicSubscription(URL, onSignal, { ...base, visibility, onFallback });
    const socket = latest();
    socket.serverOpen();
    visibility.hide();

    vi.advanceTimersByTime(1_000);
    socket.serverSend("pong");
    vi.advanceTimersByTime(999);
    expect(socket.closedWith).toBeNull();
    vi.advanceTimersByTime(1);
    expect(socket.closedWith?.code).toBe(1000);
    const pings = socket.sent.length;
    socket.serverClose(1000); // the paused socket's own close arrives later

    vi.advanceTimersByTime(60_000);
    expect(socket.sent).toHaveLength(pings);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(events).toEqual([]);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("keeps the socket while the tab is hidden for less than that", () => {
    const visibility = new FakeVisibility();
    createTopicSubscription(URL, onSignal, { ...base, visibility });
    const socket = latest();
    socket.serverOpen();
    visibility.hide();
    vi.advanceTimersByTime(1_000);
    socket.serverSend("pong");
    vi.advanceTimersByTime(500);
    visibility.show();
    vi.advanceTimersByTime(500);
    socket.serverSend("pong");
    vi.advanceTimersByTime(1_000);
    expect(socket.closedWith).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("reconnects when the tab is shown again, and prompts a re-read", () => {
    const visibility = new FakeVisibility();
    createTopicSubscription(URL, onSignal, { ...base, visibility });
    latest().serverOpen();
    latest().serverSend("pong");
    visibility.hide();
    vi.advanceTimersByTime(2_000);
    latest().serverSend("pong");
    vi.advanceTimersByTime(2_000);
    expect(FakeWebSocket.instances).toHaveLength(1);

    visibility.show();
    expect(FakeWebSocket.instances).toHaveLength(2);
    latest().serverOpen();
    expect(events).toEqual([{ reason: "reconnected" }]);
  });

  it("prompts a re-read on return even when no socket had opened before the pause", () => {
    const visibility = new FakeVisibility("hidden");
    createTopicSubscription(URL, onSignal, { ...base, visibility });
    vi.advanceTimersByTime(2_000);
    expect(latest().closedWith?.code).toBe(1000);

    visibility.show();
    latest().serverOpen();
    expect(events).toEqual([{ reason: "reconnected" }]);
  });

  it("treats the paused socket's late close as no loss: no event, no retry while hidden", () => {
    const visibility = new FakeVisibility();
    const onFallback = vi.fn();
    createTopicSubscription(URL, onSignal, { ...base, maxAttempts: 1, visibility, onFallback });
    const paused = latest();
    paused.serverOpen();
    visibility.hide();
    vi.advanceTimersByTime(1_000);
    paused.serverSend("pong");
    vi.advanceTimersByTime(1_000);
    paused.serverClose(1006);
    expect(events).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(FakeWebSocket.instances).toHaveLength(1);

    visibility.show();
    expect(onFallback).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("resumes with its full budget, whatever another subscription on the page remembered", () => {
    const fallbackMemory = new Map<string, number>();
    const visibility = new FakeVisibility();
    const onFallback = vi.fn();
    createTopicSubscription(URL, onSignal, { ...base, fallbackMemory, visibility, onFallback });
    latest().serverOpen();
    latest().serverSend("pong");
    visibility.hide();
    vi.advanceTimersByTime(1_000);
    latest().serverSend("pong");
    vi.advanceTimersByTime(1_000); // paused

    // Another topic on the same origin gives up without ever connecting.
    createTopicSubscription("wss://api.example.test/realtime/cire%3Awedding%3Awed_9", onSignal, {
      ...base,
      fallbackMemory,
    });
    for (let attempt = 0; attempt < base.maxAttempts; attempt += 1) {
      latest().serverClose(1006);
      vi.advanceTimersByTime(1_000);
    }

    visibility.show();
    const instances = FakeWebSocket.instances.length;
    latest().serverClose(1006); // the first attempt after waking fails
    expect(onFallback).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(FakeWebSocket.instances).toHaveLength(instances + 1);
  });

  it("keeps pinging in a hidden tab when told not to pause", () => {
    const visibility = new FakeVisibility();
    createTopicSubscription(URL, onSignal, { ...base, visibility, pauseWhenHidden: false });
    const socket = latest();
    socket.serverOpen();
    visibility.hide();
    for (let tick = 0; tick < 5; tick += 1) {
      vi.advanceTimersByTime(1_000);
      socket.serverSend("pong");
    }
    expect(socket.closedWith).toBeNull();
    expect(socket.sent).toHaveLength(5);
  });

  it("close() while a pause is pending leaves no timer and ignores the tab's return", () => {
    const visibility = new FakeVisibility();
    const subscription = createTopicSubscription(URL, onSignal, { ...base, visibility });
    latest().serverOpen();
    visibility.hide();
    subscription.close();
    expect(vi.getTimerCount()).toBe(0);
    visibility.show();
    vi.advanceTimersByTime(10_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

describe("createTopicSubscription after a fallback in the same tab", () => {
  const OTHER = "wss://api.example.test/realtime/cire%3Awedding%3Awed_2";

  /** Refuse every attempt (never open) until `onFallback` fires. */
  function exhaust(fallbackMemory: Map<string, number>) {
    const onFallback = vi.fn();
    createTopicSubscription(URL, onSignal, { ...base, fallbackMemory, onFallback });
    for (let attempt = 0; attempt < base.maxAttempts; attempt += 1) {
      latest().serverClose(1006);
      vi.advanceTimersByTime(1_000);
    }
    expect(onFallback).toHaveBeenCalledTimes(1);
  }

  it("makes one attempt, not maxAttempts, at the same origin within the window", () => {
    const fallbackMemory = new Map<string, number>();
    exhaust(fallbackMemory);
    const before = FakeWebSocket.instances.length;

    const onFallback = vi.fn();
    createTopicSubscription(OTHER, onSignal, { ...base, fallbackMemory, onFallback });
    latest().serverClose(1006);
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(before + 1);
  });

  it("forgets the fallback once its window has passed", () => {
    const fallbackMemory = new Map<string, number>();
    exhaust(fallbackMemory);
    vi.advanceTimersByTime(5 * 60_000 + 1);

    const onFallback = vi.fn();
    createTopicSubscription(OTHER, onSignal, { ...base, fallbackMemory, onFallback });
    latest().serverClose(1006);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("keeps the full budget after a fallback from a socket that had opened", () => {
    const fallbackMemory = new Map<string, number>();
    createTopicSubscription(URL, onSignal, { ...base, fallbackMemory });
    latest().serverOpen();
    latest().serverClose(1008);

    const onFallback = vi.fn();
    createTopicSubscription(OTHER, onSignal, { ...base, fallbackMemory, onFallback });
    latest().serverClose(1006);
    expect(onFallback).not.toHaveBeenCalled();
  });

  it("forgets the fallback once a socket at that origin answers", () => {
    const fallbackMemory = new Map<string, number>();
    exhaust(fallbackMemory);
    createTopicSubscription(OTHER, onSignal, { ...base, fallbackMemory });
    latest().serverOpen();
    latest().serverSend("pong");

    const onFallback = vi.fn();
    createTopicSubscription(URL, onSignal, { ...base, fallbackMemory, onFallback });
    latest().serverClose(1006);
    expect(onFallback).not.toHaveBeenCalled();
  });
});
