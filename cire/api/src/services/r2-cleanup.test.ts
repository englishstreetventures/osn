import { describe, it, expect } from "bun:test";

import { Effect } from "effect";

import { reapR2Objects, type DeletableBucket } from "./r2-cleanup";

function createRecordingBucket(): DeletableBucket & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    delete(keys: string | string[]) {
      calls.push(Array.isArray(keys) ? keys : [keys]);
      return Promise.resolve();
    },
  };
}

describe("reapR2Objects", () => {
  it("dedupes duplicate keys before deleting", async () => {
    const bucket = createRecordingBucket();
    await Effect.runPromise(reapR2Objects(bucket, "sheets", ["a", "b", "a", "b", "c"]));
    expect(bucket.calls.length).toBe(1);
    expect(bucket.calls[0]?.toSorted()).toEqual(["a", "b", "c"]);
  });

  it("is a no-op for an empty key list", async () => {
    const bucket = createRecordingBucket();
    await Effect.runPromise(reapR2Objects(bucket, "sheets", [null, undefined, ""]));
    expect(bucket.calls.length).toBe(0);
  });

  it("warns and does not throw when the bucket binding is absent", async () => {
    await expect(
      Effect.runPromise(reapR2Objects(undefined, "assets", ["a", "b"])),
    ).resolves.toBeUndefined();
  });

  it("chunks a key list larger than CHUNK_SIZE into multiple delete calls", async () => {
    const bucket = createRecordingBucket();
    const keys = Array.from({ length: 1001 }, (_, i) => `key-${i}`);
    await Effect.runPromise(reapR2Objects(bucket, "sheets", keys));
    expect(bucket.calls.length).toBe(2);
    expect(bucket.calls[0]?.length).toBe(1000);
    expect(bucket.calls[1]?.length).toBe(1);
  });
});
