/**
 * Make cire's metrics readable from a test.
 *
 * Without this, they are not. `createCounter`
 * (`shared/observability/src/metrics/factory.ts`) resolves its meter through
 * the OpenTelemetry API's global provider, and with none installed that is the
 * NoOp meter — which accepts every call and records nothing. A test written
 * against it passes with the `metric*()` call deleted from the route, which is
 * the one thing a metric test exists to catch.
 *
 * ## Install order is the whole trick
 *
 * `createCounter` builds its instrument on the FIRST `.inc()` and caches it in a
 * closure. A provider installed after that point is never consulted again for
 * that counter, so it records nothing and the test reads zero.
 *
 * `bun test` runs every file in one process, so "first use" is process-wide: a
 * route test running before this module loads would freeze the NoOp instrument
 * in for every later file. That is why `@cire/api`'s `test` script passes
 * `--preload ./tests/test-helpers/metrics-harness.ts` — importing this module
 * installs the provider, and a preload is imported before any test file.
 *
 * Running one file directly (`bun test tests/routes/rsvp.test.ts`) works too,
 * because a file that reads a counter imports this module and the instruments
 * are built at first `.inc()` rather than at import. The preload is what makes
 * the whole-suite run safe, not the single-file one.
 *
 * Bun's `mock.module` is the wrong tool here for the same one-process reason: it
 * is global, so a mock of `../../src/metrics` installed by one file leaks into
 * every file that runs after it.
 *
 * ## Read a delta, never an absolute
 *
 * The reader is cumulative and the provider outlives every file in the run, so a
 * counter's value carries whatever earlier tests added to it. Read it before the
 * thing under test, read it after, and assert the difference:
 *
 * ```ts
 * const before = await counterValue("cire.rsvp.blocked", { reason: "dietary_consent" });
 * await post(body, cookie);
 * expect(await counterValue("cire.rsvp.blocked", { reason: "dietary_consent" })).toBe(before + 1);
 * ```
 *
 * Constructing a `MeterProvider` here is deliberate and confined to `tests/`:
 * source may only reach instruments through `@shared/observability/metrics`.
 */

import { metrics, type Attributes } from "@opentelemetry/api";
import {
  MeterProvider,
  MetricReader,
  type CollectionResult,
  type MetricData,
} from "@opentelemetry/sdk-metrics";
/**
 * A reader the test drives by hand.
 *
 * `PeriodicExportingMetricReader` would attach an interval to every `bun test`
 * run and make a collection's timing the test's problem; `MetricReader.collect()`
 * is public, so a subclass with two inert hooks gives an on-demand read and no
 * timer.
 */
class OnDemandMetricReader extends MetricReader {
  protected override onForceFlush(): Promise<void> {
    return Promise.resolve();
  }
  protected override onShutdown(): Promise<void> {
    return Promise.resolve();
  }
}

const reader = new OnDemandMetricReader();
const provider = new MeterProvider({ readers: [reader] });

metrics.setGlobalMeterProvider(provider);

/** Every metric the provider currently holds, flattened across scopes. */
async function collectAll(): Promise<MetricData[]> {
  const result: CollectionResult = await reader.collect();
  return result.resourceMetrics.scopeMetrics.flatMap((scope) => scope.metrics);
}

/** Exact attribute-set match — a data point is keyed by its whole attribute set. */
function sameAttributes(a: Attributes, b: Attributes): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => a[key] === b[key]);
}

/**
 * The cumulative value of one counter data point, or 0 when nothing has recorded
 * it yet. `attrs` must be the data point's WHOLE attribute set, not a subset.
 *
 * Throws rather than answering 0 when this harness is not the installed
 * provider: a NoOp meter records nothing, so every assertion would otherwise
 * fail as "expected 1, received 0" with nothing to say the harness never ran.
 */
export async function counterValue(name: string, attrs: Attributes = {}): Promise<number> {
  if (metrics.getMeterProvider() !== provider) {
    throw new Error(
      `metrics harness is not the installed MeterProvider — counter "${name}" would read 0 whatever the code does. ` +
        `Run through \`bun run --cwd cire/api test\`, which preloads tests/test-helpers/metrics-harness.ts.`,
    );
  }
  const metric = (await collectAll()).find((m) => m.descriptor.name === name);
  if (!metric) return 0;
  const point = metric.dataPoints.find((p) => sameAttributes(p.attributes, attrs));
  return typeof point?.value === "number" ? point.value : 0;
}
