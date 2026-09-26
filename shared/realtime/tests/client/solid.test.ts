// @vitest-environment happy-dom
import { createRoot, createSignal } from "solid-js";
import { beforeEach, describe, expect, it } from "vitest";

import { useTopic } from "../../src/client/solid";
import type { SignalEvent } from "../../src/client/subscription";
import { FakeSocketClass, FakeWebSocket } from "../support/fake-websocket";

const A = "wss://api.example.test/realtime/cire%3Awedding%3Awed_a";
const B = "wss://api.example.test/realtime/cire%3Awedding%3Awed_b";

beforeEach(() => FakeWebSocket.reset());

function mount(initial: string | null) {
  const events: SignalEvent[] = [];
  let setUrl!: (value: string | null) => void;
  let setTick!: (value: number) => void;
  const dispose = createRoot((disposeRoot) => {
    const [url, writeUrl] = createSignal<string | null>(initial);
    const [tick, writeTick] = createSignal(0);
    setUrl = writeUrl;
    setTick = writeTick;
    // Reads `tick` so a test can re-run the accessor without changing its value.
    useTopic(
      () => (tick() >= 0 ? url() : null),
      (event) => events.push(event),
      {
        WebSocket: FakeSocketClass,
      },
    );
    return disposeRoot;
  });
  return { events, setUrl, setTick, dispose };
}

describe("useTopic", () => {
  it("opens a socket for the URL", () => {
    mount(A);
    expect(FakeWebSocket.instances.map((socket) => socket.url)).toEqual([A]);
  });

  it("opens nothing while the URL is null", () => {
    mount(null);
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("closes the old socket and opens a new one when the URL changes", () => {
    const { setUrl } = mount(A);
    setUrl(B);
    expect(FakeWebSocket.instances.map((socket) => socket.url)).toEqual([A, B]);
    expect(FakeWebSocket.instances[0]?.closedWith?.code).toBe(1000);
  });

  it("keeps the socket when the accessor re-runs to the same URL", () => {
    const { setTick } = mount(A);
    setTick(1);
    setTick(2);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.closedWith).toBeNull();
  });

  it("closes the socket when the URL becomes null", () => {
    const { setUrl } = mount(A);
    setUrl(null);
    expect(FakeWebSocket.instances[0]?.closedWith?.code).toBe(1000);
  });

  it("closes the socket when its owner is disposed", () => {
    const { dispose } = mount(A);
    dispose();
    expect(FakeWebSocket.instances[0]?.closedWith?.code).toBe(1000);
  });

  it("forwards the subscription's events", () => {
    const { events } = mount(A);
    const socket = FakeWebSocket.instances[0]!;
    socket.serverOpen();
    socket.serverSend(
      JSON.stringify({ topic: "cire:wedding:wed_a", kind: "members-changed", at: 1 }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.reason).toBe("message");
  });
});
