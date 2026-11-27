import { installWorkersTracing } from "@shared/observability/tracing";

/** One span as the Workers trace mirror wrote it: its name and every attribute it set. */
export interface CapturedSpan {
  readonly name: string;
  readonly attributes: Record<string, unknown>;
}

/**
 * Captures every span `run` opens through `runCire`, as the Workers trace
 * mirror hands it to `ctx.tracing` on a deployed Worker: the attributes there,
 * and `error.type` for one that failed, are what leaves the process.
 */
export async function captureSpans(run: () => Promise<unknown>): Promise<CapturedSpan[]> {
  const spans: CapturedSpan[] = [];
  installWorkersTracing({
    startSpan: (name: string) => {
      const span: CapturedSpan = { name, attributes: {} };
      spans.push(span);
      return {
        isTraced: true,
        setAttribute: (key: string, value: unknown) => {
          span.attributes[key] = value;
        },
        setStatus: () => undefined,
        end: () => undefined,
      };
    },
  });
  try {
    await run();
  } finally {
    installWorkersTracing(undefined);
  }
  return spans;
}
