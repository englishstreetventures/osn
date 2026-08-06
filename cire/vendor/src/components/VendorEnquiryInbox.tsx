import { useAuth } from "@shared/rp-auth/solid";
import { createResource, For, Show } from "solid-js";

import { listEnquiries, type VendorEnquiryListItem } from "../lib/enquiries-store";
import { categoryLabel } from "../lib/service-categories";
import { cardClass } from "./ui/Card";
import Chip, { type ChipTone } from "./ui/Chip";
import EmptyState from "./ui/EmptyState";
import Loading from "./ui/Loading";
import Notice from "./ui/Notice";

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
      return "active";
    case "quoted":
      return "quoted";
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
  onOpen: (id: string) => void;
}

// Module-scoped so the formatter is built once, not on every mount/view-switch.
const aud = new Intl.NumberFormat(undefined, { style: "currency", currency: "AUD" });

export default function VendorEnquiryInbox(props: VendorEnquiryInboxProps) {
  const { authFetch } = useAuth();

  const [rows] = createResource(() => listEnquiries(authFetch));

  return (
    <div class="flex flex-col gap-4">
      <div class="flex flex-col gap-0.5">
        <p class="font-body text-gold text-[0.7rem] tracking-[0.18em] uppercase">Enquiries</p>
        <h2 class="font-display text-text text-[1.4rem] leading-tight font-light">Your inbox</h2>
      </div>

      <Show when={rows.loading}>
        <Loading label="Loading enquiries…" />
      </Show>

      <Show when={rows.error}>
        <Notice tone="error" alert>
          Could not load enquiries. Please refresh.
        </Notice>
      </Show>

      <Show when={!rows.loading && !rows.error && (rows()?.length ?? 0) === 0}>
        <EmptyState
          title="No enquiries yet"
          description="When a couple asks about one of your listings, their message lands here."
        />
      </Show>

      <Show when={!rows.loading && !rows.error && (rows()?.length ?? 0) > 0}>
        <ul class="flex list-none flex-col gap-2 p-0">
          <For each={rows()}>
            {(item) => (
              <li>
                <button
                  type="button"
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
                    <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
                      {categoryLabel(item.category)}
                    </span>
                    <Show when={item.quotedMinor != null}>
                      <span class="font-body text-gold-ink text-[0.78rem] tabular-nums">
                        {aud.format(item.quotedMinor! / 100)}
                      </span>
                    </Show>
                    {/* A machine-readable timestamp under the human one: "6d
                        ago" is unreadable out of context, and a `<time>` is what
                        gives the exact moment to anything that wants it. */}
                    <time
                      datetime={new Date(item.lastMessageAt).toISOString()}
                      class="font-body text-text-muted ml-auto text-[0.72rem]"
                    >
                      {shortDate(item.lastMessageAt)}
                    </time>
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
