import { it, expect } from "@effect/vitest";
import { Effect } from "effect";
import { describe, it as vitestIt } from "vitest";

import { listBlasts, parseCommsChannels, sendBlast } from "../../src/services/comms";
import { createTestLayer, seedEvent } from "../helpers/db";

it.effect("sendBlast writes one row per channel", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({ title: "Party", startTime: "2030-06-01T10:00:00.000Z" });
    const result = yield* sendBlast(event.id, "usr_alice", {
      channels: ["sms", "email"],
      body: "Don't forget — tonight at 8!",
    });
    expect(result.blasts).toHaveLength(2);
    expect(result.blasts.map((b) => b.channel).toSorted()).toEqual(["email", "sms"]);
    expect(result.blasts.every((b) => b.sentAt !== null)).toBe(true);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("sendBlast rejects non-organiser callers with NotEventOwner", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({ title: "Party", startTime: "2030-06-01T10:00:00.000Z" });
    const err = yield* Effect.flip(
      sendBlast(event.id, "usr_bob", { channels: ["email"], body: "hi" }),
    );
    expect(err._tag).toBe("NotEventOwner");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("sendBlast returns EventNotFound for missing event", () =>
  Effect.gen(function* () {
    const err = yield* Effect.flip(
      sendBlast("evt_missing", "usr_alice", { channels: ["email"], body: "hi" }),
    );
    expect(err._tag).toBe("EventNotFound");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("sendBlast rejects duplicate channels via schema", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({ title: "Party", startTime: "2030-06-01T10:00:00.000Z" });
    const err = yield* Effect.flip(
      sendBlast(event.id, "usr_alice", { channels: ["sms", "sms"], body: "hi" }),
    );
    expect(err._tag).toBe("ValidationError");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("sendBlast rejects empty body via schema", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({ title: "Party", startTime: "2030-06-01T10:00:00.000Z" });
    const err = yield* Effect.flip(
      sendBlast(event.id, "usr_alice", { channels: ["email"], body: "" }),
    );
    expect(err._tag).toBe("ValidationError");
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("listBlasts returns all blasts for the event", () =>
  Effect.gen(function* () {
    const event = yield* seedEvent({ title: "Party", startTime: "2030-06-01T10:00:00.000Z" });
    yield* sendBlast(event.id, "usr_alice", { channels: ["email"], body: "first" });
    yield* sendBlast(event.id, "usr_alice", { channels: ["email"], body: "second" });
    const blasts = yield* listBlasts(event.id);
    expect(blasts.length).toBe(2);
    const bodies = blasts.map((b) => b.body).toSorted();
    expect(bodies).toEqual(["first", "second"]);
  }).pipe(Effect.provide(createTestLayer())),
);

it.effect("listBlasts returns EventNotFound when event missing", () =>
  Effect.gen(function* () {
    const err = yield* Effect.flip(listBlasts("evt_missing"));
    expect(err._tag).toBe("EventNotFound");
  }).pipe(Effect.provide(createTestLayer())),
);

describe("parseCommsChannels", () => {
  vitestIt("returns default on null", () => {
    expect(parseCommsChannels(null)).toEqual(["email"]);
  });
  vitestIt("returns default on malformed JSON", () => {
    expect(parseCommsChannels("not json")).toEqual(["email"]);
  });
  vitestIt("returns default on unknown channels", () => {
    expect(parseCommsChannels('["push"]')).toEqual(["email"]);
  });
  vitestIt("returns valid channels", () => {
    expect(parseCommsChannels('["sms","email"]')).toEqual(["sms", "email"]);
  });
});
