import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { ownerSeatSql, SeedInputError } from "../src/seeds";

const seedScript = readFileSync(
  fileURLToPath(new URL("../../../scripts/cire-db-seed.sh", import.meta.url)),
  "utf8",
);

/**
 * The owner-seat statements `scripts/cire-db-seed.sh` runs for a profile id,
 * one per entry: its `--command` string with the seat id and the profile id
 * substituted.
 */
function scriptStatements(profileId: string): string[] {
  const seatId = /^\s*OWNER_SEAT_ID="([^"]+)"$/m.exec(seedScript)?.[1];
  const command = /--command \\\n\s*"(DELETE FROM wedding_hosts[^"]+)"/.exec(seedScript)?.[1];
  if (seatId === undefined || command === undefined) {
    throw new Error("scripts/cire-db-seed.sh no longer holds the owner-seat override");
  }
  return statements(
    command
      .replaceAll("${OWNER_SEAT_ID}", seatId)
      .replaceAll("${CIRE_DEV_OWNER_PROFILE_ID}", profileId),
  );
}

/** Each SQL statement in `sql`, trimmed, with `--` comment lines left out. */
const statements = (sql: string): string[] =>
  sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim().replace(/\s+/g, " "))
    .filter((statement) => statement !== "");

describe("ownerSeatSql", () => {
  test("S6: an invalid profile id is refused, naming the variable only; unset or empty seeds nothing; a valid one gives the seed script's two statements", () => {
    const messages = new Set<string>();
    for (const value of [
      " ",
      "usr_",
      "profile_abc",
      " usr_abc",
      "usr_abc ",
      "usr_abc'; DELETE FROM weddings; --",
      "usr_abc\nDELETE FROM weddings",
      "usr_abc.def",
    ]) {
      let refused: unknown;
      try {
        ownerSeatSql(value);
      } catch (error) {
        refused = error;
      }
      expect(refused).toBeInstanceOf(SeedInputError);
      expect(refused).toMatchObject({ input: "CIRE_DEV_OWNER_PROFILE_ID" });
      messages.add((refused as SeedInputError).message);
    }
    // The value can carry SQL, so the message is the same whatever it is: it never repeats it.
    expect(messages.size).toBe(1);

    // An unset GitHub variable reaches the step as an empty string.
    expect(ownerSeatSql(undefined)).toBeNull();
    expect(ownerSeatSql("")).toBeNull();

    const profileId = "usr_Ab3-x_9";
    const sql = ownerSeatSql(profileId);
    expect(sql).not.toBeNull();
    expect(statements(sql ?? "")).toEqual(scriptStatements(profileId));
    expect(statements(sql ?? "")).toHaveLength(2);
  });

  test("S5: identical inputs give identical bytes, so a second deploy re-imports nothing", () => {
    expect(ownerSeatSql("usr_Ab3-x_9")).toBe(ownerSeatSql("usr_Ab3-x_9"));
    expect(ownerSeatSql("usr_Ab3-x_9")).not.toBe(ownerSeatSql("usr_other"));
  });
});
