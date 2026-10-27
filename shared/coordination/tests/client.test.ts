import { describe, expect, it, vi } from "vitest";

import {
  createCoordinationClient,
  createCoordinationRateLimiter,
  MAX_KEY_LENGTH,
  MAX_TTL_MS,
  COORDINATION_LOCATION_HINT,
  type CoordinationNamespace,
  type CoordinationOp,
  type CoordinationStub,
  type CoordinationStubOptions,
} from "../src/client";

interface Call {
  readonly name: string;
  readonly op: CoordinationOp;
  readonly args: readonly unknown[];
}

/**
 * A namespace whose stubs record every call and answer through `answer`. It
 * stands in for a Durable Object binding: the client's own rules (names,
 * clamps, retries, refusals) are what is under test, not the object.
 */
function recordingNamespace(answer: (op: CoordinationOp, attempt: number) => Promise<unknown>) {
  const names: string[] = [];
  const options: (CoordinationStubOptions | undefined)[] = [];
  const calls: Call[] = [];
  const record = (name: string, op: CoordinationOp, args: readonly unknown[]): Promise<unknown> => {
    calls.push({ name, op, args });
    return answer(op, calls.filter((c) => c.op === op).length);
  };
  const ns: CoordinationNamespace = {
    getByName(name: string, stubOptions?: CoordinationStubOptions): CoordinationStub {
      names.push(name);
      options.push(stubOptions);
      return {
        increment: (windowMs) => record(name, "increment", [windowMs]) as Promise<number>,
        count: () => record(name, "count", []) as Promise<number>,
        read: () => record(name, "read", []) as Promise<string | null>,
        write: (value, ttlMs) => record(name, "write", [value, ttlMs]) as Promise<void>,
        remove: () => record(name, "remove", []) as Promise<boolean>,
        claim: (ttlMs) => record(name, "claim", [ttlMs]) as Promise<boolean>,
        guess: () => record(name, "guess", []) as Promise<{ value: string | null; n: number }>,
        take: () => record(name, "take", []) as Promise<string | null>,
      };
    },
  };
  return { ns, names, options, calls };
}

/** The shape the runtime gives an error a caller may retry. */
function runtimeError(fields: { retryable?: boolean; overloaded?: boolean }): Error {
  return Object.assign(new Error("Durable Object reset"), fields);
}

const KEY = "203.0.113.9";
const LONG_KEY = "k".repeat(MAX_KEY_LENGTH + 1);

describe("createCoordinationRateLimiter", () => {
  it("allows up to maxRequests in a window and denies after", async () => {
    const { ns, calls } = recordingNamespace((_op, attempt) => Promise.resolve(attempt));
    const limiter = createCoordinationRateLimiter(ns, {
      namespace: "auth.login",
      maxRequests: 2,
      windowMs: 60_000,
    });
    expect(await limiter.check(KEY)).toBe(true);
    expect(await limiter.check(KEY)).toBe(true);
    expect(await limiter.check(KEY)).toBe(false);
    expect(calls.map((c) => c.args)).toEqual([[60_000], [60_000], [60_000]]);
  });

  // F-CL1
  it("denies when the object call fails and reports store and op, never the key", async () => {
    const onError = vi.fn();
    const { ns } = recordingNamespace(() => Promise.reject(new Error(`no object for ${KEY}`)));
    const limiter = createCoordinationRateLimiter(ns, {
      namespace: "auth.login",
      maxRequests: 5,
      windowMs: 60_000,
      onError,
    });
    expect(await limiter.check(KEY)).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    const [store, op, detail] = onError.mock.calls[0]!;
    expect(store).toBe("auth.login");
    expect(op).toBe("increment");
    expect(detail).toEqual({ retried: false, durationMs: expect.any(Number), kind: "other" });
    expect(JSON.stringify(onError.mock.calls)).not.toContain(KEY);
  });

  // F-CL2
  it("denies a key over 256 characters without calling the object", async () => {
    const onError = vi.fn();
    const { ns, names } = recordingNamespace(() => Promise.resolve(1));
    const limiter = createCoordinationRateLimiter(ns, {
      namespace: "auth.login",
      maxRequests: 5,
      windowMs: 60_000,
      onError,
    });
    expect(await limiter.check(LONG_KEY)).toBe(false);
    expect(names).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
    expect(await limiter.check("k".repeat(MAX_KEY_LENGTH))).toBe(true);
  });

  // F-CL3
  it.each(["", "auth:login", "auth login", "rl/auth", "a".repeat(65)])(
    "refuses namespace %j at construction",
    (namespace) => {
      const { ns } = recordingNamespace(() => Promise.resolve(1));
      expect(() =>
        createCoordinationRateLimiter(ns, { namespace, maxRequests: 5, windowMs: 60_000 }),
      ).toThrow(/namespace/);
    },
  );

  it.each([0, -1, 1.5, Number.NaN])("refuses maxRequests %p at construction", (maxRequests) => {
    const { ns } = recordingNamespace(() => Promise.resolve(1));
    expect(() =>
      createCoordinationRateLimiter(ns, { namespace: "auth.login", maxRequests, windowMs: 60_000 }),
    ).toThrow(/maxRequests/);
  });
});

