import { Effect } from "effect";
import { describe, it, expect } from "vitest";

import { makeLogEmailLive } from "../src/log";
import { EmailError, EmailService } from "../src/service";

describe("LogEmailLive", () => {
  it("records the rendered payload without sending", async () => {
    const { layer, recorded } = makeLogEmailLive();

    await Effect.runPromise(
      Effect.gen(function* () {
        const email = yield* EmailService;
        yield* email.send({
          template: "otp-registration",
          to: "alice@example.com",
          data: { code: "111111", ttlMinutes: 10 },
        });
      }).pipe(Effect.provide(layer)),
    );

    const sent = recorded();
    expect(sent).toHaveLength(1);
    expect(sent[0].template).toBe("otp-registration");
    expect(sent[0].to).toBe("alice@example.com");
    expect(sent[0].subject).toBe("Verify your OSN email");
    expect(sent[0].text).toContain("111111");
  });

  it("isolates captures between instances", async () => {
    const a = makeLogEmailLive();
    const b = makeLogEmailLive();

    await Effect.runPromise(
      Effect.gen(function* () {
        const email = yield* EmailService;
        yield* email.send({
          template: "passkey-added",
          to: "a@example.com",
          data: {},
        });
      }).pipe(Effect.provide(a.layer)),
    );

    expect(a.recorded()).toHaveLength(1);
    expect(b.recorded()).toHaveLength(0);
  });

  it("reset() clears the captured ring", async () => {
    const { layer, recorded, reset } = makeLogEmailLive();
    await Effect.runPromise(
      Effect.gen(function* () {
        const email = yield* EmailService;
        yield* email.send({
          template: "recovery-generated",
          to: "x@example.com",
          data: {},
        });
      }).pipe(Effect.provide(layer)),
    );
    expect(recorded()).toHaveLength(1);
    reset();
    expect(recorded()).toHaveLength(0);
  });

  it("returns render_failed when a template renderer throws", async () => {
    const { layer } = makeLogEmailLive();
    const exit = await Effect.runPromiseExit(
      Effect.gen(function* () {
        const email = yield* EmailService;
        yield* email.send({
          template: "otp-registration",
          to: "alice@example.com",
          data: { code: null as unknown as string, ttlMinutes: 10 },
        });
      }).pipe(Effect.provide(layer)),
    );
    expect(exit._tag).toBe("Failure");
    const error = (exit as { cause: { _tag: string; error: EmailError } }).cause.error;
    expect(error).toBeInstanceOf(EmailError);
    expect(error.reason).toBe("render_failed");
  });

  // T-U2: the ring is capped at MAX_RECORD (256). If the eviction branch
  // silently flips (`>=` → `>`, or `shift()` drops out of a refactor) the
  // recorder would grow unbounded in long test runs.
  it("evicts the oldest entry once the ring hits MAX_RECORD", async () => {
    const { layer, recorded } = makeLogEmailLive();
    await Effect.runPromise(
      Effect.gen(function* () {
        const email = yield* EmailService;
        for (let i = 0; i < 257; i++) {
          yield* email.send({
            template: "passkey-added",
            to: `user${String(i).padStart(3, "0")}@example.com`,
            data: {},
          });
        }
      }).pipe(Effect.provide(layer)),
    );
    const all = recorded();
    expect(all).toHaveLength(256);
    // The first send (user000@) was evicted; the earliest remaining is user001@.
    expect(all[0].to).toBe("user001@example.com");
    expect(all.at(-1)!.to).toBe("user256@example.com");
  });
});
