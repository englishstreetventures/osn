import Card, { CardCtaButton, CardEyebrow } from "@cire/ui/card";
import { useAuth } from "@shared/rp-auth/solid";
import { type Accessor, createSignal, For, Show } from "solid-js";

import {
  describeChangeKinds,
  formatChangeTime,
  type RsvpChanges,
  setRsvpDigest,
} from "../lib/rsvp-changes";

/**
 * The Overview's "RSVP changes since your last visit" card.
 *
 * Counts the households that changed a reply since this organiser last opened
 * the RSVP table, names the latest few, and links to the table — opening it is
 * what marks them seen, not reading this card. Past 500 changed rows the table
 * badges the oldest first, so the count can outlast one visit to the table. The Overview starts the read
 * beside its own (`createRsvpChangesResource`), and a failed read renders
 * nothing, leaving the rest of the Overview alone.
 *
 * The daily email switch shows only when the API says this organiser is sent
 * one (the owner and editors). It is theirs alone: each co-host sets their own.
 */
export default function RsvpChangesCard(props: {
  weddingId: string;
  changes: Accessor<RsvpChanges | null | undefined>;
  setChanges: (next: RsvpChanges) => void;
  onNavigate: (module: "guests", sub: string) => void;
}) {
  const { authFetch } = useAuth();
  const changes = () => props.changes();
  const mutate = (next: RsvpChanges) => props.setChanges(next);
  const [saving, setSaving] = createSignal(false);
  const [saveFailed, setSaveFailed] = createSignal(false);

  const toggleDigest = async (enabled: boolean) => {
    const current = changes();
    if (!current || saving()) return;
    setSaving(true);
    setSaveFailed(false);
    mutate({ ...current, digest: { ...current.digest, enabled } });
    const saved = await setRsvpDigest(authFetch, props.weddingId, enabled);
    if (!saved) {
      mutate({ ...current, digest: { ...current.digest, enabled: !enabled } });
      setSaveFailed(true);
    }
    setSaving(false);
  };

  return (
    <Show when={changes()}>
      {(feed) => (
        <Card>
          <CardEyebrow>RSVP changes since your last visit</CardEyebrow>
          <Show
            when={feed().households > 0}
            fallback={
              <p class="font-body text-text-muted text-ui-sm">Nothing new since your last visit.</p>
            }
          >
            <p class="text-text text-ui-base">
              <span class="text-gold text-ui-lg font-semibold tabular-nums">
                {feed().truncated ? `${feed().households}+` : feed().households}
              </span>{" "}
              {feed().households === 1
                ? "household changed their RSVP"
                : "households changed their RSVPs"}
            </p>
            <ul class="font-body text-text-muted text-ui-sm flex flex-col gap-1">
              <For each={feed().items}>
                {(item) => (
                  <li class="flex flex-wrap items-baseline gap-x-1.5">
                    <span class="text-text min-w-0 wrap-break-word">{item.familyName}</span>
                    <span>{describeChangeKinds(item.kinds)}</span>
                    <span class="text-text-muted/70 text-ui-xs">· {formatChangeTime(item.at)}</span>
                  </li>
                )}
              </For>
            </ul>
            <CardCtaButton onClick={() => props.onNavigate("guests", "rsvps")}>
              See the RSVP table
            </CardCtaButton>
          </Show>
          <Show when={feed().digest.available}>
            <label class="font-body text-text-muted text-ui-sm border-border/40 flex items-center gap-2 border-t pt-3">
              <input
                type="checkbox"
                class="accent-gold h-4 w-4 shrink-0 cursor-pointer"
                checked={feed().digest.enabled}
                disabled={saving()}
                onChange={(e) => void toggleDigest(e.currentTarget.checked)}
              />
              Email me a daily summary
            </label>
            <Show when={saveFailed()}>
              <p role="alert" class="text-error text-ui-xs">
                Could not save that. Please try again.
              </p>
            </Show>
          </Show>
        </Card>
      )}
    </Show>
  );
}
