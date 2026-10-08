import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { sql } from "drizzle-orm";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { Cause, Effect, Exit } from "effect";
import { Miniflare } from "miniflare";

import { createD1Db, dbQuery, driverErrorText, type Db } from "../../src/db/index";
import { runCire } from "../../src/observability";
import { captureLogs } from "../test-helpers/capture-logs";

// A failed D1 query must not carry its bound values anywhere an error travels:
// its message, `String(e)` (which forty-odd `reason: String(e)` log sites use),
// its JSON form, its own enumerable fields (which the log redactor walks), or
// the pretty cause a span's exception event is built from. The repository
// patches `drizzle-orm` (patches/drizzle-orm@0.45.2.patch) to keep the values
// out of the message and off the enumerable fields; this suite fails the day
// that patch stops applying.

const NAME = "Annabelle Quigley-Smythe";

/** Every rendering of an error these tests expect to be free of `NAME`. */
function renderings(error: unknown): string[] {
  const err = error as Error;
  const pretty = Cause.prettyErrors(Cause.die(error), { includeCauseInStack: true });
  return [
    err.message,
    String(err),
    err.stack ?? "",
    JSON.stringify(err),
    JSON.stringify(Object.fromEntries(Object.entries(err))),
    ...pretty.flatMap((p) => [p.message, p.stack ?? ""]),
    Cause.pretty(Cause.die(error)),
  ];
}

describe("DrizzleQueryError, as patched", () => {
  it("keeps the SQL and drops the bound values from every rendering", () => {
    const error = new DrizzleQueryError("insert into guests (name) values (?)", [NAME]);

    for (const text of renderings(error)) expect(text).not.toContain(NAME);
    expect(error.message).toBe("Failed query: insert into guests (name) values (?)");
    // Still readable by code that asks for it on purpose.
    expect(error.params).toEqual([NAME]);
    expect(Object.keys(error)).not.toContain("params");
  });
});

describe("driverErrorText", () => {
  it("reads a message and its causes by shape, from any realm", () => {
    expect(driverErrorText({ message: "outer", cause: { message: "inner" } })).toBe("outer\ninner");
    expect(driverErrorText(new Error("a", { cause: new Error("b") }))).toBe("a\nb");
  });

  it("skips a message that is not text and still reads the cause", () => {
    expect(driverErrorText({ message: 42, cause: { message: "x" } })).toBe("x");
  });

  it("ends on a cause chain that loops back on itself", () => {
    const looped = new Error("again");
    looped.cause = looped;
    const text = driverErrorText(looped);
    expect(text.split("\n").length).toBeLessThanOrEqual(8);
    expect(text.startsWith("again")).toBe(true);
  });

  it("reads nothing from a value that is not an error", () => {
    expect(driverErrorText("NOT NULL constraint failed")).toBe("");
    expect(driverErrorText(undefined)).toBe("");
  });
});

describe("a real D1 failure", () => {
  let mf: Miniflare;
  let db: Db;

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: "export default { fetch() { return new Response('ok'); } };",
      d1Databases: { DB: "cire-test-query-error" },
    });
    const d1 = await mf.getD1Database("DB");
    await d1.exec("CREATE TABLE people (name TEXT NOT NULL UNIQUE);");
    db = createD1Db(d1);
  }, 30_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  const insert = () => dbQuery(() => db.run(sql`insert into people (name) values (${NAME})`));

  it("fails a unique-constraint write without the bound name in the defect", async () => {
    await Effect.runPromise(insert());
    const exit = await Effect.runPromiseExit(insert().pipe(Effect.withSpan("test.insert")));

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const defect = Cause.squash(exit.cause);
    expect(defect).toBeInstanceOf(DrizzleQueryError);
    for (const text of renderings(defect)) expect(text).not.toContain(NAME);
    // The operator still gets the statement and the database's reason.
    expect(String(defect)).toContain("insert into people");
    expect(Cause.pretty(exit.cause)).toContain("UNIQUE constraint failed");
  });

  it("keeps the database's reason in the cause, where driverErrorText reads it", async () => {
    // The first write may already have run in the test above; either way the
    // second one meets the unique index.
    await Effect.runPromiseExit(insert());
    const exit = await Effect.runPromiseExit(insert());

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const defect = Cause.squash(exit.cause);
    // drizzle's own message names only the statement.
    expect(String(defect)).not.toContain("UNIQUE constraint failed");
    expect(driverErrorText(defect)).toContain("UNIQUE constraint failed: people.name");
    expect(driverErrorText(defect)).not.toContain(NAME);
  });

  it("logs the failure without the bound name", async () => {
    const logs = await captureLogs(() =>
      runCire(
        insert().pipe(
          Effect.catchCause((cause) =>
            Effect.logError("write failed", { reason: String(Cause.squash(cause)) }).pipe(
              Effect.andThen(Effect.logError("write failed", cause)),
            ),
          ),
        ),
      ),
    );

    expect(logs).toContain("write failed");
    expect(logs).not.toContain(NAME);
  });
});
