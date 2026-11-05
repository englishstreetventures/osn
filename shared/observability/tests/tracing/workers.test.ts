import { Data, Effect, Exit, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config";
import { makeLoggerLayer } from "../../src/logger/layer";
import { installWorkersTracing, WorkersTracingLive } from "../../src/tracing/workers";

/**
 * The mirror from Effect spans into Cloudflare Workers custom spans, against a
 * recording stand-in for the Workers `tracing` API. One test per way the mirror
 * can fail; `tests/wrangler/workers-observability.e2e.ts` runs the real API on
 * workerd.
 */

interface Call {
  readonly span: number;
  readonly op: string;
  readonly args: readonly unknown[];
}

interface FakeOptions {
  readonly isTraced?: boolean;
  readonly throwOnStart?: boolean;
}

const makeFake = (options: FakeOptions = {}) => {
  const calls: Call[] = [];
  let next = 0;
  const tracing = {
    startSpan(name: string) {
      if (options.throwOnStart === true) throw new Error("no request context");
      const span = next++;
      calls.push({ span, op: "startSpan", args: [name] });
      return {
        isTraced: options.isTraced ?? true,
        setAttribute(key: string, value: string | number | boolean) {
          calls.push({ span, op: "setAttribute", args: [key, value] });
        },
        setStatus(status: { readonly code: string }) {
          calls.push({ span, op: "setStatus", args: [status] });
        },
        // The real API has it; the mirror must never call it, since each call
        // also writes an error-level line to Workers Logs.
        recordException(exception: unknown) {
          calls.push({ span, op: "recordException", args: [exception] });
        },
        end() {
          calls.push({ span, op: "end", args: [] });
        },
      };
    },
  };
  return { tracing, calls };
};

const run = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(WorkersTracingLive)));

class LookupFailed extends Data.TaggedError("LookupFailed")<{ readonly message: string }> {}

const PII = "ada@example.com";

afterEach(() => {
  installWorkersTracing(undefined);
});

