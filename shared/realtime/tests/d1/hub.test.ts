import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { Miniflare } from "miniflare";

/**
 * TopicHub on real workerd. The hibernation API — tags, the auto-response,
 * `getWebSockets`, the close handshake — exists only in the runtime, so a
 * stand-in would test the stand-in. Same tier and build recipe as
 * `osn/api/tests/d1/waituntil.test.ts`.
 */

const ORIGIN = "https://host.example.test";
const HOOK_TIMEOUT_MS = 30_000;
let mf: Miniflare;

beforeAll(async () => {
  const built = await Bun.build({
    entrypoints: [`${import.meta.dirname}/fixtures/hub-worker.ts`],
    format: "esm",
    target: "node",
    // Provided by workerd itself: there is nothing to bundle.
    external: ["cloudflare:workers"],
  });
  if (!built.success) throw new AggregateError(built.logs, "fixture build failed");
  mf = new Miniflare({
    modules: true,
    script: await built.outputs[0]!.text(),
    // cire-api's date and flags (`cire/api/wrangler.toml`): before the
    // runtime answers a close by itself, so the hub's own reply is exercised.
    compatibilityDate: "2025-03-01",
    compatibilityFlags: ["nodejs_compat", "nodejs_compat_populate_process_env"],
    durableObjects: {
      HUB: { className: "ObservedHub", useSQLite: true },
      SMALL_HUB: { className: "SmallHub", useSQLite: true },
      STALE_HUB: { className: "StaleHub", useSQLite: true },
      SUBJECT_HUB: { className: "SubjectHub", useSQLite: true },
    },
  });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await mf?.dispose();
});

const tick = (ms = 150) => new Promise((resolve) => setTimeout(resolve, ms));
const at = (topic: string, action: string, query = "") =>
  `http://hub.example.test/${action}/${encodeURIComponent(topic)}${query}`;

