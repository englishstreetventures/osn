/**
 * The numbers behind dragging a `Dialog` sheet down to dismiss it, kept apart
 * from the wiring in `dialog.tsx`. They are the owner's (#2288).
 */

import { bandSlope, rubberBand } from "../lib/spring";

/** Share of the sheet's height past which a released drag closes it, however slow. */
const DISMISS_SHARE = 0.25;
/** Downward speed, in px per ms, at which a release closes the sheet as a flick. */
const FLICK_SPEED = 0.4;
/** The least finger travel a flick may close the sheet on, so a twitch never does. */
const FLICK_TRAVEL = 24;
/** How far back a release looks to measure the finger's speed, in ms. */
const SPEED_WINDOW_MS = 100;
/** How long a sample is kept, in ms: enough to cover the window at any frame rate. */
export const SAMPLE_KEEP_MS = 200;
/** A move under this, in px, is treated as noise when finding the finger's last turn. */
const TURN_NOISE_PX = 0.5;

/**
 * How far a press moves before it is read as a drag rather than a tap: 8px for
 * a finger, 4px for a mouse or a pen. A drag from the title row moves the
 * sheet from its first pixel; the slop there only decides whether the press
 * still counts as a tap on what it went down on.
 */
export function slopFor(pointerType: string): number {
  return pointerType === "touch" ? 8 : 4;
}

/** One place of the finger, at an event's `timeStamp`. */
export interface DragSample {
  y: number;
  t: number;
}

/**
 * The finger's speed in px per ms, down positive, over the last 100ms of
 * samples (newest last) but only since its last turn: a flick back up at the
 * end reads as up, rather than cancelling against the pull before it. A finger
 * held still before it lifts reads 0, since the lift's own sample is in the
 * window. 0 without two samples.
 */
export function releaseSpeed(samples: readonly DragSample[]): number {
  if (samples.length < 2) return 0;
  const last = samples[samples.length - 1]!;
  let direction = 0;
  for (let i = samples.length - 1; i > 0 && last.t - samples[i - 1]!.t <= SPEED_WINDOW_MS; i--) {
    const step = samples[i]!.y - samples[i - 1]!.y;
    if (Math.abs(step) > TURN_NOISE_PX) {
      direction = Math.sign(step);
      break;
    }
  }
  let first = last;
  for (let i = samples.length - 1; i >= 0 && last.t - samples[i]!.t <= SPEED_WINDOW_MS; i--) {
    if (i < samples.length - 1 && direction !== 0) {
      const step = samples[i + 1]!.y - samples[i]!.y;
      if (Math.sign(step) === -direction && Math.abs(step) > 2 * TURN_NOISE_PX) break;
    }
    first = samples[i]!;
  }
  const span = last.t - first.t;
  return span > 0 ? (last.y - first.y) / span : 0;
}

/**
 * Where the sheet sits for a finger `raw` px below where the drag took it
 * from, on a sheet `height` tall. Down, it follows the finger exactly; up past
 * rest it gives on the rubber band. A sheet that cannot close gives on the
 * band both ways.
 */
export function dragOffset(raw: number, height: number, refused: boolean): number {
  if (raw >= 0 && !refused) return raw;
  return rubberBand(raw, height);
}

/**
 * The sheet's own speed for a finger moving at `speed` px per ms with `raw`
 * px of travel: the finger's where the sheet follows it, the band's share of
 * it where the sheet gives on the band. A spring started from a release takes
 * this, so the sheet leaves the finger at the speed it was moving.
 */
export function sheetSpeed(speed: number, raw: number, height: number, refused: boolean): number {
  if (raw >= 0 && !refused) return speed;
  return speed * bandSlope(raw, height);
}

/** A drag at the moment the finger lifts. */
export interface Release {
  /** Where the sheet sits, px below its rest. */
  offset: number;
  /** How far the finger has moved since the drag began, px, down positive. */
  travel: number;
  /** The finger's speed at release ({@link releaseSpeed}). */
  speed: number;
  /** The sheet's height, px. */
  height: number;
  /** The sheet cannot close. */
  refused: boolean;
  /** The browser took the touch (`pointercancel`), so it never closes. */
  cancelled: boolean;
}

/**
 * Whether a released drag closes the sheet: a flick down at 0.4px/ms or more
 * after at least 24px of travel, or the sheet let go past a quarter of its
 * height without a last flick back up. A sheet that cannot close, and a drag
 * the browser cancelled, always go back.
 */
export function closesOnRelease(release: Release): boolean {
  if (release.refused || release.cancelled) return false;
  if (release.speed >= FLICK_SPEED && release.travel >= FLICK_TRAVEL) return true;
  return release.offset >= release.height * DISMISS_SHARE && release.speed > -FLICK_SPEED;
}
