/**
 * The demo's bottom sheet.
 *
 * `@shared/ui`'s `Modal` owns everything a sheet usually hand-rolls: the focus
 * trap, Escape and background inertness from `showModal()`, the top layer
 * instead of a `z-index`, and the entry and exit motion from its own
 * stylesheet. This file is the sheet's own shape and nothing else —
 * bottom-anchored on a phone, centred above `md`, and a close button in the
 * corner.
 *
 * The exit is the part worth knowing about. `close()` drops a dialog out of the
 * top layer immediately, so a CSS-only exit has nothing to paint, and the
 * platform's fix for that — the `overlay` property — is Chrome and Edge only.
 * `Modal` defers the `close()` call instead, which is why this still fades out
 * in Safari. See `wiki/architecture/component-library.md`.
 */

import Button from "@cire/ui/button";
import { Modal } from "@shared/ui/ui/modal";
import type { JSX } from "solid-js";

interface DemoModalProps {
  open: boolean;
  onClose: () => void;
  labelledBy?: string;
  children: JSX.Element;
}

export function DemoModal(props: DemoModalProps) {
  return (
    // `presentation="sheet"` is the whole shape: bottom-anchored on a phone,
    // centred above `md`, square bottom corners, a grip radius from the app's
    // own `--ui-radius-sheet`, and the padding that goes with all of it —
    // including the `env(safe-area-inset-bottom)` a sheet flush with the screen
    // edge needs. The width is a spacing-scale step rather than a contract
    // measure because this is one fixed sheet width, not a run of prose.
    <Modal
      open={props.open}
      onClose={props.onClose}
      labelledBy={props.labelledBy}
      presentation="sheet"
      class="relative max-w-120 overscroll-contain"
    >
      {/* `z-10` for the same reason the guest sheet's chip carries one: this is
          a positioned box that has to stay above the panel's contents, and the
          dietary pills below it are positioned too (`relative`, so their
          `sr-only` inputs resolve inside the pill rather than against this
          panel). Tree order would put the pills on top. */}
      <Button
        variant="bare"
        size="icon"
        aria-label="Close"
        onClick={props.onClose}
        class="absolute top-2 right-2 z-10 h-11 w-11"
      >
        &times;
      </Button>
      {props.children}
    </Modal>
  );
}
