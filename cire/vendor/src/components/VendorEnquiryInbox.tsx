import Button from "@cire/ui/button";
import { cardClass } from "@cire/ui/card";
import Loading from "@cire/ui/loading";
import { Chip, type ChipTone } from "@shared/ui/ui/chip";
import { EmptyState } from "@shared/ui/ui/empty-state";
import { Notice } from "@shared/ui/ui/notice";
import { createSignal, For, onMount, Show } from "solid-js";

import type { VendorEnquiryListItem } from "../lib/enquiries-store";
import type { EnquiryInbox } from "../lib/enquiry-inbox";
import { categoryLabel } from "../lib/service-categories";
/**
 * A status, as a tone.
 *
 * The old map reached straight for the raw Tailwind palette —
 * `bg-blue-500/10 text-blue-400` for "quoted" — which is a fixed sRGB pair that
 * does not move when the theme flips. On the light ramp it was a bright blue
 * smear. These are ramp tones, so they re-point with everything else.
 */
function statusTone(status: VendorEnquiryListItem["status"]): ChipTone {
  switch (status) {
    case "open":
      return "pending";
    case "quoted":
      return "accent";
    case "closed":
      return "neutral";
  }
}

/**
 * Short relative age: "4m ago", "3h ago", "6d ago".
 *
 * Clamped at zero. `Date.now()` and the server's `lastMessageAt` come from two
 * different clocks, so a message written a second ago on a machine whose clock
 * is a minute slow used to render as "-1m ago".
 */
function shortDate(epochMs: number): string {
  const diffMins = Math.max(0, Math.floor((Date.now() - epochMs) / 60_000));
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.floor(diffHours / 24)}d ago`;
}

interface VendorEnquiryInboxProps {
  /** The dashboard's inbox: the pages loaded so far outlive this component. */
  inbox: EnquiryInbox;
  onOpen: (id: string) => void;
}

// Module-scoped so the formatter is built once, not on every mount/view-switch.
const aud = new Intl.NumberFormat(undefined, { style: "currency", currency: "AUD" });

export default function VendorEnquiryInbox(props: VendorEnquiryInboxProps) {
  // Read again on every mount, so a row a thread just changed is fresh; the
  // rows already held show meanwhile.
  onMount(() => void props.inbox.refresh());
  const rows = () => props.inbox.rows();

  // After a next page lands, focus moves to its first row and the count is
  // announced: the button the vendor pressed may be gone (the last page) and
  // the new rows arrive below it, out of view of a screen reader.
  const rowButtons = new Map<string, HTMLButtonElement>();
  const [announcement, setAnnouncement] = createSignal("");
  const loadMore = async () => {
    const before = rows()?.length ?? 0;
    await props.inbox.loadMore();
    const after = rows();
    if (!after || after.length <= before) return;
    const added = after.length - before;
    setAnnouncement(added === 1 ? "1 more enquiry loaded" : `${added} more enquiries loaded`);
    rowButtons.get(after[before]!.id)?.focus();
  };

  return (
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-0.5">
        <p class="font-body text-gold text-ui-xs tracking-ui-widest uppercase">Enquiries</p>
        <h2 class="font-display text-text text-ui-lg leading-tight font-light">Your inbox</h2>
      </div>

      <output class="sr-only">{announcement()}</output>

      <Show when={rows() === null && !props.inbox.failed()}>
        <Loading label="Loading enquiries…" />
      </Show>

      <Show when={props.inbox.failed()}>
        <Notice tone="danger" alert>
          Could not load enquiries. Please refresh.
        </Notice>
      </Show>

      <Show when={rows()?.length === 0}>
        <EmptyState
          title="No enquiries yet"
          description="When a couple asks about one of your listings, their message lands here."
        />
      </Show>

      <Show when={(rows()?.length ?? 0) > 0}>
        <ul class="flex list-none flex-col gap-2 p-0">
          <For each={rows()}>
            {(item) => (
              <li>
                {/* As in `OrgPicker`: the whole card is the control, so it is
                    a `<button>` wearing `cardClass` rather than a `Button` or a
                    `<div role="button">`. */}
                <button
                  type="button"
                  ref={(el) => rowButtons.set(item.id, el)}
                  onClick={() => props.onOpen(item.id)}
                  class={`${cardClass({ interactive: true })} w-full gap-1.5 p-4`}
                  aria-label={`${item.weddingName} – ${categoryLabel(item.category)}`}
                >
                  <div class="flex items-center justify-between gap-3">
                    <span class="font-body text-text min-w-0 truncate font-medium">
                      {item.weddingName}
                    </span>
                    <Chip tone={statusTone(item.status)}>{item.status}</Chip>
                  </div>

                  <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span class="font-body text-text-muted text-ui-xs tracking-ui-wider uppercase">
                      {categoryLabel(item.category)}
                    </span>
                    <Show when={item.quotedMinor != null}>
                      <span class="font-body text-gold-ink text-ui-sm tabular-nums">
                        {aud.format(item.quotedMinor! / 100)}
                      </span>
                    </Show>
                    {/* A machine-readable timestamp under the human one: "6d
                        ago" is unreadable out of context, and a `<time>` is what
                        gives the exact moment to anything that wants it. */}
                    <time
                      datetime={new Date(item.lastMessageAt).toISOString()}
                      class="font-body text-text-muted text-ui-xs ml-auto"
                    >
                      {shortDate(item.lastMessageAt)}
                    </time>
                  </div>
                </button>
              </li>
            )}
          </For>
        </ul>
        <Show when={props.inbox.nextCursor() !== null}>
          {/* `aria-disabled`, not `disabled`, so the button keeps focus while
              the page loads; `Button` swallows the click meanwhile. */}
          <Button
            variant="quiet"
            size="sm"
            class="self-start"
            aria-disabled={props.inbox.loadingMore() ? "true" : undefined}
            onClick={() => void loadMore()}
          >
            {props.inbox.loadingMore() ? "Loading…" : "Load more enquiries"}
          </Button>
        </Show>
      </Show>
    </div>
  );
}
