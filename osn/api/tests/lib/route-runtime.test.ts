import { Db } from "@osn/db/service";
import { Effect, Layer, ManagedRuntime } from "effect";
import { describe, it, expect } from "vitest";

import { makeAppRunner } from "../../src/lib/route-runtime";
import { createTestLayer } from "../helpers/db";

/**
 * `makeAppRunner` is the seam that removed the per-request layer rebuild
 * (see [[architecture/backend-patterns]] "Build the layer graph ONCE"). These
 * tests pin its two branches directly: the fallback path builds the layer
 * exactly once and reuses it across every `run` call, and the injected path
 * returns the shared runtime verbatim.
 */
describe("makeAppRunner", () => {
  // A tiny effect that requires the Db service, so a missing/empty runtime fails.
  const touchesDb = Effect.gen(function* () {
    const { db } = yield* Db;
    return typeof db;
  });

  describe("fallback path (no injected runtime)", () => {
    it("builds the layer ONCE and reuses it across run calls", async () => {
      // A layer whose build is observable, so a per-request rebuild would show
      // up as build count > 1 — the exact regression this change prevents.
      let builds = 0;
      const countingLayer = Layer.effect(
        Db,
        Effect.sync(() => {
          builds++;
          return { db: {} as never };
        }),
      );

      const { runtime, run } = makeAppRunner(undefined, countingLayer);
      expect(runtime).toBeDefined();

      await expect(run(touchesDb)).resolves.toBe("object");
      await expect(run(touchesDb)).resolves.toBe("object");
      await expect(run(touchesDb)).resolves.toBe("object");

      // Three runs, one build — the layer graph is memoized in the runtime.
      expect(builds).toBe(1);
      await runtime.dispose();
    });

    it("runs real Db-backed effects against the built runtime", async () => {
      const { runtime, run } = makeAppRunner(undefined, createTestLayer());
      await expect(run(touchesDb)).resolves.toBe("object");
      await runtime.dispose();
    });
  });

  describe("injected path (shared runtime supplied)", () => {
    it("returns the injected runtime verbatim and runs effects through it", async () => {
      const injected = ManagedRuntime.make(createTestLayer());
      // The fallback layer must be ignored when a runtime is injected.
      const { runtime, run } = makeAppRunner(injected, createTestLayer());

      expect(runtime).toBe(injected);
      await expect(run(touchesDb)).resolves.toBe("object");
      await injected.dispose();
    });
  });
});
