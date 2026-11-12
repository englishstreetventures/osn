import { commands } from "vitest/browser";

/**
 * What the overlay motion tests share: the two browser commands, typed, and a
 * record of every enter or exit animation as it starts.
 *
 * An exit runs for 80ms and its panel then unmounts, so reading the panel after
 * a close races the unmount. An `animationstart` listener on the document reads
 * the panel's computed style at the moment its animation starts, while the
 * panel is certainly there, and keeps what it read.
 */

type Media = { reducedMotion?: "reduce" | "no-preference"; forcedColors?: "active" | "none" };
type Pointer = { selector: string; x?: number; y?: number; steps?: number };

const typed = commands as unknown as {
  emulateMedia: (o: Media) => Promise<void>;
  movePointer: (o: Pointer) => Promise<void>;
};

export const emulateMedia = (options: Media) => typed.emulateMedia(options);

/** Move the real pointer onto `selector`, in `steps` moves. */
export const movePointer = (options: Pointer) => typed.movePointer(options);

/** One enter or exit animation, as its element's computed style read when it started. */
export interface Started {
  target: Element;
  name: string;
  /** Milliseconds. */
  duration: number;
  /** The computed `animation-timing-function`, as the browser writes it. */
  easing: string;
  enterScale: string;
  exitScale: string;
}

/** A computed time (`0.08s`, `80ms`) in milliseconds. */
export function ms(value: string): number {
  const v = value.trim().split(",")[0]!.trim();
  if (v.endsWith("ms")) return Number.parseFloat(v);
  if (v.endsWith("s")) return Number.parseFloat(v) * 1000;
  return Number.NaN;
}

/** A token the stylesheet declares on the root, in milliseconds. */
export const rootMs = (token: string) =>
  ms(getComputedStyle(document.documentElement).getPropertyValue(token));

/**
 * An easing token on the root, as the browser writes a computed
 * `animation-timing-function`. Resolved through a probe rather than read as
 * the token's text, which keeps whatever spacing the stylesheet wrote.
 */
export function rootEasing(token: string): string {
  const probe = document.createElement("div");
  probe.style.animationTimingFunction = `var(${token})`;
  document.body.append(probe);
  const value = getComputedStyle(probe).animationTimingFunction;
  probe.remove();
  return value;
}

/** Record every `ui-enter` and `ui-exit` animation that starts until `stop()`. */
export function watchAnimations(): { started: Started[]; stop: () => void } {
  const started: Started[] = [];
  const listen = (event: AnimationEvent) => {
    if (event.animationName !== "ui-enter" && event.animationName !== "ui-exit") return;
    const target = event.target as Element;
    const style = getComputedStyle(target);
    started.push({
      target,
      name: event.animationName,
      duration: ms(style.animationDuration),
      easing: style.animationTimingFunction,
      enterScale: style.getPropertyValue("--ui-enter-scale").trim(),
      exitScale: style.getPropertyValue("--ui-exit-scale").trim(),
    });
  };
  document.addEventListener("animationstart", listen, true);
  return { started, stop: () => document.removeEventListener("animationstart", listen, true) };
}

/** Wait `n` animation frames. */
export const frames = (n = 2) =>
  new Promise<void>((resolve) => {
    const step = (left: number) =>
      requestAnimationFrame(() => (left <= 1 ? resolve() : step(left - 1)));
    step(n);
  });

export const wait = (msToWait: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, msToWait));

/*
 * A timing bound measured between two of the page's own clock readings starts
 * when the browser acted, not when a Playwright command returned. Command lag
 * on a loaded runner then cannot push a "not yet" check past its moment, or
 * let a wrong delay slip through a wide window.
 */

/** When `type` first fires on `target`, by the page's clock; `NaN` until it has. */
export function firstEvent(target: Element, type: "pointerenter" | "pointerleave"): () => number {
  let at = Number.NaN;
  target.addEventListener(type, () => (at = performance.now()), { once: true });
  return () => at;
}

/** One element matching the watched selector, as it entered or left the document. */
export interface Seen {
  node: HTMLElement;
  /** `performance.now()` in the observer's callback, a microtask after the change. */
  at: number;
  /** Whether it carried `data-instant` when it arrived. */
  instant: boolean;
}

/** Record every element matching `selector` added to or removed from the page until `stop()`. */
export function watchNodes(selector: string): {
  added: Seen[];
  removed: Seen[];
  stop: () => void;
} {
  const added: Seen[] = [];
  const removed: Seen[] = [];
  const each = (nodes: NodeList, into: Seen[], at: number) => {
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;
      const found = node.matches(selector) ? [node] : [];
      found.push(...node.querySelectorAll<HTMLElement>(selector));
      for (const el of found) into.push({ node: el, at, instant: el.hasAttribute("data-instant") });
    }
  };
  const observer = new MutationObserver((records) => {
    const at = performance.now();
    for (const record of records) {
      each(record.addedNodes, added, at);
      each(record.removedNodes, removed, at);
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
  return { added, removed, stop: () => observer.disconnect() };
}
