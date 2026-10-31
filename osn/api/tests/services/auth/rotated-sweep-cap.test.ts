import { it, expect, describe } from "@effect/vitest";
import { Effect, Logger } from "effect";
import { beforeAll } from "vitest";

import { createAuthService } from "../../../src/services/auth";
import {
  ROTATED_SESSION_SWEEP_CHUNK,
  ROTATED_SESSION_SWEEP_MAX_CHUNKS,
} from "../../../src/services/auth/constants";
import {
  ROTATED_SESSION_SWEEP_MAX_CHUNKS_CEILING,
  rotatedSweepMaxChunks,
  runRotatedSessionSweep,
} from "../../../src/services/auth/tokens";
import { makeTestAuthConfig } from "../../helpers/auth-config";
import { createTestLayerWithSqlite } from "../../helpers/db";

/**
 * The rotated-session sweep's per-run cap is the tier's: Workers Free keeps
 * the default, Workers Paid raises it, so the deletes keep up with the
 * refreshes that write the records. A run that hits its cap on a full chunk
 * has left a backlog, and says so in the log.
 */

let auth: ReturnType<typeof createAuthService>;

beforeAll(async () => {
  auth = createAuthService(await makeTestAuthConfig());
});

describe("rotatedSweepMaxChunks", () => {
  it("is the default when the tier sets nothing", () => {
    expect(rotatedSweepMaxChunks(undefined)).toBe(ROTATED_SESSION_SWEEP_MAX_CHUNKS);
    expect(rotatedSweepMaxChunks("")).toBe(ROTATED_SESSION_SWEEP_MAX_CHUNKS);
  });

  it.each(["1", "100", String(ROTATED_SESSION_SWEEP_MAX_CHUNKS_CEILING)])(
    "takes %s as written",
    (raw) => {
      expect(rotatedSweepMaxChunks(raw)).toBe(Number(raw));
    },
  );

  it.each([
    "0",
    "-1",
    "1.5",
    "1e2",
    " 10",
    "ten",
    String(ROTATED_SESSION_SWEEP_MAX_CHUNKS_CEILING + 1),
  ])("refuses %j", (raw) => {
    expect(rotatedSweepMaxChunks(raw)).toBe("invalid");
  });
});

describe("runRotatedSessionSweep with a tier's cap", () => {
  const capture = () => {
    const lines: { level: string; message: unknown; annotations: Record<string, unknown> }[] = [];
    const layer = Logger.layer([
      Logger.map(Logger.formatStructured, (line) => {
        lines.push(line);
      }),
    ]);
    const warnings = () =>
      lines.filter(
        (line) =>
          line.level === "WARN" &&
          String(line.message).includes("auth.session.rotated_sweep ended on a full chunk"),
      );
    return { layer, warnings };
  };

  it.live("deletes at most its cap, and warns when it ends on a full chunk", () => {
    const db = createTestLayerWithSqlite();
    const log = capture();
    return Effect.gen(function* () {
      const profile = yield* auth.registerProfile("sweep-tier@example.com", "sweeptier");
      const nowMs = 1_000_000;
      db.sqlite.run(
        `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO rotated_sessions (token_hash, family_id, account_id, rotated_at, expires_at)
         SELECT 'dead_' || i, 'sfam_tier', ?, 0, ? FROM n`,
        [ROTATED_SESSION_SWEEP_CHUNK + 10, profile.accountId, nowMs - 1],
      );

      // A cap of one chunk: a full chunk deleted, ten records left, a warning.
      const first = yield* runRotatedSessionSweep({ nowMs, maxChunks: 1 });
      expect(first.deleted).toBe(ROTATED_SESSION_SWEEP_CHUNK);
      expect(log.warnings()).toHaveLength(1);
      expect(log.warnings()[0]!.annotations).toEqual({
        chunks: 1,
        deleted: ROTATED_SESSION_SWEEP_CHUNK,
      });

      // The rest: a short chunk, so nothing is left and nothing is said.
      const second = yield* runRotatedSessionSweep({ nowMs, maxChunks: 1 });
      expect(second.deleted).toBe(10);
      expect(log.warnings()).toHaveLength(1);
    }).pipe(Effect.provide(db.layer), Effect.provide(log.layer));
  });
});
