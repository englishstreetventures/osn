import { useAuth } from "@osn/client/solid";
import { createResource, For, Show } from "solid-js";

import { listEnquiries, type VendorEnquiryListItem } from "../lib/enquiries-store";
import { categoryLabel } from "../lib/service-categories";

// ── Tailwind class constants (mirrors vendor portal idiom) ─────────────────
const labelClass = "font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase";

// Status chip colour map
function statusChipClass(status: VendorEnquiryListItem["status"]): string {
  switch (status) {
    case "open":
      return "bg-gold/10 text-gold";
    case "quoted":
      return "bg-blue-500/10 text-blue-400";
    case "closed":
      return "bg-surface/40 text-text-muted";
  }
}

// Short relative date (e.g. "2 h ago", "3 d ago")
function shortDate(epochMs: number): string {
  const diffMs = Date.now() - epochMs;
  const diffMins = Math.floor(diffMs / 60_000);
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

interface VendorEnquiryInboxProps {
  onOpen: (id: string) => void;
}

// Module-scoped so the formatter is built once, not on every mount/view-switch.
const aud = new Intl.NumberFormat(undefined, { style: "currency", currency: "AUD" });

export default function VendorEnquiryInbox(props: VendorEnquiryInboxProps) {
  const { authFetch } = useAuth();

  const [rows] = createResource(() => listEnquiries(authFetch));

  return (
    <div class="flex flex-col gap-4">
      {/* Header */}
      <div>
        <p class="text-gold-dim font-body text-[0.68rem] tracking-[0.16em] uppercase">Enquiries</p>
        <h2 class="text-text font-body mt-0.5 text-[1.05rem] font-medium">Your inbox</h2>
      </div>

      {/* Loading */}
      <Show when={rows.loading}>
        <p
          role="status"
          class="font-body text-text-muted animate-pulse text-[0.88rem] tracking-[0.1em] uppercase"
        >
          Loading enquiries…
        </p>
      </Show>

      {/* Error */}
      <Show when={rows.error}>
        <p
          role="alert"
          class="border-error/40 bg-error/5 text-error rounded-sm border p-4 text-[0.88rem]"
        >
          Could not load enquiries. Please refresh.
        </p>
      </Show>

      {/* Empty state */}
      <Show when={!rows.loading && !rows.error && (rows()?.length ?? 0) === 0}>
        <p class="text-text-muted font-body text-[0.9rem]">No enquiries yet.</p>
      </Show>

      {/* Row list */}
      <Show when={!rows.loading && !rows.error && (rows()?.length ?? 0) > 0}>
        <ul class="flex flex-col gap-2">
          <For each={rows()}>
            {(item) => (
              <li>
                <button
                  type="button"
                  onClick={() => props.onOpen(item.id)}
                  class="border-border bg-surface/30 hover:bg-surface/50 flex w-full flex-col gap-1 rounded-sm border px-4 py-3 text-left transition-colors"
                  aria-label={`${item.weddingName} – ${categoryLabel(item.category)}`}
                >
                  {/* Primary row: couple name + status chip */}
                  <div class="flex items-center justify-between gap-3">
                    <span class="text-text font-body font-medium">{item.weddingName}</span>
                    <span
                      class={`font-body rounded-full px-2 py-0.5 text-[0.68rem] tracking-[0.1em] uppercase ${statusChipClass(item.status)}`}
                    >
                      {item.status}
                    </span>
                  </div>

                  {/* Secondary row: category + quote + date */}
                  <div class="flex items-center gap-3">
                    <span class={labelClass}>{categoryLabel(item.category)}</span>
                    <Show when={item.quotedMinor != null}>
                      <span class="text-gold font-body text-[0.78rem]">
                        {aud.format(item.quotedMinor! / 100)}
                      </span>
                    </Show>
                    <span class="text-text-muted font-body ml-auto text-[0.72rem]">
                      {shortDate(item.lastMessageAt)}
                    </span>
                  </div>
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </div>
  );
}
