import { expect, test } from "bun:test";

import { Throttle } from "./throttle";

test("throttle waits at least the minimum interval between calls", async () => {
  const throttle = new Throttle(50);
  const start = Bun.nanoseconds();
  await throttle.wait();
  await throttle.wait();
  expect((Bun.nanoseconds() - start) / 1e6).toBeGreaterThanOrEqual(49);
});

test("the first call does not wait", async () => {
  const throttle = new Throttle(5_000);
  const start = Bun.nanoseconds();
  await throttle.wait();
  expect((Bun.nanoseconds() - start) / 1e6).toBeLessThan(50);
});
