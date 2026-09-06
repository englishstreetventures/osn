import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { sql } from "drizzle-orm";
import { Effect } from "effect";
import { Miniflare } from "miniflare";

import {
  createSessionRoutedClient,
  D1_SESSION_CONSTRAINT,
  runInD1Session,
  withD1Session,
  type D1QueryClient,
} from "../../src/db/d1-session";
import { createD1Db } from "../../src/db/index";
import type { Db } from "../../src/db/index";

// Two halves. The routing tests use recording stand-ins, because what matters
// there is WHICH client each query reached, which a real D1 will not tell you.
// The integration half then runs the same shim against a real workerd-backed D1
// through Miniflare, which is the only way to prove a `D1DatabaseSession` really
// satisfies everything Drizzle's D1 driver asks of a database.

/** A client that records the queries it was handed and nothing else. */
function recordingClient(name: string, log: string[]): D1QueryClient {
  return {
    prepare: (query: string) => {
      log.push(`${name}:prepare:${query}`);
      return { query } as unknown as D1PreparedStatement;
    },
    batch: async <T>(statements: D1PreparedStatement[]) => {
      log.push(`${name}:batch:${statements.length}`);
      return [] as unknown as D1Result<T>[];
    },
  };
}

describe("session routing", () => {
  it("falls back to the raw binding when no session is in scope", () => {
    const log: string[] = [];
    const client = createSessionRoutedClient(recordingClient("binding", log));

    client.prepare("select 1");

    expect(log).toEqual(["binding:prepare:select 1"]);
  });

  it("routes prepare and batch to the session in scope", async () => {
    const log: string[] = [];
    const client = createSessionRoutedClient(recordingClient("binding", log));
    const session = recordingClient("session", log);

    await withD1Session(session, async () => {
      client.prepare("select 1");
      await client.batch([]);
    });

    expect(log).toEqual(["session:prepare:select 1", "session:batch:0"]);
  });

  it("restores the fallback once the session scope ends", async () => {
    const log: string[] = [];
    const client = createSessionRoutedClient(recordingClient("binding", log));

    await withD1Session(recordingClient("session", log), async () => {
      client.prepare("inside");
    });
    client.prepare("after");

    expect(log).toEqual(["session:prepare:inside", "binding:prepare:after"]);
  });

  it("keeps concurrent sessions apart", async () => {
    // The property the whole design rests on: the app graph — and so the
    // Drizzle handle — is shared by every request an isolate serves at once, so
    // if two in-flight requests could see each other's session, one request's
    // reads could be served from a replica pinned to the OTHER request's
    // (older) bookmark, quietly losing read-your-writes. Interleaved on
    // purpose, with a yield between the two queries of each "request".
    const log: string[] = [];
    const client = createSessionRoutedClient(recordingClient("binding", log));

    const request = (name: string) =>
      withD1Session(recordingClient(name, log), async () => {
        client.prepare("first");
        await Promise.resolve();
        client.prepare("second");
      });

    await Promise.all([request("a"), request("b")]);

    expect(log.filter((entry) => entry.startsWith("a:"))).toEqual([
      "a:prepare:first",
      "a:prepare:second",
    ]);
    expect(log.filter((entry) => entry.startsWith("b:"))).toEqual([
      "b:prepare:first",
      "b:prepare:second",
    ]);
  });

  it("opens every session with the first-primary constraint", () => {
    // The constant is a correctness decision, not a tuning knob: `first-primary`
    // is what makes a request observe every write committed before it started
    // (see the module docs). Assert both the value and that `runInD1Session`
    // actually hands it to `withSession` — a session opened unconstrained would
    // look identical from the outside until a replica served a stale read.
    const constraints: string[] = [];
    const log: string[] = [];
    const session = recordingClient("session", log);
    const fake = {
      withSession: (constraint: string) => {
        constraints.push(constraint);
        return session;
      },
    } as unknown as D1Database;

    const client = createSessionRoutedClient(recordingClient("binding", log));
    runInD1Session(fake, () => {
      client.prepare("select 1");
    });

    expect(D1_SESSION_CONSTRAINT).toBe("first-primary");
    expect(constraints).toEqual(["first-primary"]);
    expect(log).toEqual(["session:prepare:select 1"]);
  });

  it("survives the Effect scheduler, which is what every service query runs on", async () => {
    // Services never call the driver directly — every read goes through
    // `dbQuery`, i.e. an `Effect.promise` thunk run by Effect's fiber scheduler,
    // which batches work from all live fibers into shared microtask flushes.
    // That is precisely where an async-context mechanism can lose or cross its
    // stores, so assert it here rather than trusting it.
    const log: string[] = [];
    const client = createSessionRoutedClient(recordingClient("binding", log));

    const query = (label: string) =>
      Effect.promise(async () => {
        client.prepare(label);
      });

    const request = (name: string) =>
      withD1Session(recordingClient(name, log), () =>
        Effect.runPromise(
          Effect.gen(function* () {
            yield* query("first");
            yield* Effect.yieldNow();
            yield* query("second");
          }),
        ),
      );

    await Promise.all([request("a"), request("b")]);

    expect(log.filter((entry) => entry.startsWith("a:"))).toEqual([
      "a:prepare:first",
      "a:prepare:second",
    ]);
    expect(log.filter((entry) => entry.startsWith("b:"))).toEqual([
      "b:prepare:first",
      "b:prepare:second",
    ]);
  });
});

