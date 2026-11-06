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
