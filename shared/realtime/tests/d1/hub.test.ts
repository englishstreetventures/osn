import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { Miniflare } from "miniflare";

/**
 * TopicHub on real workerd. The hibernation API — tags, the auto-response,
 * `getWebSockets`, the close handshake — exists only in the runtime, so a
 * stand-in would test the stand-in. Same tier and build recipe as
 * `osn/api/tests/d1/waituntil.test.ts`.
 *
 * Every assertion waits for its event or fails at a deadline. An absence is
 * asserted only after a later event on the same socket has arrived.
 */

const ORIGIN = "https://host.example.test";
const HOOK_TIMEOUT_MS = 30_000;
const TEST_TIMEOUT_MS = 15_000;
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
      AGED_HUB: { className: "AgedHub", useSQLite: true },
      CROWDED_HUB: { className: "CrowdedHub", useSQLite: true },
      STALE_SUBJECT_HUB: { className: "StaleSubjectHub", useSQLite: true },
    },
  });
}, HOOK_TIMEOUT_MS);

afterAll(async () => {
  await mf?.dispose();
});

/** Lets wall-clock time pass. Used only to make a socket older, never to wait for an event. */
const elapse = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll in short steps until `check` holds, or fail after `timeoutMs`. */
async function until(check: () => boolean, what: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await elapse(5);
  }
}

const at = (topic: string, action: string, query = "") =>
  `http://hub.example.test/${action}/${encodeURIComponent(topic)}${query}`;

type MiniflareSocket = NonNullable<Awaited<ReturnType<Miniflare["dispatchFetch"]>>["webSocket"]>;

interface Socket {
  readonly ws: MiniflareSocket;
  readonly frames: string[];
  readonly closes: number[];
  readonly status: number;
  readonly capacity: string | null;
}

async function open(topic: string, subject: string, query = "", pinged = true): Promise<Socket> {
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
  // The real client pings on an interval. workerd withholds a socket's FIN
  // after the close handshake until that socket has sent a frame, and Bun
  // 1.4.4 waits for the FIN before it reports `close`. One ping, answered by
  // the auto-response without waking the hub, gives this socket that frame.
  if (pinged) {
    ws.send("ping");
    await until(() => frames.includes("pong"), "the pong to open()'s ping");
    frames.length = 0;
  }
  return {
    ws,
    frames,
    closes,
    status: res.status,
    capacity: res.headers.get("x-realtime-capacity"),
  };
}

const framed = (socket: Socket, count: number, name: string) =>
  until(() => socket.frames.length >= count, `${count} frame(s) on ${name}`);
const closed = (socket: Socket, name: string) =>
  until(() => socket.closes.length > 0, `a close on ${name}`);

async function stats(topic: string, query = "") {
  const res = await mf.dispatchFetch(at(topic, "stats", query));
  return (await res.json()) as { sockets: number; wakes: number };
}

async function publishTo(topic: string, query = "") {
  const res = await mf.dispatchFetch(at(topic, "publish", query));
  return (await res.json()) as { reached: number };
}

async function helperPublish(topic: string, query = "") {
  const res = await mf.dispatchFetch(at(topic, "helper-publish", query));
  expect(res.status).toBe(204);
}