describe("createCoordinationClient", () => {
  // F-CL3
  it.each(["", "auth:login", "auth login", "rl/auth", "a".repeat(65)])(
    "refuses namespace %j at construction",
    (namespace) => {
      const { ns } = recordingNamespace(() => Promise.resolve(null));
      expect(() => createCoordinationClient(ns, { namespace })).toThrow(/namespace/);
    },
  );

  // F-CL4
  it("addresses the same key in two namespaces as two objects", async () => {
    const { ns, names } = recordingNamespace(() => Promise.resolve(null));
    await createCoordinationClient(ns, { namespace: "step_up_otp" }).read("acct_1");
    await createCoordinationClient(ns, { namespace: "step_up_otp-attempts" }).read("acct_1");
    expect(names).toEqual(["step_up_otp:acct_1", "step_up_otp-attempts:acct_1"]);
  });

  // F-CL2
  it.each([
    ["increment", (c: ReturnType<typeof createCoordinationClient>) => c.increment(LONG_KEY, 1_000)],
    ["count", (c: ReturnType<typeof createCoordinationClient>) => c.count(LONG_KEY)],
    ["read", (c: ReturnType<typeof createCoordinationClient>) => c.read(LONG_KEY)],
    ["write", (c: ReturnType<typeof createCoordinationClient>) => c.write(LONG_KEY, "v", 1_000)],
    ["remove", (c: ReturnType<typeof createCoordinationClient>) => c.remove(LONG_KEY)],
    ["claim", (c: ReturnType<typeof createCoordinationClient>) => c.claim(LONG_KEY, 1_000)],
    ["guess", (c: ReturnType<typeof createCoordinationClient>) => c.guess(LONG_KEY)],
    ["take", (c: ReturnType<typeof createCoordinationClient>) => c.take(LONG_KEY)],
  ] as const)(
    "%s refuses a key over 256 characters without calling the object",
    async (_op, run) => {
      const onError = vi.fn();
      const { ns, names } = recordingNamespace(() => Promise.resolve(null));
      const client = createCoordinationClient(ns, { namespace: "ceremony", onError });
      const refusal = await run(client).then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusal).toBeInstanceOf(RangeError);
      expect(String(refusal)).not.toContain(LONG_KEY);
      expect(names).toEqual([]);
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it("rejects with the object's error and reports store and op, never the key or value", async () => {
    const onError = vi.fn();
    const failure = new Error("storage unavailable");
    const { ns } = recordingNamespace(() => Promise.reject(failure));
    const client = createCoordinationClient(ns, { namespace: "ceremony", onError });
    await expect(client.write("acct_secret", "value_secret", 1_000)).rejects.toBe(failure);
    expect(onError).toHaveBeenCalledWith("ceremony", "write", {
      retried: false,
      durationMs: expect.any(Number),
      kind: "other",
    });
    const reported = JSON.stringify(onError.mock.calls);
    expect(reported).not.toContain("acct_secret");
    expect(reported).not.toContain("value_secret");
  });

  it("clamps a window or TTL above 31 days to 31 days", async () => {
    const { ns, calls } = recordingNamespace(() => Promise.resolve(true));
    const client = createCoordinationClient(ns, { namespace: "ceremony" });
    const over = MAX_TTL_MS + 1;
    await client.increment("k", over);
    await client.write("k", "v", over);
    await client.claim("k", over);
    expect(calls.map((c) => c.args.at(-1))).toEqual([MAX_TTL_MS, MAX_TTL_MS, MAX_TTL_MS]);
  });

  // F-CL14
  it("gets every stub with the Oceania location hint, a retry's included", async () => {
    const { ns, options } = recordingNamespace((op, attempt) =>
      op === "read" && attempt === 1
        ? Promise.reject(runtimeError({ retryable: true }))
        : Promise.resolve(op === "guess" ? { value: null, n: 0 } : null),
    );
    const client = createCoordinationClient(ns, { namespace: "ceremony" });
    await client.read("k");
    await client.write("k", "v", 1_000);
    await client.guess("k");
    await client.take("k");
    await createCoordinationRateLimiter(ns, {
      namespace: "auth.login",
      maxRequests: 5,
      windowMs: 60_000,
    }).check(KEY);
    expect(COORDINATION_LOCATION_HINT).toBe("oc");
    expect(options).toHaveLength(6);
    expect(options).toEqual(options.map(() => ({ locationHint: "oc" })));
  });

  it("answers guess and take with what the object answered", async () => {
    const { ns, calls } = recordingNamespace((op) =>
      Promise.resolve(op === "guess" ? { value: "v", n: 2 } : "taken"),
    );
    const client = createCoordinationClient(ns, { namespace: "ceremony" });
    expect(await client.guess("k")).toEqual({ value: "v", n: 2 });
    expect(await client.take("k")).toBe("taken");
    expect(calls.map((c) => [c.name, c.op])).toEqual([
      ["ceremony:k", "guess"],
      ["ceremony:k", "take"],
    ]);
  });

  it("passes a TTL at or below zero through to write, which removes the entry", async () => {
    const { ns, calls } = recordingNamespace(() => Promise.resolve(undefined));
    const client = createCoordinationClient(ns, { namespace: "ceremony" });
    await client.write("k", "v", 0);
    await client.write("k", "v", -5);
    expect(calls.map((c) => c.args)).toEqual([
      ["v", 0],
      ["v", -5],
    ]);
  });
});

// F-CL16
describe("the kind a failed call reports", () => {
  const SECRET_TEXT = "acct_secret value_secret";
  it.each([
    [
      "an overloaded object",
      Object.assign(new Error(SECRET_TEXT), { overloaded: true, retryable: false }),
      "overloaded",
    ],
    [
      "an object reset",
      Object.assign(new Error(SECRET_TEXT), { durableObjectReset: true, retryable: true }),
      "reset",
    ],
    ["a retryable error", Object.assign(new Error(SECRET_TEXT), { retryable: true }), "retryable"],
    ["a refused argument", new RangeError(SECRET_TEXT), "invalid_input"],
    ["any other error", new Error(SECRET_TEXT), "other"],
    ["a thrown string", SECRET_TEXT, "other"],
  ] as const)("is %s's, and never its message", async (_what, failure, kind) => {
    const onError = vi.fn();
    const { ns } = recordingNamespace(() => Promise.reject(failure));
    const client = createCoordinationClient(ns, { namespace: "ceremony", onError });
    await expect(client.write("k", "v", 1_000)).rejects.toBe(failure);
    expect(onError).toHaveBeenCalledWith("ceremony", "write", {
      retried: false,
      durationMs: expect.any(Number),
      kind,
    });
    expect(JSON.stringify(onError.mock.calls)).not.toContain("secret");
  });
});

// F-CL12
describe("retries", () => {
  it.each(["read", "count"] as const)(
    "%s retries once on a retryable error, through a fresh stub",
    async (op) => {
      const onError = vi.fn();
      const { ns, names, calls } = recordingNamespace((_op, attempt) =>
        attempt === 1 ? Promise.reject(runtimeError({ retryable: true })) : Promise.resolve(3),
      );
      const client = createCoordinationClient(ns, { namespace: "ceremony", onError });
      await expect(client[op]("k")).resolves.toBe(3);
      expect(calls).toHaveLength(2);
      expect(names).toEqual(["ceremony:k", "ceremony:k"]);
      expect(onError).not.toHaveBeenCalled();
    },
  );

  it.each(["read", "count"] as const)("%s gives up after one retry", async (op) => {
    const onError = vi.fn();
    const failure = runtimeError({ retryable: true });
    const { ns, calls } = recordingNamespace(() => Promise.reject(failure));
    const client = createCoordinationClient(ns, { namespace: "ceremony", onError });
    await expect(client[op]("k")).rejects.toBe(failure);
    expect(calls).toHaveLength(2);
    expect(onError).toHaveBeenCalledWith("ceremony", op, {
      retried: true,
      durationMs: expect.any(Number),
      kind: "retryable",
    });
  });

  it.each([
    ["an overloaded object", runtimeError({ retryable: true, overloaded: true }), "overloaded"],
    ["a non-retryable error", runtimeError({ retryable: false }), "other"],
    ["a plain error", new Error("bad input"), "other"],
  ] as const)("read does not retry %s", async (_what, failure, kind) => {
    const onError = vi.fn();
    const { ns, calls } = recordingNamespace(() => Promise.reject(failure));
    const client = createCoordinationClient(ns, { namespace: "ceremony", onError });
    await expect(client.read("k")).rejects.toBe(failure);
    expect(calls).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith("ceremony", "read", {
      retried: false,
      durationMs: expect.any(Number),
      kind,
    });
  });

  it.each([
    ["increment", (c: ReturnType<typeof createCoordinationClient>) => c.increment("k", 1_000)],
    ["write", (c: ReturnType<typeof createCoordinationClient>) => c.write("k", "v", 1_000)],
    ["remove", (c: ReturnType<typeof createCoordinationClient>) => c.remove("k")],
    ["claim", (c: ReturnType<typeof createCoordinationClient>) => c.claim("k", 1_000)],
    // F-CL15: both write — a guess counts, a take clears.
    ["guess", (c: ReturnType<typeof createCoordinationClient>) => c.guess("k")],
    ["take", (c: ReturnType<typeof createCoordinationClient>) => c.take("k")],
  ] as const)("%s never retries, even a retryable error", async (_op, run) => {
    const failure = runtimeError({ retryable: true });
    const { ns, calls } = recordingNamespace(() => Promise.reject(failure));
    const client = createCoordinationClient(ns, { namespace: "ceremony" });
    await expect(run(client)).rejects.toBe(failure);
    expect(calls).toHaveLength(1);
  });

  it("the rate limiter's increment never retries", async () => {
    const { ns, calls } = recordingNamespace(() =>
      Promise.reject(runtimeError({ retryable: true })),
    );
    const limiter = createCoordinationRateLimiter(ns, {
      namespace: "auth.login",
      maxRequests: 5,
      windowMs: 60_000,
    });
    expect(await limiter.check(KEY)).toBe(false);
    expect(calls).toHaveLength(1);
  });
});
