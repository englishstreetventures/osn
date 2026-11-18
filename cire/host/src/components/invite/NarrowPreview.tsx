/**
 * The composed preview below the builder's wide breakpoint, where there is no
 * room for the sticky side pane: the view bar's Preview button opens it with a
 * wave, and "Back to editing" runs the wave back. Two waves live side by side
 * until the owner chooses one (englishstreetventures/osn#2415), picked by the
 * page's `?preview-wave=` parameter:
 *
 * - **Gilded** (the default, `@cire/waves/gilded`): the preview is a fixed
 *   frame over the panel, from the foot of the view bar to the bottom of the
 *   window. It is portalled to `<body>`, because the shell's container boxes
 *   are the containing block of anything `position: fixed` inside them, and it
 *   sits outside the builder, which goes `inert` under it. It mounts only
 *   while open, so a closed preview takes no token writes.
 * - **Distortion** (`?preview-wave=distortion`, `@cire/waves/distortion`): the
 *   form column and the preview are the wave's two views, as upstream lays them
 *   out; the builder wraps the column (`InviteBuilder.tsx`), the controller
 *   makes the hidden view inert, and the page scrolls to the column's top on
 *   opening and back on closing.
 *
 * Each wave is a dynamic import, warmed when the pointer or focus reaches the
 * button. An import that fails opens the frame with no wave.
 *
 * Three states, so the wave always has a frame to run on: `wanted` (the
 * button's choice), `mounted` (the Gilded frame in the DOM, closed until the
 * flip) and `revealed` (the wave's target). The bar's words change at the
 * hand-over for Gilded, and at the press for Distortion, as upstream does.
 * Escape inside the preview, or on the button, goes back; focus moves to the
 * preview's heading on opening and back to the button on closing. Choosing a
 * section or a view, or the builder turning wide, closes it at once.
 */

import { eyebrowClass } from "@cire/ui/eyebrow";
import type { DistortionWaveHandle } from "@cire/waves/distortion";
import {
  batch,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  untrack,
  type Accessor,
  type JSX,
} from "solid-js";
import { Portal } from "solid-js/web";

import { chromeFoot, scrollToResults } from "../../lib/scroll-to-results";
import PreviewPane, { type PreviewPaneProps } from "./PreviewPane";

export type PreviewWave = "gilded" | "distortion";

type GildedModule = typeof import("@cire/waves/gilded");
type DistortionModule = typeof import("@cire/waves/distortion");

/** The wave a page asks for: `?preview-wave=distortion`, or Gilded for anything else. */
export function previewWaveFrom(search: string): PreviewWave {
  return new URLSearchParams(search).get("preview-wave") === "distortion" ? "distortion" : "gilded";
}

// One import per wave per page. A failure is forgotten, so a later press asks
// again; a browser that keeps a failed module (Chromium does, as the module map
// says to) refuses at once, and the preview opens with no wave.
let gildedLoad: Promise<GildedModule> | undefined;
let distortionLoad: Promise<DistortionModule> | undefined;

function loadGilded(): Promise<GildedModule> {
  gildedLoad ??= import("@cire/waves/gilded").catch((error: unknown) => {
    gildedLoad = undefined;
    throw error;
  });
  return gildedLoad;
}

function loadDistortion(): Promise<DistortionModule> {
  distortionLoad ??= import("@cire/waves/distortion").catch((error: unknown) => {
    distortionLoad = undefined;
    throw error;
  });
  return distortionLoad;
}

/** Where the Gilded frame lies: under the view bar, across the panel, to the window's foot. */
interface FrameBox {
  readonly top: number;
  readonly left: number;
  readonly width: number;
}

function frameBox(button: Element | undefined, builder: Element | undefined): FrameBox {
  const bar = button?.closest("[data-view-bar]") ?? null;
  const across = (bar ?? builder)?.getBoundingClientRect();
  const top = builder ? chromeFoot(builder) : 0;
  return across
    ? { top: Math.max(0, top), left: across.left, width: across.width }
    : { top: Math.max(0, top), left: 0, width: window.innerWidth };
}

