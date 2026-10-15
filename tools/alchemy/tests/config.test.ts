import { describe, expect, test } from "bun:test";

import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Redacted from "effect/Redacted";

import { probeToken, teardownRequested } from "../config.ts";
import { MIN_PROBE_TOKEN_LENGTH } from "../probe.ts";

const parse = <A>(
  config: { parse(provider: ConfigProvider.ConfigProvider): Effect.Effect<A, unknown> },
  env: Record<string, string>,
) => Effect.runSyncExit(config.parse(ConfigProvider.fromEnv({ env })));

describe("probe token config", () => {
  test("a token of the minimum length is read as a secret", () => {
    const token = "k".repeat(MIN_PROBE_TOKEN_LENGTH);
    const exit = parse(probeToken, { ALCHEMY_PROBE_TOKEN: token });
    expect(Exit.isSuccess(exit) && Redacted.value(exit.value)).toBe(token);
  });

  test("a shorter or missing token fails the run", () => {
    expect(
      Exit.isFailure(
        parse(probeToken, { ALCHEMY_PROBE_TOKEN: "k".repeat(MIN_PROBE_TOKEN_LENGTH - 1) }),
      ),
    ).toBe(true);
    expect(Exit.isFailure(parse(probeToken, {}))).toBe(true);
  });
});

describe("teardown flag", () => {
  test("is off unless set", () => {
    const unset = parse(teardownRequested, {});
    const set = parse(teardownRequested, { ALCHEMY_PROBE_TEARDOWN: "1" });
    expect(Exit.isSuccess(unset) && unset.value).toBe(false);
    expect(Exit.isSuccess(set) && set.value).toBe(true);
  });
});
