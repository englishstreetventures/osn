import { CLOSE_CODES, isSignal, PING, PING_INTERVAL_MS, PONG, type Signal } from "../protocol";

/**
 * Why the subscriber should read again: a signal arrived; an open socket was
 * lost (a change may land while it is down); a socket reopened after a loss or
 * a pause (a change may have landed meanwhile); or the subscription gave up
 * after having been open (a member removed while their socket was down is
 * refused on every reconnect, and this is their last prompt to re-read).
 */
export type SignalEvent =
  | { readonly reason: "message"; readonly signal: Signal }
  | { readonly reason: "dropped" }
  | { readonly reason: "reconnected" }
  | { readonly reason: "stopped" };

/** The slice of `document` the subscription reads to pause in a hidden tab. */
export type VisibilitySource = Pick<
  Document,
  "visibilityState" | "addEventListener" | "removeEventListener"
>;

export interface SubscriptionOptions {
  /** How often an open socket sends `ping`. A ping unanswered by the next one marks the socket dead. */
  readonly pingIntervalMs?: number;
  /** Consecutive failed attempts before the subscription gives up. An attempt fails when its socket closes before the hub has answered anything on it. */
  readonly maxAttempts?: number;
  /** Ceiling of the first retry's delay; each further failure doubles it, up to `maxDelayMs`. */
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Jitter source in [0, 1). */
  readonly random?: () => number;
  /**
   * Close the socket once the tab has been hidden for two ping intervals, and
   * reopen it when the tab is shown, so a hidden tab sends no pings. On by
   * default.
   */
  readonly pauseWhenHidden?: boolean;
  /** Where visibility is read; defaults to `document` when there is one. */
  readonly visibility?: VisibilitySource;
  /**
   * Origins whose last subscription gave up without a socket ever opening,
   * each with the time until which a new subscription there makes a single
   * attempt. Defaults to one map shared by every subscription on the page.
   */
  readonly fallbackMemory?: Map<string, number>;
  /**
   * Called once when the subscription gives up for good. The client records
   * no metric of its own until englishstventures/osn#1242 lands.
   */
  readonly onFallback?: () => void;
  /** The WebSocket constructor; tests pass a stand-in. */
  readonly WebSocket?: new (url: string) => WebSocket;
}

export interface TopicSubscription {
  /** Close the socket and cancel every timer. Safe to call more than once. */
  close(): void;
}

export const SUBSCRIPTION_DEFAULTS = {
  pingIntervalMs: PING_INTERVAL_MS,
  maxAttempts: 6,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  /** How long a fallback with no socket ever opened shortens later subscriptions to its origin. */
  fallbackMemoryMs: 5 * 60_000,
} as const;

const pageFallbackMemory = new Map<string, number>();

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

/**
 * Hold one socket open to `url` and call `onSignal` whenever the subscriber
 * should re-read. It reconnects with capped, jittered backoff. A failed
 * attempt is one whose socket never receives a frame from the hub — a pong
 * or a signal both prove the socket works end to end and reset the count,
 * so a socket that opens and is then cut before answering anything still
 * counts against the limit. After `maxAttempts` consecutive failed attempts
 * it stops and calls `onFallback` once, leaving the product's own refetch
 * triggers as the only ones; if no socket had opened, later subscriptions to
 * the same origin in this page make one attempt for `fallbackMemoryMs`. In a
 * hidden tab it pauses without counting a failure. It never throws and never
 * logs: a browser that cannot hold the socket behaves exactly as one without
 * push.
 */