export interface NarrowPreviewOptions {
  readonly kind: PreviewWave;
  /** The Preview button and its wave can show: not wide, not on Codes. */
  readonly previewable: Accessor<boolean>;
  /** What closes the preview at once when it changes: the section and the view. */
  readonly place: Accessor<unknown>;
}

export interface NarrowPreview {
  readonly kind: PreviewWave;
  /** The bar's word: "Back to editing" once the preview has taken over. */
  readonly labelBack: Accessor<boolean>;
  /** The builder is under the Gilded frame, or on its way there: inert. */
  readonly away: Accessor<boolean>;
  /** The Gilded frame is in the DOM, and the module it runs on. */
  readonly mounted: Accessor<boolean>;
  readonly gilded: Accessor<GildedModule | null>;
  /** The loaded Distortion module, once the page asks for it and it arrives. */
  readonly distortion: Accessor<DistortionModule | null>;
  readonly revealed: Accessor<boolean>;
  readonly button: Accessor<HTMLButtonElement | undefined>;
  readonly box: Accessor<FrameBox>;
  setButton(el: HTMLButtonElement): void;
  setBuilder(el: HTMLElement): void;
  setHeading(el: HTMLElement): void;
  setDistortion(handle: DistortionWaveHandle): void;
  /** The press: open, or go back. */
  toggle(): void;
  /** Loads the wave before the press. */
  warm(): void;
  /** Escape goes back. */
  onKeyDown(e: KeyboardEvent): void;
  onGildedHandover(revealed: boolean): void;
  onGildedFinish(revealed: boolean): void;
  onDistortionFinish(revealed: boolean): void;
}

export function createNarrowPreview(options: NarrowPreviewOptions): NarrowPreview {
  const [wanted, setWanted] = createSignal(false);
  const [mounted, setMounted] = createSignal(false);
  const [revealed, setRevealed] = createSignal(false);
  const [labelBack, setLabelBack] = createSignal(false);
  const [away, setAway] = createSignal(false);
  const [gilded, setGilded] = createSignal<GildedModule | null>(null);
  const [distortion, setDistortion] = createSignal<DistortionModule | null>(null);
  const [button, setButton] = createSignal<HTMLButtonElement>();
  const [box, setBox] = createSignal<FrameBox>({ top: 0, left: 0, width: 0 });
  let builder: HTMLElement | undefined;
  let heading: HTMLElement | undefined;
  let handle: DistortionWaveHandle | undefined;
  /** The page's scroll before Distortion moved it, to put it back. */
  let scrolled: number | null = null;
  /** This opening runs Distortion's wave rather than the frame. */
  let viaDistortion = false;

  // Distortion wraps the form column whenever the preview can open, so its
  // first picture is taken at idle, before the press, as upstream does.
  createEffect(() => {
    if (options.kind !== "distortion" || !options.previewable()) return;
    loadDistortion().then(
      (mod) => setDistortion(() => mod),
      () => setDistortion(null),
    );
  });

  // While the frame is up, it follows the bar: the page can still move under
  // a wheel over the bar, and the window can change size.
  createEffect(() => {
    if (!mounted()) return;
    let frame = 0;
    const follow = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setBox(frameBox(button(), builder)));
    };
    window.addEventListener("resize", follow, { passive: true });
    window.addEventListener("scroll", follow, { passive: true });
    onCleanup(() => {
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", follow);
      window.removeEventListener("scroll", follow);
    });
  });

  const focusButton = () => {
    const b = button();
    if (b?.isConnected) b.focus({ preventScroll: true });
  };
  const focusHeading = () => heading?.focus({ preventScroll: true });

  function closeAtOnce() {
    if (!wanted() && !mounted() && !revealed() && !labelBack()) return;
    handle?.reset();
    scrolled = null;
    viaDistortion = false;
    batch(() => {
      setWanted(false);
      setRevealed(false);
      setMounted(false);
      setLabelBack(false);
      setAway(false);
    });
  }

  createEffect(on(options.place, () => untrack(closeAtOnce), { defer: true }));
  createEffect(() => {
    if (!options.previewable()) untrack(closeAtOnce);
  });

  async function open() {
    setWanted(true);
    if (options.kind === "distortion" && distortion() && handle) {
      viaDistortion = true;
      setLabelBack(true);
      const root = handle.element;
      if (root) {
        scrolled = window.scrollY;
        scrollToResults(root, chromeFoot(root));
      }
      setRevealed(true);
      return;
    }
    viaDistortion = false;
    // Distortion's page with no Distortion module opens the frame with no wave.
    const mod = options.kind === "gilded" ? await loadGilded().catch(() => null) : null;
    if (!wanted()) return;
    batch(() => {
      setAway(true);
      setBox(frameBox(button(), builder));
      setGilded(() => mod);
      setMounted(true);
      setRevealed(true);
    });
  }

  function close() {
    setWanted(false);
    if (viaDistortion) setLabelBack(false);
    setRevealed(false);
  }

  return {
    kind: options.kind,
    labelBack,
    away,
    mounted,
    gilded,
    distortion,
    revealed,
    button,
    box,
    setButton,
    setBuilder: (el) => (builder = el),
    setHeading: (el) => (heading = el),
    setDistortion: (h) => (handle = h),
    toggle() {
      if (wanted()) close();
      else void open();
    },
    warm() {
      if (options.kind === "gilded") void loadGilded().catch(() => undefined);
    },
    onKeyDown(e) {
      if (e.key !== "Escape" || !wanted()) return;
      e.preventDefault();
      close();
    },
    onGildedHandover(shown) {
      setLabelBack(shown);
      if (shown) {
        focusHeading();
        return;
      }
      setAway(false);
      focusButton();
    },
    onGildedFinish(shown) {
      if (!shown) setMounted(false);
    },
    onDistortionFinish(shown) {
      if (shown) {
        focusHeading();
        return;
      }
      viaDistortion = false;
      if (scrolled !== null) window.scrollTo({ top: scrolled, behavior: "instant" });
      scrolled = null;
      focusButton();
    },
  };
}

