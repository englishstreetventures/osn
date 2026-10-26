import type { D1Database, D1PreparedStatement } from "@cloudflare/workers-types";

// Prototype chains, not spreads: the D1 types are abstract classes, and a spread
// drops their methods. Each wrapper keeps every method of the binding it wraps
// and overrides only `prepare`.

/** `base`, with every statement it prepares reported to `onPrepare` first. */
export const loggingBinding = (base: D1Database, onPrepare: (query: string) => void): D1Database =>
  Object.assign(Object.create(base), {
    prepare: (query: string): D1PreparedStatement => {
      onPrepare(query);
      return base.prepare(query);
    },
  });

/**
 * `base`, with every statement whose SQL `matches` rejecting when it runs, as a
 * failed read would. Other statements run on `base` unchanged.
 */
export const failingReadOf = (base: D1Database, matches: (query: string) => boolean): D1Database =>
  Object.assign(Object.create(base), {
    prepare: (query: string): D1PreparedStatement => {
      const real = base.prepare(query);
      if (!matches(query)) return real;
      const failing: D1PreparedStatement = Object.assign(Object.create(real.bind()), {
        raw: () => Promise.reject(new Error("injected read failure")),
      });
      return Object.assign(Object.create(real), { bind: () => failing });
    },
  });
