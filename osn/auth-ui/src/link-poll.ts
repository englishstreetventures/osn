import { onCleanup, onMount } from "solid-js";

/** The first poll waits this long after a link is sent; each later one longer, up to the cap. */
export const LINK_POLL_FIRST_MS = 2_000;
const LINK_POLL_GROWTH = 1.5;
export const LINK_POLL_MAX_MS = 10_000;

/**
 * What one poll found: keep waiting (`wait`), no answer about the request — a
 * network failure, a rate limit, a server error — so wait the longest
 * (`retry`), or the wait is over (`stop`).
 */
export type LinkPollStep = "wait" | "retry" | "stop";

export interface LinkPoll {
  /** Waits again from the start: the first poll after {@link LINK_POLL_FIRST_MS}. */
  start(): void;
  /** Polls now, unless a poll is already out, and starts the waits again. */
  now(): void;
  /** Stops waiting. A poll already out still answers, and is ignored. */
  stop(): void;
}

/**
 * The tab that began an emailed-link flow polls its request until the link is
 * confirmed, on this device or any other. `poll` makes one call and says what
 * it found; a throw counts as `retry`.
 *
 * One poll at a time: a poll that would start while one is out is merged into
 * it. The first waits two seconds, each later one half as long again, up to
 * ten. Coming back to the tab (focus, or the page becoming visible) polls at
 * once and starts the waits again from two seconds, since that is when the
 * person has most likely just confirmed. Everything stops when the component
 * that made it goes away.
 *
 * Call it during a component's setup: it registers its listeners on mount and
 * removes them, with its timer, on cleanup.
 */
export function createLinkPoll(poll: () => Promise<LinkPollStep>): LinkPoll {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let delay = LINK_POLL_FIRST_MS;
  let active = false;
  let polling = false;
  let disposed = false;

  function clear() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  function schedule(ms: number) {
    clear();
    if (disposed || !active) return;
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, ms);
  }

  async function run() {
    if (disposed || !active || polling) return;
    clear();
    polling = true;
    let step: LinkPollStep;
    try {
      step = await poll();
    } catch {
      step = "retry";
    } finally {
      polling = false;
    }
    if (disposed || !active) return;
    if (step === "stop") {
      active = false;
      return;
    }
    delay =
      step === "retry" ? LINK_POLL_MAX_MS : Math.min(delay * LINK_POLL_GROWTH, LINK_POLL_MAX_MS);
    schedule(delay);
  }

  function onReturn() {
    if (!active) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    delay = LINK_POLL_FIRST_MS;
    void run();
  }

  onMount(() => {
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
  });
  onCleanup(() => {
    disposed = true;
    clear();
    window.removeEventListener("focus", onReturn);
    document.removeEventListener("visibilitychange", onReturn);
  });

  return {
    start() {
      active = true;
      delay = LINK_POLL_FIRST_MS;
      schedule(delay);
    },
    now() {
      active = true;
      delay = LINK_POLL_FIRST_MS;
      void run();
    },
    stop() {
      active = false;
      clear();
    },
  };
}