/** The composed preview under its heading, the same in the frame and in Distortion's view. */
export function PreviewView(
  props: PreviewPaneProps & { headingId: string; setHeading: (el: HTMLElement) => void },
) {
  return (
    <div class="mx-auto flex w-full max-w-md flex-col gap-4">
      {/* Focus lands here on opening, so a screen reader starts at the top. */}
      <h2
        ref={props.setHeading}
        id={props.headingId}
        tabIndex={-1}
        class={`${eyebrowClass()} focus:outline-none`}
      >
        Live preview
      </h2>
      <PreviewPane {...props} />
    </div>
  );
}

/**
 * The Gilded frame: fixed over the panel under the view bar, portalled to
 * `<body>`, scrolling inside itself. With the Gilded module it runs the wave;
 * without (an import that failed, or Distortion's page with no Distortion) it
 * shows and hides at once.
 */
export function PreviewFrame(props: {
  preview: NarrowPreview;
  headingId: string;
  children: JSX.Element;
}) {
  let frame!: HTMLElement;
  const p = props.preview;
  onMount(() => {
    // Escape anywhere inside the frame goes back, as the modal's did.
    frame.addEventListener("keydown", p.onKeyDown);
    const Wave = untrack(p.gilded)?.GildedWave;
    if (!Wave) {
      createEffect(() => {
        const shown = p.revealed();
        frame.hidden = !shown;
        untrack(() => {
          p.onGildedHandover(shown);
          p.onGildedFinish(shown);
        });
      });
      return;
    }
    const wave = new Wave(frame);
    onCleanup(() => wave.destroy());
    // The first call places the frame, closed; the effect's first run opens it.
    wave.update({ revealed: false });
    createEffect(() =>
      wave.update({
        revealed: p.revealed(),
        source: p.button() ?? null,
        onHandover: p.onGildedHandover,
        onFinish: p.onGildedFinish,
      }),
    );
  });
  return (
    <Portal>
      <section
        ref={frame}
        hidden
        data-preview-frame
        aria-labelledby={props.headingId}
        class="bg-bg fixed bottom-0 z-30 overflow-y-auto overscroll-contain px-4 pt-4 pb-8"
        style={{
          top: `${p.box().top}px`,
          left: `${p.box().left}px`,
          width: `${p.box().width}px`,
        }}
      >
        {props.children}
      </section>
    </Portal>
  );
}
