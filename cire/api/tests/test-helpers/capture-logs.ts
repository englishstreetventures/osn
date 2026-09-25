/**
 * Capture everything Effect's logger writes for one run. The cire redacting
 * logger emits through `globalThis.console`, so the console methods are swapped
 * for a sink for the duration of `run`. (`globalThis.console` rather than the
 * bare `console` global so the no-console lint rule, which targets production
 * code, is not tripped by this test-only interception.)
 */
export async function captureLogs(run: () => unknown | Promise<unknown>): Promise<string> {
  const lines: string[] = [];
  const sink = (...args: unknown[]): void => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  // `console` is an ambient `const` in both the Workers and Bun type
  // declarations, so it never merges into `typeof globalThis`'s properties —
  // it exists on the real global object at runtime regardless.
  const c = (globalThis as typeof globalThis & { console: Console }).console;
  const original = { log: c.log, info: c.info, warn: c.warn, error: c.error, debug: c.debug };
  Object.assign(c, { log: sink, info: sink, warn: sink, error: sink, debug: sink });
  try {
    await run();
  } finally {
    Object.assign(c, original);
  }
  return lines.join("\n");
}
