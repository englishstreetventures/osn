import { batch, createSignal } from "solid-js";

/**
 * How a write ended, for the read whose rows it may have changed.
 *
 * - `{ outcome }`: it succeeded, and its effect on the rows is known exactly
 *   (a passkey renamed to the label sent, a passkey removed by its id).
 * - `"refused"`: the server answered 400–499, so it changed nothing.
 * - `"unknown"`: anything else — a success whose effect only the server knows
 *   (a new passkey's fields, an authenticator's times, a new set's count), no
 *   answer at all, a 5xx, an ended session.
 */
export type WriteEnd<T> = { readonly outcome: (held: T) => T } | "refused" | "unknown";

/**
 * The end of a write that threw `err`: refused when the server answered
 * 400–499. The status is read as `describeAuthError` reads it, from any
 * error that carries one, as every `OsnApiError` does; `0` (no answer) and a
 * missing status are unknown.
 */
export function writeEnd<T>(err: unknown): WriteEnd<T> {
  const status =
    typeof err === "object" && err !== null ? (err as { status?: unknown }).status : undefined;
  return typeof status === "number" && status >= 400 && status < 500 ? "refused" : "unknown";
}

/** A read that failed: what it failed with, for the view's "didn't load" line. */
export interface ReadFailure {
  readonly error: unknown;
}

/**
 * What a Settings view reads, and what it tells the read when it writes. A
 * host with a cache of its own hands one in (`read` on `PasskeysView`,
 * `TotpView` and `RecoveryCodesView`); without one the view reads for itself
 * (`ownRead`).
 *
 * After a write settles, no screen shows a row the write may have changed:
 * an exact outcome is written at once, a refusal keeps the rows, anything
 * else forgets them (the view draws its first-load placeholder); the rows are
 * then read again.
 */
export interface SettingsRead<T> {
  /**
   * The rows last landed. `undefined` before the first lands, after a read
   * fails, and after a write forgot them. Never throws.
   */
  value(): T | undefined;
  /** `pending`: nothing to show and a read out. A read behind rows already shown stays `ready`. */
  state(): "pending" | "ready" | "errored";
  /** The last read's failure, while `state()` is `errored`; `null` otherwise. */
  failure(): ReadFailure | null;
  /** Waits until no read is out, then the rows; `undefined` when none landed. */
  settled(): Promise<T | undefined>;
  /** Reads again now: a failed read's Try again. */
  retry(): void;
  /**
   * How many placeholder rows to draw while `pending`: the rows last landed,
   * one when none is known. Omitted, one.
   */
  rows?(): number;
  /**
   * Called just before a request that may change what this read shows. Call
   * what it returns once, when that request settles, with how it ended.
   */
  write(): (end: WriteEnd<T>) => void;
}

/**
 * The read a view makes for itself when its host hands it none: the rows live
 * as long as the view, in plain signals, so a read never joins a host's
 * `Suspense` boundary.
 */
export function ownRead<T>(fetch: () => Promise<T>): SettingsRead<T> {
  const [value, setValue] = createSignal<T | undefined>(undefined);
  const [state, setState] = createSignal<"pending" | "ready" | "errored">("pending");
  const [error, setError] = createSignal<unknown>(undefined);
  let seq = 0;
  let inFlight: Promise<void> | null = null;

  function send(): Promise<void> {
    seq += 1;
    const mine = seq;
    if (value() === undefined) {
      batch(() => {
        setError(undefined);
        setState("pending");
      });
    }
    let answer: Promise<T>;
    try {
      answer = fetch();
    } catch (err) {
      answer = Promise.reject(err);
    }
    const land = async () => {
      try {
        const rows = await answer;
        if (mine !== seq) return;
        batch(() => {
          setValue(() => rows);
          setError(undefined);
          setState("ready");
        });
      } catch (err) {
        if (mine !== seq) return;
        // No rows left behind a failure.
        batch(() => {
          setValue(undefined);
          setError(err);
          setState("errored");
        });
      } finally {
        if (mine === seq) inFlight = null;
      }
    };
    const settled = land();
    inFlight = settled;
    return settled;
  }

  /** Waits until no read is out, the ones sent while waiting included. */
  const quiet = async (): Promise<void> => {
    const out = inFlight;
    if (!out) return;
    await out;
    return quiet();
  };

  void send();

  return {
    value,
    state,
    failure: () => (state() === "errored" ? { error: error() } : null),
    async settled() {
      await quiet();
      return value();
    },
    retry: () => void send(),
    write() {
      let ended = false;
      return (end) => {
        if (ended) return;
        ended = true;
        const rows = value();
        if (typeof end === "object") {
          if (rows !== undefined) setValue(() => end.outcome(rows));
        } else if (end === "unknown") {
          setValue(undefined);
        }
        void send();
      };
    },
  };
}