// Same cold-start reasoning as `d1-integration.test.ts`: booting workerd on a
// fresh CI runner can take several seconds, well past bun's 5_000ms default.
const MF_TIMEOUT_MS = 30_000;

let mf: Miniflare;
let d1: D1Database;

describe("against a real D1", () => {
  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DB: ":memory:" },
    });
    d1 = (await mf.getD1Database("DB")) as unknown as D1Database;
    await d1.prepare("create table probe (id text primary key, label text not null)").run();
  }, MF_TIMEOUT_MS);

  afterAll(async () => {
    // Disposing poisons every D1 stub this instance handed out, so only once
    // the suite is done and nothing is in flight.
    await mf?.dispose();
  }, MF_TIMEOUT_MS);

  it("exposes withSession, and a session answers prepare and batch", () => {
    const session = d1.withSession(D1_SESSION_CONSTRAINT);

    expect(typeof session.prepare).toBe("function");
    expect(typeof session.batch).toBe("function");
  });

  it(
    "reads back its own writes through a Drizzle handle built over the shim",
    async () => {
      // The end-to-end shape of production: one Drizzle handle over the shim,
      // built once, with the session established per invocation around it.
      const db: Db = createD1Db(createSessionRoutedClient(d1));

      await runInD1Session(d1, async () => {
        await db.run(sql`insert into probe (id, label) values ('p1', 'written in session')`);
        const rows = await db.all<{ label: string }>(sql`select label from probe where id = 'p1'`);
        expect(rows).toEqual([{ label: "written in session" }]);
      });
    },
    MF_TIMEOUT_MS,
  );

  it(
    "routes a batch through the session too",
    async () => {
      const db: Db = createD1Db(createSessionRoutedClient(d1));

      await runInD1Session(d1, async () => {
        // `.batch()` is the D1-only driver path (bun:sqlite has none), and it is
        // the second of the two methods the shim forwards, so it needs its own
        // coverage against a real session.
        await (db as unknown as { batch: (s: unknown[]) => Promise<unknown[]> }).batch([
          db.run(sql`insert into probe (id, label) values ('p2', 'batched')`),
          db.run(sql`insert into probe (id, label) values ('p3', 'batched')`),
        ]);
        const rows = await db.all<{ id: string }>(
          sql`select id from probe where label = 'batched' order by id`,
        );
        expect(rows).toEqual([{ id: "p2" }, { id: "p3" }]);
      });
    },
    MF_TIMEOUT_MS,
  );

  it(
    "advances the session's bookmark as the request queries",
    async () => {
      // The bookmark is the whole mechanism: it is what a replica has to have
      // caught up to before it may serve the session's later reads. Holding the
      // session (which is why `withD1Session` exists next to `runInD1Session`)
      // lets the test watch it go from "nothing read yet" to a real position.
      const session = d1.withSession(D1_SESSION_CONSTRAINT);
      const db: Db = createD1Db(createSessionRoutedClient(d1));

      expect(session.getBookmark()).toBeNull();

      await withD1Session(session, async () => {
        await db.all(sql`select label from probe limit 1`);
      });

      expect(session.getBookmark()).not.toBeNull();
    },
    MF_TIMEOUT_MS,
  );

  it(
    "needs nothing from its client but prepare and batch",
    async () => {
      // `D1QueryClient` is a *reading* of Drizzle's D1 driver — that it calls
      // `prepare` and `batch` and nothing else — and the whole design collapses
      // if that stops being true, because a `D1DatabaseSession` has no other
      // method to offer. `drizzle-orm` is on a caret range, so a minor bump
      // could add an `exec`/`dump` call path silently. This fails loudly if it
      // ever does.
      const touched = new Set<string>();
      const guarded = new Proxy(d1 as object, {
        get(target, prop, receiver) {
          const key = String(prop);
          touched.add(key);
          if (key !== "prepare" && key !== "batch") {
            throw new Error(
              `Drizzle's D1 driver reached for \`${key}\`, which a D1DatabaseSession does not have`,
            );
          }
          const value = Reflect.get(target, prop, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as unknown as D1QueryClient;

      const db: Db = createD1Db(guarded);

      await db.run(sql`insert into probe (id, label) values ('p5', 'guarded')`);
      const rows = await db.all<{ label: string }>(sql`select label from probe where id = 'p5'`);
      expect(rows).toEqual([{ label: "guarded" }]);

      await (db as unknown as { batch: (s: unknown[]) => Promise<unknown[]> }).batch([
        db.run(sql`insert into probe (id, label) values ('p6', 'guarded batch')`),
      ]);

      expect([...touched].toSorted()).toEqual(["batch", "prepare"]);
    },
    MF_TIMEOUT_MS,
  );

  it(
    "still works with no session in scope",
    async () => {
      // The degraded path: if the async context is ever lost, every query goes
      // straight to the binding — which is exactly the behaviour before this
      // change, so losing the context costs latency, never correctness.
      const db: Db = createD1Db(createSessionRoutedClient(d1));

      await db.run(sql`insert into probe (id, label) values ('p4', 'no session')`);
      const rows = await db.all<{ label: string }>(sql`select label from probe where id = 'p4'`);

      expect(rows).toEqual([{ label: "no session" }]);
    },
    MF_TIMEOUT_MS,
  );
});