describe("TopicHub", () => {
  it("upgrades an admitted request to a 101 with a socket", async () => {
    const socket = await open("cire:wedding:wed_up", "usr_a");
    expect(socket.status).toBe(101);
    expect(socket.capacity).toBeNull();
    expect((await stats("cire:wedding:wed_up")).sockets).toBe(1);
  });

  it("answers ping with pong without waking the hub", async () => {
    const socket = await open("cire:wedding:wed_ping", "usr_a");
    socket.ws.send("ping");
    await framed(socket, 1, "the pinging socket");
    expect(socket.frames).toEqual(["pong"]);
    expect((await stats("cire:wedding:wed_ping")).wakes).toBe(0);
  });

  it(
    "sends a published signal to every socket on the topic and none elsewhere",
    async () => {
      const a = await open("cire:wedding:wed_pub", "usr_a");
      const b = await open("cire:wedding:wed_pub", "usr_b");
      const other = await open("cire:wedding:wed_other", "usr_a");

      expect(await publishTo("cire:wedding:wed_pub")).toEqual({ reached: 2 });
      await framed(a, 1, "a");
      await framed(b, 1, "b");
      for (const socket of [a, b]) {
        expect(JSON.parse(socket.frames[0]!)).toMatchObject({
          topic: "cire:wedding:wed_pub",
          kind: "members-changed",
        });
      }

      // Anything wed_pub's publish sent to `other` would arrive before this.
      await publishTo("cire:wedding:wed_other");
      await framed(other, 1, "other");
      expect(other.frames).toHaveLength(1);
      expect(JSON.parse(other.frames[0]!)).toMatchObject({ topic: "cire:wedding:wed_other" });
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "evicts only the named subject, after it has the signal",
    async () => {
      const stays = await open("cire:wedding:wed_evict", "usr_stays");
      const goes = await open("cire:wedding:wed_evict", "usr_goes");

      await publishTo("cire:wedding:wed_evict", "?evict=usr_goes");
      await closed(goes, "goes");
      expect(goes.frames).toHaveLength(1);
      expect(goes.closes).toEqual([4001]);

      await publishTo("cire:wedding:wed_evict");
      await framed(stays, 2, "stays");
      expect(stays.closes).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "evicts through the shared publish helper over a real binding",
    async () => {
      const stays = await open("cire:wedding:wed_helper", "usr_stays");
      const goes = await open("cire:wedding:wed_helper", "usr_goes");

      await helperPublish("cire:wedding:wed_helper", "?evict=usr_goes");
      await closed(goes, "goes");
      expect(goes.frames).toHaveLength(1);
      expect(goes.closes).toEqual([4001]);
      await framed(stays, 1, "stays");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "revokes a subject with 1008 after it has the signal, through the helper",
    async () => {
      const stays = await open("cire:wedding:wed_revoke", "usr_stays");
      const goes = await open("cire:wedding:wed_revoke", "usr_goes");

      await helperPublish("cire:wedding:wed_revoke", "?revoke=usr_goes");
      await closed(goes, "goes");
      expect(goes.frames).toHaveLength(1);
      expect(goes.closes).toEqual([1008]);

      await helperPublish("cire:wedding:wed_revoke");
      await framed(stays, 2, "stays");
      expect(stays.closes).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "revokes with 1008 a subject also named for eviction",
    async () => {
      const both = await open("cire:wedding:wed_both", "usr_both");

      await publishTo("cire:wedding:wed_both", "?evict=usr_both&revoke=usr_both");
      await closed(both, "both");
      expect(both.frames).toHaveLength(1);
      expect(both.closes).toEqual([1008]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "revokes with 1008, and without the signal, a subject whose socket is past its maximum age",
    async () => {
      const old = await open("cire:wedding:wed_aged_revoke", "usr_old", "?hub=aged");
      await elapse(400); // AgedHub's maxSocketAgeMs is 300
      const fresh = await open("cire:wedding:wed_aged_revoke", "usr_fresh", "?hub=aged");

      await publishTo("cire:wedding:wed_aged_revoke", "?hub=aged&revoke=usr_old");
      await closed(old, "old");
      expect(old.closes).toEqual([1008]);
      expect(old.frames).toEqual([]);
      await framed(fresh, 1, "fresh");
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "still sends and evicts when a socket it has just closed is on the topic",
    async () => {
      const gone = await open("cire:wedding:wed_closing", "usr_closed");
      const goes = await open("cire:wedding:wed_closing", "usr_goes");
      const stays = await open("cire:wedding:wed_closing", "usr_stays");

      const res = await mf.dispatchFetch(
        at("cire:wedding:wed_closing", "close-then-publish", "?closed=usr_closed&evict=usr_goes"),
      );
      expect(await res.json()).toEqual({ reached: 2 });

      await closed(goes, "goes");
      expect(goes.closes).toEqual([4001]);
      await framed(stays, 1, "stays");
      await closed(gone, "the closed socket");
      expect(gone.frames).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "closes a socket older than its maximum age with 4001 instead of sending it the signal",
    async () => {
      const old = await open("cire:wedding:wed_aged", "usr_old", "?hub=aged");
      await elapse(400); // AgedHub's maxSocketAgeMs is 300
      const fresh = await open("cire:wedding:wed_aged", "usr_fresh", "?hub=aged");

      expect(await publishTo("cire:wedding:wed_aged", "?hub=aged")).toEqual({ reached: 1 });
      await closed(old, "old");
      expect(old.closes).toEqual([4001]);
      expect(old.frames).toEqual([]);
      await framed(fresh, 1, "fresh");
      expect(fresh.closes).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "closes the socket over the topic cap with 1008, says so on its 101, and keeps the others",
    async () => {
      const first = await open("cire:wedding:wed_cap", "usr_1", "?hub=small");
      const second = await open("cire:wedding:wed_cap", "usr_2", "?hub=small");
      // The newcomer is closed before its 101 is usable and never sends a frame,
      // so no ping can make its close visible (see open()). The cap is checked
      // through the socket count instead; the close code is not asserted here.
      const third = await open("cire:wedding:wed_cap", "usr_3", "?hub=small", false);
      expect(first.capacity).toBeNull();
      expect(third.capacity).toBe("topic");
      expect((await stats("cire:wedding:wed_cap", "?hub=small")).sockets).toBe(2);

      await publishTo("cire:wedding:wed_cap", "?hub=small");
      await framed(first, 1, "first");
      await framed(second, 1, "second");
      expect(first.closes).toEqual([]);
      expect(second.closes).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "makes room at the cap by closing a socket that stopped pinging",
    async () => {
      const quiet = await open("cire:wedding:wed_stale", "usr_quiet", "?hub=stale");
      const pinging = await open("cire:wedding:wed_stale", "usr_pinging", "?hub=stale");
      await elapse(1_200); // StaleHub's staleAfterMs is 1 000
      pinging.ws.send("ping");
      await framed(pinging, 1, "pinging");
      const newcomer = await open("cire:wedding:wed_stale", "usr_new", "?hub=stale");
      expect(newcomer.capacity).toBeNull();
      await closed(quiet, "quiet");
      expect(quiet.closes).toEqual([4002]);

      await publishTo("cire:wedding:wed_stale", "?hub=stale");
      await framed(pinging, 2, "pinging");
      await framed(newcomer, 1, "newcomer");
      expect(pinging.closes).toEqual([]);
      expect(newcomer.closes).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "at the member cap, closes that member's least recently seen socket and keeps the newcomer",
    async () => {
      const one = await open("cire:wedding:wed_subject", "usr_many", "?hub=subject");
      await elapse(5); // distinct accept times, so the order is not a tie
      const two = await open("cire:wedding:wed_subject", "usr_many", "?hub=subject");
      await elapse(5);
      const three = await open("cire:wedding:wed_subject", "usr_many", "?hub=subject");
      const someoneElse = await open("cire:wedding:wed_subject", "usr_other", "?hub=subject");
      expect(three.capacity).toBe("subject");
      await closed(one, "one");
      expect(one.closes).toEqual([1008]);

      await publishTo("cire:wedding:wed_subject", "?hub=subject");
      for (const [socket, name] of [
        [two, "two"],
        [three, "three"],
        [someoneElse, "someone else"],
      ] as const) {
        await framed(socket, 1, name);
        expect(socket.closes).toEqual([]);
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "on a full topic, a member at their own cap loses only their oldest socket, not the newcomer",
    async () => {
      const other = await open("cire:wedding:wed_crowded", "usr_other", "?hub=crowded");
      const first = await open("cire:wedding:wed_crowded", "usr_member", "?hub=crowded");
      await elapse(5);
      const second = await open("cire:wedding:wed_crowded", "usr_member", "?hub=crowded");
      expect(second.capacity).toBe("subject");
      await closed(first, "first");
      expect(first.closes).toEqual([1008]);

      await publishTo("cire:wedding:wed_crowded", "?hub=crowded");
      await framed(other, 1, "other");
      await framed(second, 1, "second");
      expect(other.closes).toEqual([]);
      expect(second.closes).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "culls a member's own stale socket at their cap with 4002, leaving no cap hit",
    async () => {
      const quiet = await open("cire:wedding:wed_own_stale", "usr_member", "?hub=stale-subject");
      await elapse(1_200); // StaleSubjectHub's staleAfterMs is 1 000
      const fresh = await open("cire:wedding:wed_own_stale", "usr_member", "?hub=stale-subject");
      expect(fresh.capacity).toBeNull();
      await closed(quiet, "quiet");
      expect(quiet.closes).toEqual([4002]);

      await publishTo("cire:wedding:wed_own_stale", "?hub=stale-subject");
      await framed(fresh, 1, "fresh");
      expect(fresh.closes).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "uses the ping, not only accept order, to find the least recently seen socket",
    async () => {
      const a = await open("cire:wedding:wed_subject_ping", "usr_many", "?hub=subject");
      const b = await open("cire:wedding:wed_subject_ping", "usr_many", "?hub=subject");
      // A clear gap before the ping, so its auto-response timestamp cannot tie
      // with `b`'s accept time at millisecond resolution.
      await elapse(50);
      a.ws.send("ping");
      await framed(a, 1, "a");
      const c = await open("cire:wedding:wed_subject_ping", "usr_many", "?hub=subject");
      await closed(b, "b");
      expect(b.closes).toEqual([1008]);

      await publishTo("cire:wedding:wed_subject_ping", "?hub=subject");
      await framed(a, 2, "a");
      await framed(c, 1, "c");
      expect(a.closes).toEqual([]);
      expect(c.closes).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  it("closes a socket that sends anything but ping, with 1008", async () => {
    const socket = await open("cire:wedding:wed_chatty", "usr_a");
    socket.ws.send("hello");
    await closed(socket, "the chatty socket");
    expect(socket.closes).toEqual([1008]);
  });

  it("answers a client's close with its code and forgets the socket", async () => {
    const socket = await open("cire:wedding:wed_bye", "usr_a");
    socket.ws.close(1000, "bye");
    await closed(socket, "the closing socket");
    expect(socket.closes).toEqual([1000]);
    let sockets = -1;
    const deadline = Date.now() + 5_000;
    while (sockets !== 0 && Date.now() < deadline) {
      sockets = (await stats("cire:wedding:wed_bye")).sockets;
      if (sockets !== 0) await elapse(20);
    }
    expect(sockets).toBe(0);
  });

  it("refuses an upgrade that lacks the hub headers", async () => {
    const res = await mf.dispatchFetch(at("cire:wedding:wed_raw", "raw"));
    expect(res.status).toBe(400);
    expect(res.webSocket).toBeFalsy();
  });

  it("refuses a request that is not an upgrade with 426", async () => {
    const res = await mf.dispatchFetch(
      at("cire:wedding:wed_raw_plain", "raw", "?upgrade=0&subject=usr_a"),
    );
    expect(res.status).toBe(426);
    expect(res.webSocket).toBeFalsy();
  });

  it("refuses an empty subject with 400", async () => {
    const res = await mf.dispatchFetch(at("cire:wedding:wed_raw_empty", "raw", "?subject="));
    expect(res.status).toBe(400);
    expect(res.webSocket).toBeFalsy();
  });

  it.each([
    ["too long to tag", "u".repeat(201)],
    ["an email address", "ada@example.test"],
    ["a name with a space", "Ada Lovelace"],
  ])("refuses a subject that is %s, so subscribe answers 503", async (_label, subject) => {
    const res = await mf.dispatchFetch(at("cire:wedding:wed_bad_subject", "subscribe"), {
      headers: { Upgrade: "websocket", Origin: ORIGIN, "x-test-subject": subject },
    });
    expect(res.status).toBe(503);
    expect(res.webSocket).toBeFalsy();
  });

  it("accepts a subject of exactly 200 characters", async () => {
    const socket = await open("cire:wedding:wed_long_ok", "u".repeat(200));
    expect(socket.status).toBe(101);
  });
});
