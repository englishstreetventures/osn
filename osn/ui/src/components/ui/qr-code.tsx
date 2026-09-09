// oxlint-disable anti-slop/no-shape-in-symbol-names -- `shape-rendering` is an
// SVG presentation attribute named by the specification. The rule is about
// symbols we choose names for; this one we do not.
import { clsx } from "clsx";
import { createMemo, Show, type Component } from "solid-js";

import { encodeQr } from "../../lib/qr";

// Renders a string as a QR code, as one inline SVG.
//
// Accessibility notes
// -------------------
// - The SVG is `role="img"` with an `aria-label`, so it is announced as a
//   single graphic rather than as a few hundred rectangles.
// - **The label is not a substitute for the payload.** A QR code's real text
//   alternative is the thing it encodes, in a form a person can act on — for
//   TOTP enrolment that is the base32 secret as selectable text, which the
//   caller renders beside this component. `label` says what the graphic is
//   for and points at that text; it never contains the payload, which for
//   enrolment is secret material.
// - The quiet zone is drawn, not left to the page. Scanners need four light
//   modules on every side, and a QR flush against a dark background does not
//   read.
//
// Failing to encode renders nothing rather than throwing. The payload is
// always reachable another way on the surfaces that use this, so a symbol too
// large to represent costs a convenience rather than the screen.

/** Light modules of clear space required on every side. */
const QUIET_ZONE = 4;

export interface QrCodeProps {
  /** The string to encode. */
  value: string;
  /**
   * What the graphic is and where its text alternative is — not the payload.
   * Read out in place of the image.
   */
  label: string;
  class?: string;
}

export const QrCode: Component<QrCodeProps> = (props) => {
  const symbol = createMemo(() => {
    try {
      return encodeQr(props.value);
    } catch {
      // Only `QrCapacityError` reaches here, and the caller's fallback covers
      // it. Rendering half a symbol would be worse than rendering none.
      return null;
    }
  });

  // One path for every dark module beats one <rect> each: a version 8 symbol
  // has around a thousand of them, and a thousand elements is a slow, heavy
  // DOM for something that never changes after it is drawn.
  const path = createMemo(() => {
    const qr = symbol();
    if (!qr) return "";
    const parts: string[] = [];
    for (let row = 0; row < qr.size; row++) {
      for (let col = 0; col < qr.size; col++) {
        if (qr.modules[row]![col]) parts.push(`M${col + QUIET_ZONE} ${row + QUIET_ZONE}h1v1h-1z`);
      }
    }
    return parts.join("");
  });

  return (
    <Show when={symbol()}>
      {(qr) => (
        <svg
          role="img"
          aria-label={props.label}
          viewBox={`0 0 ${qr().size + QUIET_ZONE * 2} ${qr().size + QUIET_ZONE * 2}`}
          // Modules must land on whole pixels or a camera sees blurred edges
          // where it needs hard ones.
          shape-rendering="crispEdges"
          class={clsx("base:h-auto base:w-full base:max-w-[240px]", props.class)}
        >
          {/* The light ground is part of the symbol, so it is drawn rather
              than inherited — a dark page behind a transparent QR does not
              scan, and these surfaces have a dark theme. */}
          <rect width="100%" height="100%" fill="#fff" />
          <path d={path()} fill="#000" />
        </svg>
      )}
    </Show>
  );
};
