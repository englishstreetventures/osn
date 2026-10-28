import {
  type Accessor,
  createContext,
  createMemo,
  type JSX,
  onCleanup,
  Show,
  useContext,
} from "solid-js";
import { Portal } from "solid-js/web";

/**
 * The module shell's view bar, as a view sees it.
 *
 * A module with sub-tabs draws one compact bar under its title: the sub-tabs,
 * then whatever controls the open view lends it — the RSVP page's event strip
 * and search, the household list's search, the editor's mode switch. The bar
 * sticks under the top bar as the page scrolls, and it is the same bar stuck or
 * not: nothing in it changes size when it sticks (Safari has no scroll
 * anchoring to hide a jump). `cire/host/DESIGN.md` §The stuck stack.
 *
 * A view never reaches into the shell for this. It wraps its controls in
 * `<ViewBar slot="end">` (the sub-tabs' own row) or `<ViewBar slot="row2">`
 * (a second row, drawn only when something fills it), and the bar portals them
 * into its mounts. The controls keep the view's own owner, so their signals,
 * context and cleanup are the view's.
 *
 * Rendered with no shell around it — a view alone in a test, or a module with
 * no bar — a `ViewBar` draws its children where it stands. It never falls back
 * to `document.body`, which is where Solid's `Portal` goes with no mount.
 */

export type ViewBarSlot = "end" | "row2";

export interface ViewBarContextValue {
  /** Where a slot's controls go; `undefined` while the module draws no bar. */
  mount: (slot: ViewBarSlot) => HTMLElement | undefined;
  /** The module panel's inline size in px, `null` until first measured. */
  panelWidth: Accessor<number | null>;
  /**
   * Ask the shell to keep the panel at least a screen tall until the view's
   * data has arrived, so a sub-tab change made deep in a long list cannot
   * clamp the page while the new view loads. Returns the release; call it
   * once, on ready or on cleanup, whichever comes first.
   */
  hold: () => () => void;
}

export const ViewBarContext = createContext<ViewBarContextValue>();

/** The shell's bar, or `undefined` for a view drawn alone. */
export function useViewBar(): ViewBarContextValue | undefined {
  return useContext(ViewBarContext);
}

/** Controls a view lends the module's view bar. */
export function ViewBar(props: { slot: ViewBarSlot; children: JSX.Element }) {
  const bar = useViewBar();
  const mount = () => bar?.mount(props.slot);
  return (
    <Show when={mount()} fallback={props.children} keyed>
      {(el) => <Portal mount={el}>{props.children}</Portal>}
    </Show>
  );
}

/** The root font size the portal is laid out in (`html { font-size: 16px }`). */
const REM_PX = 16;

/**
 * Whether a view draws its narrow layout, from the width the module panel has.
 *
 * Each view names the narrowest panel its wide layout fits in (`minRem`), and
 * goes narrow below it. It comes back only once the panel is a rem wider than
 * that, so a panel resized across the line does not flip on every pixel. A
 * page-scrolling table is clipped rather than scrolled, so a view that draws
 * one must never draw it narrower than its columns: the minimum is the sum of
 * those columns.
 *
 * Alone — no shell — the answer is `alone()`, a prop the view's caller sets,
 * so a layout test chooses the variant outright.
 *
 * `known()` is false until the shell has measured the panel: a view renders
 * nothing list-shaped before then, so it never draws the wrong variant first.
 */
export interface CompactLayout {
  /** Draw the narrow layout. */
  compact: Accessor<boolean>;
  /** The panel has been measured, so `compact` is the real answer. */
  known: Accessor<boolean>;
}

export function createCompact(minRem: () => number, alone: () => boolean): CompactLayout {
  const bar = useViewBar();
  if (!bar) return { compact: alone, known: () => true };
  const compact = createMemo<boolean>((was) => {
    const width = bar.panelWidth();
    if (width === null) return was;
    const min = minRem() * REM_PX;
    return was ? width < min + REM_PX : width < min;
  }, false);
  return { compact, known: () => bar.panelWidth() !== null };
}

/**
 * Hold the panel open until `ready()` says the view's data is in. A no-op
 * outside a shell. Released on cleanup too, so a view torn down mid-load never
 * strands the panel at a screen's height.
 */
export function holdUntilReady(): () => void {
  const release = useViewBar()?.hold();
  let done = false;
  const ready = () => {
    if (done) return;
    done = true;
    release?.();
  };
  onCleanup(ready);
  return ready;
}
