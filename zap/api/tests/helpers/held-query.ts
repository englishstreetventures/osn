/**
 * A drizzle handle whose statements can be held, one at a time, until a test
 * lets them go — so a test can land another request's writes between a
 * service's read and its write, every run, on either driver.
 *
 * `hold(pattern)` arms a one-shot hold on the next statement whose SQL matches.
 * A statement is held at the moment it would run: when it is awaited (a single
 * statement, or each statement of bun:sqlite's one-at-a-time batch), or when a
 * D1 `batch` that contains it is sent, which holds the whole batch. Every other
 * statement runs as it would.
 *
 * Builders are wrapped through every chained call, so a statement built now
 * and run later is still seen when it runs. The handle answers `"batch" in db`
 * as the driver does, so code that looks for a batch takes the same path.
 * Imports no test framework: the D1 tier runs under `bun test`.
 *
 * The same file as `osn/api/tests/helpers/held-query.ts`: a test helper cannot
 * cross packages, so each keeps a copy, and a change to one goes to both.
 */

export interface Hold {
  /** Resolves once a matching statement is waiting. */
  readonly reached: Promise<void>;
  /** Lets the held statement run. */
  release(): void;
}

interface Armed {
  readonly pattern: RegExp;
  readonly reach: () => void;
  readonly gate: Promise<void>;
}

type Fn = (...args: unknown[]) => unknown;

/** The SQL a builder would send, or `undefined` for anything that is not one. */
function sqlOf(node: unknown): string | undefined {
  if (node === null || typeof node !== "object") return undefined;
  const toSQL = (node as { toSQL?: unknown }).toSQL;
  if (typeof toSQL !== "function") return undefined;
  return (toSQL as () => { sql: string }).call(node).sql;
}

/** Query builders, at every step of their chain; never a built `SQL` or a prepared query. */
function isBuilder(value: unknown): value is object {
  if (value === null || typeof value !== "object") return false;
  const node = value as Record<string, unknown>;
  return ["then", "from", "set", "values"].some((name) => typeof node[name] === "function");
}

export function holdQueries<T extends object>(db: T): { db: T; hold(pattern: RegExp): Hold } {
  const armed: Armed[] = [];

  /** Takes the first armed hold `sql` matches, if any, and answers its gate. */
  const take = (sql: string | undefined): Promise<void> | undefined => {
    if (sql === undefined) return undefined;
    const index = armed.findIndex((hold) => hold.pattern.test(sql));
    if (index < 0) return undefined;
    const [hold] = armed.splice(index, 1);
    hold!.reach();
    return hold!.gate;
  };

  const wrap = (node: object): object =>
    new Proxy(node, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        if (prop === "then") {
          return (onFulfilled?: Fn, onRejected?: Fn) => {
            const gate = take(sqlOf(target));
            if (!gate) return (value as Fn).call(target, onFulfilled, onRejected);
            return gate.then(() => (value as Fn).call(target, onFulfilled, onRejected));
          };
        }
        return (...args: unknown[]) => {
          const out = (value as Fn).apply(target, args);
          return isBuilder(out) ? wrap(out) : out;
        };
      },
    });

  const handle = new Proxy(db, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;
      if (prop === "batch") {
        return async (statements: readonly unknown[]) => {
          for (const statement of statements) {
            const gate = take(sqlOf(statement));
            if (gate) {
              await gate;
              break;
            }
          }
          return (value as Fn).call(target, statements);
        };
      }
      return (...args: unknown[]) => {
        const out = (value as Fn).apply(target, args);
        return isBuilder(out) ? wrap(out) : out;
      };
    },
  });

  const hold = (pattern: RegExp): Hold => {
    let reach!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((resolve) => {
      reach = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    armed.push({ pattern, reach, gate });
    return { reached, release };
  };

  return { db: handle, hold };
}
