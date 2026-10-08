import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { join } from "node:path";

import * as schema from "@cire/db";
import { hashRecoveryCode } from "@shared/crypto/recovery";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect } from "effect";

import { mintUnlockCode, parseMintArgs, unlockCodeToSql } from "../../scripts/mint-unlock-code";
import { DbService } from "../../src/db";
import { DDL } from "../../src/db/setup";
import { unlockCodeService } from "../../src/services/unlock-codes";

const NOW = new Date("2026-10-08T09:30:00.000Z");
const args = (line: string) => line.split(" ").filter(Boolean);

describe("parseMintArgs", () => {
  it("reads the tier, the uses, the last day and who minted it", () => {
    expect(
      parseMintArgs(args("--tier gold --uses 3 --expires 2027-06-30 --by ops_ana"), NOW),
    ).toEqual({
      tier: "gold",
      uses: 3,
      // The code works through the whole of its last day, in UTC.
      expiresAt: new Date("2027-07-01T00:00:00.000Z"),
      createdBy: "script:ops_ana",
    });
  });

  it("defaults to one use and no expiry", () => {
    expect(parseMintArgs(args("--tier crimson --by ops"), NOW)).toEqual({
      tier: "crimson",
      uses: 1,
      expiresAt: null,
      createdBy: "script:ops",
    });
  });

  it("accepts the most uses it allows", () => {
    expect(parseMintArgs(args("--tier gold --uses 1000 --by ops"), NOW).uses).toBe(1000);
  });

  it("accepts today as the last day", () => {
    expect(parseMintArgs(args("--tier gold --expires 2026-10-08 --by ops"), NOW).expiresAt).toEqual(
      new Date("2026-10-09T00:00:00.000Z"),
    );
  });

  it.each([
    ["no tier", "--by ops", "--tier"],
    ["no operator", "--tier gold", "--by"],
    ["ivory, which a code cannot give", "--tier ivory --by ops", "gold or crimson"],
    ["an unknown tier", "--tier platinum --by ops", "gold or crimson"],
    ["zero uses", "--tier gold --uses 0 --by ops", "--uses"],
    ["a fraction of a use", "--tier gold --uses 1.5 --by ops", "--uses"],
    ["more uses than a comp needs", "--tier gold --uses 1001 --by ops", "--uses"],
    ["a day that does not exist", "--tier gold --expires 2027-02-30 --by ops", "--expires"],
    ["a day in another shape", "--tier gold --expires 30/06/2027 --by ops", "--expires"],
    ["a day already past", "--tier gold --expires 2026-10-07 --by ops", "--expires"],
    ["an operator that could break the SQL", "--tier gold --by o'brien", "--by"],
    ["a flag it does not know", "--tier gold --by ops --free", "--free"],
    ["a flag with no value", "--tier gold --by", "--by"],
  ])("refuses %s", (_label, line, message) => {
    expect(() => parseMintArgs(args(line), NOW)).toThrow(message);
  });
});

describe("mintUnlockCode", () => {
  it("makes a fresh code each time, in the recovery-code format, and keeps only its hash", () => {
    const req = parseMintArgs(args("--tier gold --by ops"), NOW);
    const a = mintUnlockCode(req, NOW);
    const b = mintUnlockCode(req, NOW);
    expect(a.code).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);
    expect(a.code).not.toBe(b.code);
    expect(a.id).toMatch(/^ulc_[0-9a-f-]{36}$/);
    expect(a.codeHash).toBe(hashRecoveryCode(a.code));
  });
});

describe("unlockCodeToSql", () => {
  it("holds the hash and never the code", () => {
    const minted = mintUnlockCode(
      parseMintArgs(args("--tier crimson --uses 2 --expires 2027-06-30 --by ops"), NOW),
      NOW,
    );
    const statement = unlockCodeToSql(minted);
    expect(statement).toContain(minted.codeHash);
    expect(statement).not.toContain(minted.code);
    expect(statement).not.toContain(minted.code.replaceAll("-", ""));
  });

  it("writes a row the redemption route accepts for the printed code", async () => {
    const sqlite = new Database(":memory:");
    sqlite.exec("PRAGMA foreign_keys = ON;");
    sqlite.exec(DDL);
    sqlite
      .query(
        "INSERT INTO weddings (id, slug, display_name, created_at, updated_at) VALUES ('wed_a', 'a', 'A', 0, 0)",
      )
      .run();
    const minted = mintUnlockCode(
      parseMintArgs(args("--tier crimson --uses 2 --expires 2027-06-30 --by ops"), NOW),
      NOW,
    );
    sqlite.exec(unlockCodeToSql(minted));

    expect(
      sqlite
        .query(
          "SELECT tier, max_redemptions, redeemed_count, expires_at, created_by, created_at FROM unlock_codes",
        )
        .get(),
    ).toEqual({
      tier: "crimson",
      max_redemptions: 2,
      redeemed_count: 0,
      expires_at: Date.UTC(2027, 6, 1) / 1000,
      created_by: "script:ops",
      created_at: Math.floor(NOW.getTime() / 1000),
    });

    const db = drizzle(sqlite, { schema });
    const outcome = await Effect.runPromise(
      unlockCodeService
        .redeem({
          weddingId: "wed_a",
          osnProfileId: "usr_owner",
          unlockCode: minted.code.toUpperCase(),
          now: NOW,
        })
        .pipe(Effect.provideService(DbService, db)),
    );
    expect(outcome).toEqual({ tier: "crimson" });
  });
});

describe("the command", () => {
  const script = join(import.meta.dir, "..", "..", "scripts", "mint-unlock-code.ts");

  it("prints the code and the SQL to apply", () => {
    const result = Bun.spawnSync(
      [process.execPath, "run", script, ...args("--tier gold --by ops")],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.exitCode).toBe(0);
    const [codeLine, sqlLine] = result.stdout.toString().trim().split("\n");
    const code = /^code: (\S+)$/.exec(codeLine ?? "")?.[1];
    expect(code).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){3}$/);
    expect(sqlLine).toStartWith("sql: INSERT INTO unlock_codes");
    expect(sqlLine).toContain(hashRecoveryCode(code!));
  });

  it("exits 1 with the reason on bad arguments", () => {
    const result = Bun.spawnSync(
      [process.execPath, "run", script, ...args("--tier ivory --by ops")],
      {
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    expect(result.exitCode).toBe(1);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("gold or crimson");
  });
});
