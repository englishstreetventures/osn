import { buttonClass } from "@cire/ui/button";
import Wordmark from "@cire/ui/wordmark";
import type { RpSession } from "@shared/rp-auth";
import { Chip } from "@shared/ui/ui/chip";
import { Tooltip } from "@shared/ui/ui/tooltip";
import Search from "lucide-solid/icons/search";
import { onMount, Show } from "solid-js";

import { normaliseWeddingRole, ROLE_COPY, surfacesFor } from "../lib/wedding-roles";
import type { WeddingSummary } from "./CreateWeddingForm";
import PreviewInviteButton from "./PreviewInviteButton";
import ProfileMenu from "./ProfileMenu";
import WeddingSwitcher from "./WeddingSwitcher";

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
  const role = () => {
    const wedding = props.wedding;
    return wedding ? normaliseWeddingRole(wedding.role) : null;
  };

  /** The open wedding, but only for a seat that may read it. */
  const previewable = () => {
    const wedding = props.wedding;
    const known = role();
    return wedding && known && surfacesFor(known).canOpenDashboard ? wedding : null;
  };

  return (
    <header class="border-border bg-bg/95 sticky top-0 z-30 border-b backdrop-blur-md">
      <div class="page-frame flex h-[calc(var(--chrome-h)-1px)] items-center gap-2">
        {/* ── Identity + place ─────────────────────────────────────────────── */}
        <Wordmark label="Cire — all weddings" onClick={() => props.onAll()} />

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
              <Show when={role()}>
                {(known) => (
                  // A badge explains itself in a Tooltip, never a `title`; the
                  // wrapper carries the narrow frame's hiding, so a hidden badge
                  // takes its explanation with it.
                  <span data-badge-tip class="hidden shrink-0 @2xl/frame:inline-flex">
                    <Tooltip text={ROLE_COPY[known()].badgeTitle}>
                      <Chip variant="outline" tone="accent">
                        {ROLE_COPY[known()].label}
                      </Chip>
                    </Tooltip>
                  </span>
                )}
              </Show>
            </>
          )}
        </Show>

        {/* ── Actions ──────────────────────────────────────────────────────── */}
        <div class="ml-auto flex shrink-0 items-center gap-2">
          {/* A pill, the top bar's 36px, as a search box reads (DESIGN.md §4,
              One pill language): the portals' pill ground and hairline, a
              16px magnifier and the shortcut, 12px in from each end; on a
              narrow bar the magnifier alone, in a 36px circle. */}
          {/* `buttonClass` on a native button rather than `Button`, because the
              pill sets its own sides at each width and `Button` owns its
              padding. */}
          <button
            type="button"
            aria-label="Search and jump to"
            aria-keyshortcuts="Meta+K Control+K"
            onClick={() => props.onOpenPalette()}
            class={`${buttonClass({ variant: "quiet", size: "sm" })} h-9 w-9 px-0 @2xl/frame:w-auto @2xl/frame:px-3`}
          >
            <Search aria-hidden="true" strokeWidth={1.75} class="size-4 shrink-0" />
            <span
              aria-hidden="true"
              class="font-body text-ui-xs tracking-ui-wider hidden @2xl/frame:inline"
            >
              ⌘K
            </span>
          </button>

          {/* Rendered at every width. The button collapses to its glyph on a
              narrow bar (see `PreviewInviteButton`) rather than being hidden
              here: seeing the invite as a guest sees it is one of the three
              from-anywhere actions this row exists to carry, and there is no
              other route to it — the palette lists modules, weddings and
              account, not preview.

              It mints a preview code through a member-gated route, so it needs
              the same surface the dashboard does: a seat without that one has
              nothing to preview and would get a 403 for pressing it. */}
          <Show when={previewable()}>
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