describe("WorkersTracingLive", () => {
  it("opens one Workers span per sampled Effect span, with its name, and ends it once", async () => {
    const fake = makeFake();
    installWorkersTracing(fake.tracing);

    const exit = await run(Effect.succeed(42).pipe(Effect.withSpan("probe.outer")));

    expect(exit).toStrictEqual(Exit.succeed(42));
    expect(fake.calls).toEqual([
      { span: 0, op: "startSpan", args: ["probe.outer"] },
      { span: 0, op: "end", args: [] },
    ]);
  });

  it("forwards an attribute under a deny-listed key as the placeholder", async () => {
    const fake = makeFake();
    installWorkersTracing(fake.tracing);

    await run(
      Effect.void.pipe(
        Effect.withSpan("probe.attrs", { attributes: { email: PII, kind: "probe", count: 2 } }),
      ),
    );

    const attributes = fake.calls.filter((c) => c.op === "setAttribute").map((c) => c.args);
    expect(attributes).toEqual([
      ["email", "[REDACTED]"],
      ["kind", "probe"],
      ["count", 2],
    ]);
    expect(JSON.stringify(fake.calls)).not.toContain(PII);
  });

  it("never forwards an object-valued attribute", async () => {
    const fake = makeFake();
    installWorkersTracing(fake.tracing);

    await run(
      Effect.void.pipe(
        Effect.withSpan("probe.object", { attributes: { guest: { firstName: "Ivy" } } }),
      ),
    );

    expect(fake.calls.filter((c) => c.op === "setAttribute")).toEqual([]);
    expect(JSON.stringify(fake.calls)).not.toContain("Ivy");
  });

  it("marks a failure with the error's tag and error status, never its message, and records no exception", async () => {
    const fake = makeFake();
    installWorkersTracing(fake.tracing);

    const exit = await run(
      Effect.fail(new LookupFailed({ message: `no row for ${PII}` })).pipe(
        Effect.withSpan("probe.fail"),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(fake.calls).toEqual([
      { span: 0, op: "startSpan", args: ["probe.fail"] },
      { span: 0, op: "setAttribute", args: ["error.type", "LookupFailed"] },
      { span: 0, op: "setStatus", args: [{ code: "error" }] },
      { span: 0, op: "end", args: [] },
    ]);
    expect(JSON.stringify(fake.calls)).not.toContain(PII);
  });

  it("marks a defect with the defect's name, never its message", async () => {
    const fake = makeFake();
    installWorkersTracing(fake.tracing);

    await run(
      Effect.die(new TypeError(`bad input from ${PII}`)).pipe(Effect.withSpan("probe.die")),
    );

    expect(fake.calls).toContainEqual({
      span: 0,
      op: "setAttribute",
      args: ["error.type", "TypeError"],
    });
    expect(fake.calls.some((c) => c.op === "recordException")).toBe(false);
    expect(JSON.stringify(fake.calls)).not.toContain(PII);
  });

  it("ends an interrupted span with no error status", async () => {
    const fake = makeFake();
    installWorkersTracing(fake.tracing);

    const exit = await run(Effect.interrupt.pipe(Effect.withSpan("probe.interrupt")));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(fake.calls).toEqual([
      { span: 0, op: "startSpan", args: ["probe.interrupt"] },
      { span: 0, op: "end", args: [] },
    ]);
  });

  it("opens no Workers span for an unsampled Effect span", async () => {
    const fake = makeFake();
    installWorkersTracing(fake.tracing);

    await run(Effect.void.pipe(Effect.withSpan("probe.unsampled", { sampled: false })));

    expect(fake.calls).toEqual([]);
  });

  it("makes no Workers call when nothing is installed, and the effect still runs", async () => {
    const exit = await run(Effect.succeed("ok").pipe(Effect.withSpan("probe.none")));

    expect(exit).toStrictEqual(Exit.succeed("ok"));
  });

  it("clears an earlier install when given a tracing object with no startSpan, or nothing", async () => {
    const fake = makeFake();

    installWorkersTracing(fake.tracing);
    installWorkersTracing({ enterSpan: () => undefined });
    await run(Effect.void.pipe(Effect.withSpan("probe.cleared-by-old-runtime")));

    installWorkersTracing(fake.tracing);
    installWorkersTracing(undefined);
    await run(Effect.void.pipe(Effect.withSpan("probe.cleared-by-undefined")));

    expect(fake.calls).toEqual([]);
  });

  it("leaves the effect's result unchanged when startSpan throws", async () => {
    const fake = makeFake({ throwOnStart: true });
    installWorkersTracing(fake.tracing);

    const exit = await run(Effect.succeed(7).pipe(Effect.withSpan("probe.throws")));

    expect(exit).toStrictEqual(Exit.succeed(7));
  });

  it("ends an untraced Workers span at once and sends it nothing else", async () => {
    const fake = makeFake({ isTraced: false });
    installWorkersTracing(fake.tracing);

    await run(
      Effect.fail(new LookupFailed({ message: "x" })).pipe(
        Effect.withSpan("probe.untraced", { attributes: { kind: "probe" } }),
      ),
    );

    expect(fake.calls).toEqual([
      { span: 0, op: "startSpan", args: ["probe.untraced"] },
      { span: 0, op: "end", args: [] },
    ]);
  });

  it("sends a log line inside a span to no Workers call", async () => {
    const fake = makeFake();
    installWorkersTracing(fake.tracing);
    const silent = globalThis.console.log;
    globalThis.console.log = () => undefined;
    try {
      await Effect.runPromise(
        Effect.logInfo("guest looked up", { email: PII }).pipe(
          Effect.annotateLogs({ email: PII }),
          Effect.withSpan("probe.logs"),
          Effect.provide(
            Layer.merge(
              makeLoggerLayer(loadConfig({ serviceName: "test", env: "production" })),
              WorkersTracingLive,
            ),
          ),
        ),
      );
    } finally {
      globalThis.console.log = silent;
    }

    expect(fake.calls).toEqual([
      { span: 0, op: "startSpan", args: ["probe.logs"] },
      { span: 0, op: "end", args: [] },
    ]);
  });
});