export function createTopicSubscription(
  url: string,
  onSignal: (event: SignalEvent) => void,
  options: SubscriptionOptions = {},
): TopicSubscription {
  const pingIntervalMs = options.pingIntervalMs ?? SUBSCRIPTION_DEFAULTS.pingIntervalMs;
  const maxAttempts = options.maxAttempts ?? SUBSCRIPTION_DEFAULTS.maxAttempts;
  const baseDelayMs = options.baseDelayMs ?? SUBSCRIPTION_DEFAULTS.baseDelayMs;
  const maxDelayMs = options.maxDelayMs ?? SUBSCRIPTION_DEFAULTS.maxDelayMs;
  const random = options.random ?? Math.random;
  const Socket = options.WebSocket ?? globalThis.WebSocket;
  const memory = options.fallbackMemory ?? pageFallbackMemory;
  const origin = originOf(url);
  const visibility =
    options.pauseWhenHidden === false
      ? undefined
      : (options.visibility ?? (typeof document === "undefined" ? undefined : document));

  let socket: WebSocket | null = null;
  let failures = 0;
  let everOpened = false;
  let resumed = false;
  let paused = false;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let hiddenTimer: ReturnType<typeof setTimeout> | undefined;

  /** Failures to start from: one short of the limit while this origin's fallback is remembered. */
  function startingFailures(): number {
    const until = memory.get(origin);
    if (until === undefined) return 0;
    if (until > Date.now()) return maxAttempts - 1;
    memory.delete(origin);
    return 0;
  }

  function stopPinging(): void {
    if (pingTimer !== undefined) clearInterval(pingTimer);
    pingTimer = undefined;
  }

  function clearHiddenTimer(): void {
    if (hiddenTimer !== undefined) clearTimeout(hiddenTimer);
    hiddenTimer = undefined;
  }

  /** Close the current socket, if any, without it counting as a loss. */
  function dropSocket(): void {
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    stopPinging();
    const current = socket;
    socket = null;
    if (current) {
      try {
        current.close(1000, "done");
      } catch {
        // Defensive: a browser socket does not throw here; an injected stand-in might.
      }
    }
  }

  function stop(): void {
    stopped = true;
    clearHiddenTimer();
    visibility?.removeEventListener("visibilitychange", onVisibilityChange);
    dropSocket();
  }

  /** Hand `event` to the subscriber. A subscriber that throws cannot stop the reconnect loop. */
  function emit(event: SignalEvent): void {
    try {
      onSignal(event);
    } catch {
      // The subscriber's own failure; the subscription carries on.
    }
  }

  function fallBack(): void {
    stop();
    if (everOpened) emit({ reason: "stopped" });
    else memory.set(origin, Date.now() + SUBSCRIPTION_DEFAULTS.fallbackMemoryMs);
    try {
      options.onFallback?.();
    } catch {
      // As for onSignal: nothing is left running to protect.
    }
  }

  function retry(): void {
    if (stopped || paused) return;
    if (failures >= maxAttempts) {
      fallBack();
      return;
    }
    const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, failures - 1));
    retryTimer = setTimeout(connect, Math.floor(random() * ceiling));
  }

  /** `ws` is gone — closed, or abandoned as silent. A no-op for any other socket. */
  function lost(ws: WebSocket, opened: boolean, answered: boolean, code: number | undefined): void {
    if (socket !== ws) return;
    socket = null;
    stopPinging();
    if (stopped) return;
    if (code === CLOSE_CODES.policy) {
      fallBack();
      return;
    }
    if (opened) emit({ reason: "dropped" });
    if (!answered) failures += 1;
    retry();
  }

  function pause(): void {
    hiddenTimer = undefined;
    if (stopped) return;
    paused = true;
    dropSocket();
  }

  function onVisibilityChange(): void {
    if (stopped || !visibility) return;
    if (visibility.visibilityState === "hidden") {
      if (!paused && hiddenTimer === undefined) hiddenTimer = setTimeout(pause, 2 * pingIntervalMs);
      return;
    }
    clearHiddenTimer();
    if (!paused) return;
    paused = false;
    resumed = true;
    // A subscription that has connected on this page has shown the origin is
    // reachable, so another one's remembered fallback does not shorten it.
    failures = everOpened ? 0 : startingFailures();
    connect();
  }

  function connect(): void {
    retryTimer = undefined;
    if (stopped || paused) return;
    let ws: WebSocket;
    try {
      ws = new Socket(url);
    } catch {
      // A URL the browser refuses outright, or a policy that blocks it.
      failures += 1;
      retry();
      return;
    }
    socket = ws;
    let opened = false;
    let answered = false;
    let pingOutstanding = false;

    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      opened = true;
      const reconnected = everOpened || resumed;
      everOpened = true;
      resumed = false;
      pingTimer = setInterval(() => {
        if (pingOutstanding) {
          lost(ws, true, answered, undefined);
          try {
            // With a code: a code-less close reaches the hub as 1005, which it cannot echo.
            ws.close(1000, "silent");
          } catch {
            // Defensive: a browser socket does not throw here; an injected stand-in might.
          }
          return;
        }
        pingOutstanding = true;
        try {
          ws.send(PING);
        } catch {
          // Defensive: a browser socket does not throw here; an injected stand-in might.
        }
      }, pingIntervalMs);
      if (reconnected) emit({ reason: "reconnected" });
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      if (socket !== ws) return;
      pingOutstanding = false;
      answered = true;
      failures = 0;
      memory.delete(origin);
      if (typeof event.data !== "string" || event.data === PONG) return;
      let frame: unknown;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (isSignal(frame)) emit({ reason: "message", signal: frame });
    });

    ws.addEventListener("close", (event: CloseEvent) => lost(ws, opened, answered, event.code));
  }

  failures = startingFailures();
  visibility?.addEventListener("visibilitychange", onVisibilityChange);
  if (visibility?.visibilityState === "hidden") onVisibilityChange();
  connect();
  return { close: stop };
}
