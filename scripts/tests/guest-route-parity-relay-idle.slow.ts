// The guest route comparison's relay (scripts/guest-route-parity.ts) over a
// wait longer than Bun's default idle timeout (NEW-FEAT.md PF44): a cire-api
// answer that takes 13 s still reaches the Worker, which holds only while the
// relay sets its own `idleTimeout`. The other relay tests are in
// guest-route-parity.test.ts.
//
// It waits out 13 s, and `bun run test:scripts` runs its files one after
// another, so it is named to be skipped there (`bun test` picks up only
// `*.test.*`, `*_test.*`, `*.spec.*` and `*_spec.*`), and `bun run
// test:scripts:relay-idle` runs it in its own step of CI's Scripts job. It
// needs nothing installed and starts no other program. It fails, never skips.

import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";

import { startRelay, type RelayedCall } from "../guest-route-parity";
import { RELAY_TOKEN_HEADER } from "../guest-route-parity-reference.js";

/**
 * How long cire-api takes to answer: past the 12 s by which Bun's default
 * idle timeout (10 s, counted in 4 s ticks) has cut a connection with no
 * answer yet, and short of the 28 s before the relay's own can.
 */
const SLOW_ANSWER_MS = 13_000;

describe("the relay, over the time Bun's default idle timeout allows", () => {
  test(
    "PF44: a cire-api answer that takes longer than Bun's default idle timeout still reaches the Worker, and is recorded",
    async () => {
      const relayed: RelayedCall[] = [];
      const token = randomBytes(24).toString("hex");
      const relay = startRelay(
        "https://api.cire.example.test",
        token,
        async () => {
          await Bun.sleep(SLOW_ANSWER_MS);
          return Response.json({ slug: "cire-wedding" });
        },
        () => (call) => relayed.push(call),
        // The relay's own limit, out of the way: only its idle timeout is under test.
        SLOW_ANSWER_MS + 7_000,
      );
      try {
        const response = await fetch(`http://127.0.0.1:${relay.port}/api/invite/cire-wedding`, {
          headers: { [RELAY_TOKEN_HEADER]: token },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ slug: "cire-wedding" });
        expect(relayed).toEqual([
          {
            method: "GET",
            path: "/api/invite/cire-wedding",
            status: 200,
            workerUserAgent: "absent",
          },
        ]);
      } finally {
        relay.stop();
      }
    },
    SLOW_ANSWER_MS + 17_000,
  );
});