async function open(topic: string, subject: string, query = "") {
  const res = await mf.dispatchFetch(at(topic, "subscribe", query), {
    headers: { Upgrade: "websocket", Origin: ORIGIN, "x-test-subject": subject },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error(`no socket: status ${res.status}`);
  const frames: string[] = [];
  const closes: number[] = [];
  ws.addEventListener("message", (event) => frames.push(String(event.data)));
  ws.addEventListener("close", (event) => closes.push(event.code));
  ws.accept();
  return { ws, frames, closes, status: res.status };
}

async function stats(topic: string, query = "") {
  const res = await mf.dispatchFetch(at(topic, "stats", query));
  return (await res.json()) as { sockets: number; wakes: number };
}

async function publishTo(topic: string, query = "") {
  const res = await mf.dispatchFetch(at(topic, "publish", query));
  return (await res.json()) as { reached: number };
}

describe("TopicHub", () => {
  it("upgrades an admitted request to a 101 with a socket", async () => {
    const socket = await open("cire:wedding:wed_up", "usr_a");
    expect(socket.status).toBe(101);
    expect((await stats("cire:wedding:wed_up")).sockets).toBe(1);
  });

  it("answers ping with pong without waking the hub", async () => {
    const socket = await open("cire:wedding:wed_ping", "usr_a");
    socket.ws.send("ping");
    await tick();
    expect(socket.frames).toEqual(["pong"]);
    expect((await stats("cire:wedding:wed_ping")).wakes).toBe(0);
  });

  it("answers only the exact frame: PING is an unexpected frame", async () => {
    const socket = await open("cire:wedding:wed_shout", "usr_a");
    socket.ws.send("PING");
    await tick();
    expect(socket.frames).toEqual([]);
    expect(socket.closes).toEqual([1008]);
  });

  it("sends a published signal to every socket on the topic and none elsewhere", async () => {
    const a = await open("cire:wedding:wed_pub", "usr_a");
    const b = await open("cire:wedding:wed_pub", "usr_b");
    const other = await open("cire:wedding:wed_other", "usr_a");

    expect(await publishTo("cire:wedding:wed_pub")).toEqual({ reached: 2 });
    await tick();

    for (const socket of [a, b]) {
      expect(socket.frames).toHaveLength(1);
      expect(JSON.parse(socket.frames[0]!)).toMatchObject({
        topic: "cire:wedding:wed_pub",
        kind: "members-changed",
      });
    }
    expect(other.frames).toEqual([]);
  });

  it("evicts only the named subject, after it has the signal", async () => {
    const stays = await open("cire:wedding:wed_evict", "usr_stays");
    const goes = await open("cire:wedding:wed_evict", "usr_goes");

    await publishTo("cire:wedding:wed_evict", "?evict=usr_goes");
    await tick();

    expect(goes.frames).toHaveLength(1);
    expect(goes.closes).toEqual([4001]);
    expect(stays.frames).toHaveLength(1);
    expect(stays.closes).toEqual([]);
  });

  it("reaches nobody on a topic nobody holds", async () => {
    expect(await publishTo("cire:wedding:wed_empty")).toEqual({ reached: 0 });
  });

  it("takes a publish from the shared helper over a real binding", async () => {
    const socket = await open("cire:wedding:wed_helper", "usr_a");
    const res = await mf.dispatchFetch(at("cire:wedding:wed_helper", "helper-publish"));
    await tick();
    expect(res.status).toBe(204);
    expect(socket.frames).toHaveLength(1);
  });

  it("closes the socket over the topic cap with 1008 and keeps the others", async () => {
    const first = await open("cire:wedding:wed_cap", "usr_1", "?hub=small");
    const second = await open("cire:wedding:wed_cap", "usr_2", "?hub=small");
    const third = await open("cire:wedding:wed_cap", "usr_3", "?hub=small");
    await tick();
    expect(first.closes).toEqual([]);
    expect(second.closes).toEqual([]);
    expect(third.closes).toEqual([1008]);
  });

  it("makes room at the cap by closing a socket that stopped pinging", async () => {
    const quiet = await open("cire:wedding:wed_stale", "usr_quiet", "?hub=stale");
    const pinging = await open("cire:wedding:wed_stale", "usr_pinging", "?hub=stale");
    await tick(120);
    pinging.ws.send("ping");
    await tick(20);
    const newcomer = await open("cire:wedding:wed_stale", "usr_new", "?hub=stale");
    await tick();
    expect(quiet.closes).toEqual([4002]);
    expect(pinging.closes).toEqual([]);
    expect(newcomer.closes).toEqual([]);
  });

  it("caps one subject's sockets without refusing anyone else", async () => {
    const one = await open("cire:wedding:wed_subject", "usr_many", "?hub=subject");
    const two = await open("cire:wedding:wed_subject", "usr_many", "?hub=subject");
    const three = await open("cire:wedding:wed_subject", "usr_many", "?hub=subject");
    const someoneElse = await open("cire:wedding:wed_subject", "usr_other", "?hub=subject");
    await tick();
    expect(one.closes).toEqual([]);
    expect(two.closes).toEqual([]);
    expect(three.closes).toEqual([1008]);
    expect(someoneElse.closes).toEqual([]);
  });

  it("closes a socket that sends anything but ping, with 1008", async () => {
    const socket = await open("cire:wedding:wed_chatty", "usr_a");
    socket.ws.send("hello");
    await tick();
    expect(socket.closes).toEqual([1008]);
  });

  it("answers a client's close with its code and forgets the socket", async () => {
    const socket = await open("cire:wedding:wed_bye", "usr_a");
    socket.ws.close(1000, "bye");
    await tick(300);
    expect(socket.closes).toEqual([1000]);
    expect((await stats("cire:wedding:wed_bye")).sockets).toBe(0);
  });

  it("refuses an upgrade that lacks the hub headers", async () => {
    const res = await mf.dispatchFetch(at("cire:wedding:wed_raw", "raw"));
    expect(res.status).toBe(400);
    expect(res.webSocket).toBeFalsy();
  });

  it("refuses a subject too long to tag, so subscribe answers 503", async () => {
    const res = await mf.dispatchFetch(at("cire:wedding:wed_long", "subscribe"), {
      headers: { Upgrade: "websocket", Origin: ORIGIN, "x-test-subject": "u".repeat(201) },
    });
    expect(res.status).toBe(503);
    expect(res.webSocket).toBeFalsy();
  });
});
