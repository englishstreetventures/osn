import { For, Show } from "solid-js";

import type { EnquiryListItem } from "../lib/enquiries-store";
import { categoryLabel } from "../lib/service-categories";

/** Format a minor-unit amount (cents) as a currency string. */
function formatMinor(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100);
  } catch {
    return (minor / 100).toFixed(2);
  }
}

/** Short, human-readable date from a ms-epoch timestamp. */
function shortDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const STATUS_CHIP: Record<EnquiryListItem["status"], string> = {
  open: "Open",
  quoted: "Quoted",
  closed: "Closed",
};

const STATUS_CHIP_CLASS: Record<EnquiryListItem["status"], string> = {
  open: "bg-surface/60 text-text-muted",
  quoted: "bg-gold/10 text-gold-dim",
  closed: "bg-surface/60 text-text-muted opacity-60",
};

interface EnquiryInboxProps {
  items: EnquiryListItem[];
  currency: string;
  onOpen: (id: string) => void;
}

export default function EnquiryInbox(props: EnquiryInboxProps) {
  return (
    <div class="flex flex-col gap-2">
      <Show
        when={props.items.length > 0}
        fallback={<p class="text-text-muted text-[0.85rem] italic">No enquiries yet.</p>}
      >
        <ul class="flex flex-col gap-1">
          <For each={props.items}>
            {(item) => (
              <li>
                <button
                  type="button"
                  onClick={() => props.onOpen(item.id)}
                  class="border-border bg-surface/10 hover:bg-surface/20 flex w-full flex-wrap items-center gap-3 rounded-sm border px-3 py-2 text-left transition-colors"
                >
                  {/* Vendor name */}
                  <span class="text-text min-w-[10rem] flex-1 text-[0.9rem] font-medium">
                    {item.vendorName}
                  </span>

                  {/* Category chip */}
                  <span class="bg-surface/60 text-text-muted rounded-full px-2 py-0.5 text-[0.72rem]">
                    {categoryLabel(item.category)}
                  </span>

                  {/* Status chip */}
                  <span
                    class={`rounded-full px-2 py-0.5 text-[0.72rem] ${STATUS_CHIP_CLASS[item.status]}`}
                  >
                    {STATUS_CHIP[item.status]}
                  </span>

                  {/* Quote (when present) */}
                  <Show when={item.quotedMinor != null}>
                    <span class="text-text text-[0.82rem]">
                      {formatMinor(item.quotedMinor!, props.currency)}
                    </span>
                  </Show>

                  {/* Last message date */}
                  <span class="text-text-muted shrink-0 text-[0.78rem]">
                    {shortDate(item.lastMessageAt)}
                  </span>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
