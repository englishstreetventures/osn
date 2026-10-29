import Button from "@cire/ui/button";
import { Chip, type ChipTone } from "@shared/ui/ui/chip";
import { createSignal, For, Show } from "solid-js";

import type { EnquiryListItem } from "../lib/enquiries-store";
// Formatters are shared and memoised: this renders inside a `<For>`, so a
// per-call `new Intl.NumberFormat` would cost one construction per row per render.
import { formatMinor } from "../lib/money";
import { categoryLabel } from "../lib/service-categories";

/** Short, human-readable date from a ms-epoch timestamp. */
function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const STATUS_CHIP = {
  open: "Open",
  quoted: "Quoted",
  closed: "Closed",
} satisfies Record<EnquiryListItem["status"], string>;

/** The tone each status wears, the same as on the vendor portal's inbox, so an
 *  enquiry reads alike from both ends. */
const STATUS_TONE = {
  open: "pending",
  quoted: "accent",
  closed: "neutral",
} satisfies Record<EnquiryListItem["status"], ChipTone>;

interface EnquiryInboxProps {
  items: EnquiryListItem[];
  currency: string;
  onOpen: (id: string) => void;
  /** The open enquiry, when the view is showing the inbox and the thread side
   *  by side — the row needs to say which conversation is on screen. Absent on
   *  narrow layouts, where the inbox is never visible at the same time. */
  selectedId?: string | null;
  /** Another page follows the rows shown. */
  hasMore?: boolean;
  /** The next page is on its way. */
  loadingMore?: boolean;
  /** Fetch the next page; resolves once it has landed in `items` (or failed). */
  onLoadMore?: () => Promise<void>;
}

export default function EnquiryInbox(props: EnquiryInboxProps) {
  // After a next page lands, focus moves to its first row and the count is
  // announced: the button pressed may be gone (the last page) and the new rows
  // arrive below it, out of view of a screen reader.
  const rowButtons = new Map<string, HTMLButtonElement>();
  const [announcement, setAnnouncement] = createSignal("");
  const loadMore = async () => {
    const before = props.items.length;
    await props.onLoadMore?.();
    const after = props.items;
    if (after.length <= before) return;
    const added = after.length - before;
    setAnnouncement(added === 1 ? "1 more enquiry loaded" : `${added} more enquiries loaded`);
    rowButtons.get(after[before]!.id)?.focus();
  };

  return (
    <div class="flex flex-col gap-2">
      <output class="sr-only">{announcement()}</output>
      <Show
        when={props.items.length > 0}
        fallback={<p class="text-text-muted text-ui-sm italic">No enquiries yet.</p>}
      >
        <ul class="flex flex-col gap-1">
          <For each={props.items}>
            {(item) => {
              const isOpen = () => props.selectedId != null && props.selectedId === item.id;
              return (
                <li>
                  {/* Raw: the whole row is the control and wraps its contents,
                      which `tile` (centred, one line) does not; it takes the
                      tile's corner. */}
                  <button
                    type="button"
                    ref={(el) => rowButtons.set(item.id, el)}
                    onClick={() => props.onOpen(item.id)}
                    aria-current={isOpen() ? "true" : undefined}
                    class="rounded-ui-field transition-ui-colors flex w-full flex-wrap items-center gap-3 border px-3 py-2 text-left duration-(--dur-fast) ease-(--ease-out)"
                    classList={{
                      "border-gold/50 bg-gold/5": isOpen(),
                      "border-border bg-surface/10 hover:bg-surface/20": !isOpen(),
                    }}
                  >
                    {/* Vendor name */}
                    <span class="text-text text-ui-base min-w-40 flex-1 font-medium">
                      {item.vendorName}
                    </span>

                    {/* Category chip */}
                    <span class="bg-surface/60 text-text-muted text-ui-xs rounded-full px-2 py-0.5">
                      {categoryLabel(item.category)}
                    </span>

                    {/* Status chip */}
                    <Chip tone={STATUS_TONE[item.status]}>{STATUS_CHIP[item.status]}</Chip>

                    {/* Quote (when present) */}
                    <Show when={item.quotedMinor != null}>
                      <span class="text-text text-ui-sm">
                        {formatMinor(item.quotedMinor!, props.currency)}
                      </span>
                    </Show>

                    {/* Last message date */}
                    <span class="text-text-muted text-ui-sm shrink-0">
                      {shortDate(item.lastMessageAt)}
                    </span>
                  </button>
                </li>
              );
            }}
          </For>
        </ul>
        <Show when={props.hasMore}>
          {/* `aria-disabled`, not `disabled`, so the button keeps focus while
              the page loads; `Button` swallows the click meanwhile. */}
          <Button
            variant="quiet"
            size="sm"
            class="self-start"
            aria-disabled={props.loadingMore ? "true" : undefined}
            onClick={() => void loadMore()}
          >
            {props.loadingMore ? "Loading…" : "Load more enquiries"}
          </Button>
        </Show>
      </Show>
    </div>
  );
}
