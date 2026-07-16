import { describe, expect, it } from "bun:test";

import { Effect, Schema } from "effect";

import { isTimeframeBucket, TIMEFRAME_BUCKET_KEYS } from "../lib/checklist-buckets";
import { CreateTaskBody, ReorderTasksBody, UpdateTaskBody } from "./tasks";

const decode = <A, I>(s: Schema.Schema<A, I>, v: unknown) =>
  Effect.runSync(Effect.either(Schema.decodeUnknown(s)(v)));

describe("checklist buckets", () => {
  it("has the eight ordered lead-time keys", () => {
    expect(TIMEFRAME_BUCKET_KEYS).toEqual([
      "12m",
      "9m",
      "6m",
      "3m",
      "1m",
      "2w",
      "week_of",
      "day_of",
    ]);
  });

  it("recognises valid + rejects unknown buckets", () => {
    expect(isTimeframeBucket("6m")).toBe(true);
    expect(isTimeframeBucket("5m")).toBe(false);
  });
});

describe("CreateTaskBody", () => {
  it("accepts a title + bucket, defaults notes/dueAt to null", () => {
    const r = decode(CreateTaskBody, { title: "Book venue", timeframeBucket: "12m" });
    expect(r._tag).toBe("Right");
    if (r._tag === "Right") {
      expect(r.right.notes).toBeNull();
      expect(r.right.dueAt).toBeNull();
    }
  });

  it("rejects an unknown bucket", () => {
    expect(decode(CreateTaskBody, { title: "x", timeframeBucket: "5m" })._tag).toBe("Left");
  });

  it("rejects an empty title", () => {
    expect(decode(CreateTaskBody, { title: "", timeframeBucket: "6m" })._tag).toBe("Left");
  });
});

describe("UpdateTaskBody", () => {
  it("accepts a partial status flip", () => {
    expect(decode(UpdateTaskBody, { status: "done" })._tag).toBe("Right");
  });

  it("rejects an out-of-set status", () => {
    expect(decode(UpdateTaskBody, { status: "archived" })._tag).toBe("Left");
  });
});

describe("ReorderTasksBody", () => {
  it("accepts a bucket + ordered ids", () => {
    expect(decode(ReorderTasksBody, { timeframeBucket: "3m", orderedIds: ["a", "b"] })._tag).toBe(
      "Right",
    );
  });
});
