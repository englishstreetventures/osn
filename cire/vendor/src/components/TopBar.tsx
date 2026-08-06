import type { RpSession } from "@shared/rp-auth";
import { createSignal, lazy, onCleanup, onMount, Show, Suspense } from "solid-js";

import AccountAvatar, { AVATAR_TRIGGER_CLASS } from "./AccountAvatar";
import ViewTabs, { type VendorView } from "./ViewTabs";

/**
 * Deferred because it is the package's only Kobalte consumer, and Kobalte's
 * dropdown-menu measures 86 KB raw / 28.6 KB gzip — about 80% of what the
 * dashboard bundle would otherwise grow by, for a menu most sessions never
 * open. The island is `client:only`, so anything on this path blocks the first
 * real frame; a vendor opens the portal to read an enquiry, not to change
 * their theme.
 *
 * The host portal pays nothing for this import — it already has Kobalte in the
 * graph for its dialogs, command palette and nav sheet — which is why the same
 * component is eager there and lazy here. A port is not always a port.
 */
const ProfileMenu = lazy(() => import("./ProfileMenu"));

/**
 * The portal's only chrome.
 *
 * It replaces two stacked bands — an Astro masthead carrying a "Vendor Portal"
 * eyebrow above a `Your business` display heading, and a row of four bare
 * text buttons under it — with one sticky row. The masthead said nothing a
 * signed-in vendor needed twice, and cost the whole first screen to say it.
 *
 * The design law it enforces: **the container is continuous; only its contents
 * change.** Nothing below this bar is chrome, so the first thing under it is
 * always the thing the vendor came for.
 *
 * Reading left to right it answers two questions in order: whose product
 * (wordmark), and which of the two views am I in (tabs). Account housekeeping
 * sits at the far end, in a menu, away from the work. The wordmark doubles as
 * the way back to the listings view, which is why its accessible name says so —
 * a logo that navigates and doesn't announce it is a trap for anyone not
 * looking at it.
 *
 * Sticky rather than fixed so it participates in flow and the page below needs
 * no compensating top padding. `overflow-x: clip` (not `hidden`) on the
 * document is load-bearing for that: `hidden` would make the document a scroll
 * container and strand the bar mid-page.
 */
export default function TopBar(props: {
  session: RpSession | null | undefined;
  view: VendorView;
  onView: (next: VendorView) => void;
  onHome: () => void;
  onSignOut: () => void;
}) {
  // The static bar in `index.astro` paints this row before the island's script
  // arrives, and stands in for it through the session check. It goes the moment
  // the real one exists — mount, not module load, so the two never overlap for
  // a frame and never both go missing.
  onMount(() => document.getElementById("boot-chrome")?.remove());

  // Whether the real menu has been asked for. Once true it stays true.
  const [wantMenu, setWantMenu] = createSignal(false);
  // Set only by a click on the placeholder, so the menu opens itself on arrival
  // and the press is not swallowed.
  const [autoOpen, setAutoOpen] = createSignal(false);

  // Warm the chunk when the browser is otherwise idle, so by the time anyone
  // reaches for the avatar it has already landed and there is nothing to wait
  // for. This is a prefetch, not a render — it does not mount Kobalte, and the
  // placeholder stays until something actually wants the menu.
  onMount(() => {
    const warm = () => void import("./ProfileMenu");
    // Safari still has no requestIdleCallback, and Safari is most of this
    // traffic — the timer is the real path, not the fallback.
    if (typeof requestIdleCallback === "function") {
      const id = requestIdleCallback(warm, { timeout: 3000 });
      onCleanup(() => cancelIdleCallback(id));
      return;
    }
    const id = setTimeout(warm, 1500);
    onCleanup(() => clearTimeout(id));
  });

  /**
   * The avatar button, without the menu behind it.
   *
   * Stands in twice: before anything has asked for the menu, and again for the
   * Suspense window while the chunk is in flight. Same class and same contents
   * as the real Kobalte trigger, so neither swap moves a pixel.
   *
   * Pointer-enter and focus ask for the menu ahead of the click, covering the
   * case where the idle warm has not fired. A click asks for it *and* opens it,
   * so a press that lands first is never swallowed.
   */
  const AccountPlaceholder = () => (
    <button
      type="button"
      aria-label="Account menu"
      aria-haspopup="menu"
      class={AVATAR_TRIGGER_CLASS}
      onPointerEnter={() => setWantMenu(true)}
      onFocus={() => setWantMenu(true)}
      onClick={() => {
        setAutoOpen(true);
        setWantMenu(true);
      }}
    >
      <AccountAvatar session={props.session} />
    </button>
  );

  return (
    <header class="border-border bg-bg/85 sticky top-0 z-30 border-b backdrop-blur-md">
      <div class="page-frame flex h-14 items-center gap-2 @2xl/frame:h-16">
        <button
          type="button"
          aria-label="Cire — your listings"
          onClick={() => props.onHome()}
          class="group hover:bg-surface/60 -mx-1 flex shrink-0 items-center gap-2 rounded-sm px-1.5 py-1.5 transition-colors duration-(--dur-fast) ease-(--ease-out)"
        >
          <span
            aria-hidden="true"
            class="text-gold group-hover:text-gold-ink text-[0.85rem] leading-none transition-colors duration-(--dur-fast)"
          >
            ✦
          </span>
          <span
            aria-hidden="true"
            class="font-display text-text text-[1.05rem] leading-none font-light tracking-[0.02em]"
          >
            Cire
          </span>
        </button>

        {/* Hidden below the strip's own breakpoint: at phone width the divider
            and the tabs together overflow the row, and the tabs are the half
            that carries meaning. */}
        <span aria-hidden="true" class="bg-border hidden h-5 w-px shrink-0 @md/frame:block" />

        <ViewTabs value={props.view} onChange={props.onView} />

        <div class="ml-auto flex shrink-0 items-center gap-2">
          {/*
            The placeholder wears the same class and the same contents as the
            real trigger (`AccountAvatar`), so the swap moves nothing and there
            is no flash to see. It is a real button with the real accessible
            name — not a decorative circle — because it is reachable by keyboard
            during the window it is up, and a focusable thing that announces
            nothing is worse than the wait it covers.

            Pointer-enter and focus ask for the menu before the click arrives,
            which covers the case where the idle warm has not fired yet. A click
            asks for it *and* opens it, so the press is never swallowed.
          */}
          <Show when={wantMenu()} fallback={<AccountPlaceholder />}>
            {/*
              The same placeholder covers the Suspense window. It must be the
              *button*, not a decorative circle: a keyboard user who focused the
              placeholder is the reason the chunk is loading at all, and swapping
              their focused element for a non-focusable one drops focus to
              `<body>` mid-interaction.
            */}
            <Suspense fallback={<AccountPlaceholder />}>
              <ProfileMenu
                session={props.session}
                onSignOut={props.onSignOut}
                autoOpen={autoOpen()}
              />
            </Suspense>
          </Show>
        </div>
      </div>
    </header>
  );
}
