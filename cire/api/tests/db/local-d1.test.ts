import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";

import { localD1Binding } from "../../src/db/local-d1";

const seeded = () => {
  const sqlite = new Database(":memory:");
  sqlite.exec("create table t (id text primary key, n integer)");
  sqlite.exec("insert into t values ('a', 1), ('b', 2)");
  return localD1Binding(sqlite);
};

describe("localD1Binding", () => {
  // The arrays-mode path the Effect export takes: prepare, bind, raw.
  it("returns rows as arrays for prepare, bind and raw", async () => {
    const binding = seeded();
    const rows = await binding.prepare("select id, n from t where n > ? order by id").bind(0).raw();
    expect(rows).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  // The session the request shim picks: withSession returns a session that prepares on the same connection.
  it("prepares through a session on the same connection, with no bookmark yet", async () => {
    const binding = seeded();
    const session = binding.withSession("first-primary");
    expect(session.getBookmark()).toBeNull();
    const rows = await session.prepare("select count(*) as c from t").raw();
    expect(rows).toEqual([[2]]);
  });

  // The raw statement can name its columns, as the D1 type's first overload allows.
  it("returns the column names first when asked for them", async () => {
    const binding = seeded();
    const rows = await binding
      .prepare("select id, n from t order by id")
      .raw({ columnNames: true });
    expect(rows).toEqual([
      ["id", "n"],
      ["a", 1],
      ["b", 2],
    ]);
  });

  // Members no Effect path calls throw, so a later stage that reaches one fails at that call.
  it.each([
    ["batch", (b: ReturnType<typeof seeded>) => b.batch([])],
    ["session batch", (b: ReturnType<typeof seeded>) => b.withSession().batch([])],
    ["exec", (b: ReturnType<typeof seeded>) => b.exec("select 1")],
    ["dump", (b: ReturnType<typeof seeded>) => b.dump()],
    ["first", (b: ReturnType<typeof seeded>) => b.prepare("select 1").first()],
    ["run", (b: ReturnType<typeof seeded>) => b.prepare("select 1").run()],
    ["all", (b: ReturnType<typeof seeded>) => b.prepare("select 1").all()],
  ])("%s throws, naming the member, until an Effect path needs it", (name, call) => {
    expect(() => call(seeded())).toThrow(`${name.replace("session ", "")} is not implemented`);
  });
});
