import Button from "@cire/ui/button";
import type { RpSession } from "@shared/rp-auth";
import { onMount, Show } from "solid-js";

import type { WeddingSummary } from "./CreateWeddingForm";
import PreviewInviteButton from "./PreviewInviteButton";
import ProfileMenu from "./ProfileMenu";
import WeddingSwitcher from "./WeddingSwitcher";

/** Role chips. The label is what the badge says; the title is why it matters,
 *  which is the part a co-host who has just been told "you can't edit that"
 *  actually needs. */
const ROLE_BADGE = {
  owner: { label: "Owner", title: "You created this wedding and manage who hosts it" },
  editor: { label: "Editor", title: "You can view and edit this wedding" },
  viewer: {
    label: "Viewer",
    title: "You can view this wedding — ask the owner for editor access to make changes",
  },
} satisfies Record<string, { label: string; title: string }>;

/**
 * The portal's only chrome.
 *
 * It replaces four stacked bands — an Astro masthead, a portal nav row, a
 * per-wedding header, and the sub-tab strip — with one sticky row. The design
 * law it enforces: **the container is continuous; only its contents change.**
 * Nothing below it is chrome, so the first thing under the bar is always the
 * thing the host came for.
 *
 * Reading left to right it answers three questions in order: whose product
 * (wordmark), which wedding (switcher + role), and what can I do from anywhere
 * (palette, preview, account). The wordmark doubles as the way home, which is
 * why its accessible name says so — a logo that navigates and doesn't announce
 * it is a trap for anyone not looking at it.
 *
 * Sticky rather than fixed so it participates in flow and the page below needs
 * no compensating top padding. `overflow-x: clip` (not `hidden`) on the
 * document is load-bearing for that: `hidden` would make the document a scroll
 * container and strand the bar mid-page.
 */
export default function TopBar(props: {
  session: RpSession | null | undefined;
  /** The open wedding, or null on the wedding list and the security view. */
  wedding: WeddingSummary | null;
  weddings: WeddingSummary[];
  /** What the bar names when no wedding is open — "All weddings", "Security". */
  sectionLabel: string;
  onWedding: (wedding: WeddingSummary) => void;
  onAll: () => void;
  onSecurity: () => void;
  onSignOut: () => void;
  onOpenPalette: () => void;
}) {
  // The static bar in `index.astro` paints this row before the island's script
  // arrives, and stands in for it through the session check. It goes the moment
  // the real one exists — mount, not module load, so the two never overlap for
  // a frame and never both go missing.
  onMount(() => document.getElementById("boot-chrome")?.remove());

  // A role the portal does not know badges as the *least* privileged one it
  // does. Roles come off the API, and a chip that overstates what a co-host may
  // do is worse than one that understates it — the API is the real gate either
  // way, so the only thing at stake here is what the host is told.
  const badge = () => {
    const wedding = props.wedding;
    if (!wedding) return null;
    return ROLE_BADGE[wedding.role] ?? ROLE_BADGE.viewer!;
  };

  return (
    <header class="border-border bg-bg/85 sticky top-0 z-30 border-b backdrop-blur-md">
      <div class="page-frame flex h-14 items-center gap-2 @2xl/frame:h-16">
        {/* ── Identity + place ─────────────────────────────────────────────── */}
        <button
          type="button"
          aria-label="Cire — all weddings"
          onClick={() => props.onAll()}
          class="group hover:bg-surface/60 -mx-1 flex shrink-0 items-center gap-2 rounded-sm px-1.5 py-1.5 transition-colors duration-(--dur-fast) ease-(--ease-out)"
        >
          <span
            aria-hidden="true"
            class="text-gold group-hover:text-gold-ink text-ui-sm leading-none transition-colors duration-(--dur-fast)"
          >
            ✦
          </span>
          <span
            aria-hidden="true"
            class="font-display text-text text-ui-md tracking-ui-wide leading-none font-light"
          >
            Cire
          </span>
        </button>

        <span aria-hidden="true" class="bg-border h-5 w-px shrink-0" />

        <Show
          when={props.wedding}
          fallback={
            <span class="font-body text-text-muted text-ui-xs tracking-ui-widest min-w-0 truncate px-2 uppercase">
              {props.sectionLabel}
            </span>
          }
        >
          {(wedding) => (
            <>
              <WeddingSwitcher
                current={wedding()}
                weddings={props.weddings}
                onSelect={props.onWedding}
                onAll={props.onAll}
              />
              <Show when={badge()}>
                {(role) => (
                  <span
                    class="border-gold-dim text-gold-ink font-body text-ui-xs tracking-ui-widest hidden shrink-0 rounded-full border px-2 py-0.5 uppercase @2xl/frame:inline"
                    title={role().title}
                  >
                    {role().label}
                  </span>
                )}
              </Show>
            </>
          )}
        </Show>

        {/* ── Actions ──────────────────────────────────────────────────────── */}
        <div class="ml-auto flex shrink-0 items-center gap-2">
          <Button
            variant="quiet"
            type="button"
            aria-label="Search and jump to"
            aria-keyshortcuts="Meta+K Control+K"
            onClick={() => props.onOpenPalette()}
            class="bg-surface/40 flex h-9 items-center gap-2"
          >
            <span aria-hidden="true" class="text-ui-sm leading-none">
              ⌕
            </span>
            <span
              aria-hidden="true"
              class="font-body text-ui-xs tracking-ui-wider hidden @2xl/frame:inline"
            >
              ⌘K
            </span>
          </Button>

          {/* Rendered at every width. The button collapses to its glyph on a
              narrow bar (see `PreviewInviteButton`) rather than being hidden
              here: seeing the invite as a guest sees it is one of the three
              from-anywhere actions this row exists to carry, and there is no
              other route to it — the palette lists modules, weddings and
              account, not preview. */}
          <Show when={props.wedding}>
            {(wedding) => <PreviewInviteButton weddingId={wedding().id} />}
          </Show>

          <ProfileMenu
            session={props.session}
            onSecurity={props.onSecurity}
            onSignOut={props.onSignOut}
          />
        </div>
      </div>
    </header>
  );
}
