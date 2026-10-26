/**
 * The repository patches drizzle-orm (patches/drizzle-orm@1.0.0-rc.5.patch) so
 * that no error it builds and no query it logs carries a bound value: on a
 * failed write those are guest names, emails and answers. cire's
 * `query-error.test.ts` proves it for `DrizzleQueryError` against a real D1
 * failure. These cover the two other places the installed drizzle formats
 * parameters: the error the Effect drivers raise, and the logger a
 * `logger: true` client writes through. Each fails the day the patch stops
 * applying to them.
 */

import { DefaultLogger } from "drizzle-orm";
import { describe, expect, it } from "vitest";

const NAME = "Annabelle Quigley-Smythe";

const effectErrors = await import("drizzle-orm/effect-core/errors").then(
  (module) => ({ module, loadError: undefined }),
  (loadError: unknown) => ({ module: undefined, loadError }),
);

describe("drizzle's Effect query error", () => {
  it("loads with this repository's Effect", () => {
    expect(effectErrors.loadError).toBeUndefined();
  });

  it.skipIf(!effectErrors.module)(
    "keeps the bound value out of its message, string form, JSON and fields",
    () => {
      const error = new effectErrors.module!.EffectDrizzleQueryError({
        query: "insert into guests (name) values (?)",
        params: [NAME],
        cause: new Error("UNIQUE constraint failed: guests.name"),
      });
      expect(error.message).toBe("Failed query: insert into guests (name) values (?)");
      expect(String(error)).not.toContain(NAME);
      expect(JSON.stringify(error)).not.toContain(NAME);
      expect(Object.keys(error)).not.toContain("params");
    },
  );
});

describe("drizzle's default query logger", () => {
  it("writes the statement without its bound values", () => {
    const written: string[] = [];
    new DefaultLogger({ writer: { write: (line: string) => written.push(line) } }).logQuery(
      "select * from guests where name = ?",
      [NAME],
    );
    expect(written).toEqual(["Query: select * from guests where name = ?"]);
  });
});
