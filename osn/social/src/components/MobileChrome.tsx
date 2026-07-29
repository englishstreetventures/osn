import { MobileNav } from "./MobileNav";
import { MobileTopBar } from "./MobileTopBar";

/**
 * The mobile shell as one unit (and one lazy chunk): the top bar sits above
 * the scroll column in the layout flow; the tab bar is fixed to the bottom
 * edge, so DOM adjacency is fine. Mounted only below `md` (P-W1) — the
 * `md:hidden` classes on both parts stay as a resize/paint belt-and-braces.
 */
export function MobileChrome() {
  return (
    <>
      <MobileTopBar />
      <MobileNav />
    </>
  );
}
