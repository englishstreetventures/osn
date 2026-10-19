import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createTopicSubscription, type SignalEvent } from "../../src/client/subscription";
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
    expect(first.closedWith).not.toBeNull();
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
