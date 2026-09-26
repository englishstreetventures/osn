import { CLOSE_CODES, isSignal, PING, PONG, type Signal } from "../protocol";

/**
 * Why the subscriber should read again: a signal arrived; an open socket was
 * lost (a change may land while it is down); a socket reopened after a loss
 * (a change may have landed meanwhile); or the subscription gave up after
 * having been open (a member removed while their socket was down is refused
 * on every reconnect, and this is their last prompt to re-read).
 */
export type SignalEvent =
  | { readonly reason: "message"; readonly signal: Signal }
  | { readonly reason: "dropped" }
  | { readonly reason: "reconnected" }
  | { readonly reason: "stopped" };

export interface SubscriptionOptions {
  /** How often an open socket sends `ping`. A ping unanswered by the next one marks the socket dead. */
  readonly pingIntervalMs?: number;
  /** Consecutive attempts that never open before the subscription gives up. */
  readonly maxAttempts?: number;
  /** Ceiling of the first retry's delay; each further failure doubles it, up to `maxDelayMs`. */
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  /** Jitter source in [0, 1). */
  readonly random?: () => number;
  /** Called once when the subscription gives up for good. */
  readonly onFallback?: () => void;
  /** The WebSocket constructor; tests pass a stand-in. */
  readonly WebSocket?: new (url: string) => WebSocket;
}

export interface TopicSubscription {
  /** Close the socket and cancel every timer. Safe to call more than once. */
  close(): void;
}

export const SUBSCRIPTION_DEFAULTS = {
  pingIntervalMs: 25_000,
  maxAttempts: 6,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
} as const;

/**
 * Hold one socket open to `url` and call `onSignal` whenever the subscriber
 * should re-read. It reconnects with capped, jittered backoff, and after
 * `maxAttempts` consecutive failed attempts it stops and calls `onFallback`
 * once, leaving the product's own refetch triggers as the only ones. It never
 * throws and never logs: a browser that cannot hold the socket behaves exactly
 * as one without push.
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

  let socket: WebSocket | null = null;
  let failures = 0;
  let everOpened = false;
  let stopped = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;

  function stopPinging(): void {
    if (pingTimer !== undefined) clearInterval(pingTimer);
    pingTimer = undefined;
  }

  function stop(): void {
    stopped = true;
    if (retryTimer !== undefined) clearTimeout(retryTimer);
    retryTimer = undefined;
    stopPinging();
    const current = socket;
    socket = null;
    if (current) {
      try {
        current.close(1000, "done");
      } catch {
        // Already closing: nothing left to release.
      }
    }
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
    try {
      options.onFallback?.();
    } catch {
      // As for onSignal: nothing is left running to protect.
    }
  }

  function retry(): void {
    if (stopped) return;
    if (failures >= maxAttempts) {
      fallBack();
      return;
    }
    const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.max(0, failures - 1));
    retryTimer = setTimeout(connect, Math.floor(random() * ceiling));
  }

  /** `ws` is gone — closed, or abandoned as silent. A no-op for any other socket. */
  function lost(ws: WebSocket, opened: boolean, code: number | undefined): void {
    if (socket !== ws) return;
    socket = null;
    stopPinging();
    if (stopped) return;
    if (code === CLOSE_CODES.policy) {
      fallBack();
      return;
    }
    if (opened) emit({ reason: "dropped" });
    else failures += 1;
    retry();
  }

  function connect(): void {
    retryTimer = undefined;
    if (stopped) return;
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
    let pingOutstanding = false;

    ws.addEventListener("open", () => {
      if (socket !== ws) return;
      opened = true;
      const reconnected = everOpened;
      everOpened = true;
      failures = 0;
      pingTimer = setInterval(() => {
        if (pingOutstanding) {
          lost(ws, true, undefined);
          try {
            ws.close();
          } catch {
            // Closing a dead socket can throw; it is already abandoned.
          }
          return;
        }
        pingOutstanding = true;
        try {
          ws.send(PING);
        } catch {
          // The close event that follows handles it.
        }
      }, pingIntervalMs);
      if (reconnected) emit({ reason: "reconnected" });
    });

    ws.addEventListener("message", (event: MessageEvent) => {
      if (socket !== ws) return;
      pingOutstanding = false;
      if (typeof event.data !== "string" || event.data === PONG) return;
      let frame: unknown;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      if (isSignal(frame)) emit({ reason: "message", signal: frame });
    });

    ws.addEventListener("close", (event: CloseEvent) => lost(ws, opened, event.code));
  }

  connect();
  return { close: stop };
}
