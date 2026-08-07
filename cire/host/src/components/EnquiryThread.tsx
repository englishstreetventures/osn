import { createSignal, For, Show } from "solid-js";
import { toast } from "solid-toast";

import type { EnquiryListItem, EnquiryMessage } from "../lib/enquiries-store";
import { haptic } from "../lib/haptics";
// ENQ-P-W3: shared, memoised formatters — see `lib/money.ts`.
import { formatMinor } from "../lib/money";
import { categoryLabel } from "../lib/service-categories";
import Button from "./ui/Button";
import Field, { Textarea } from "./ui/Field";
import Notice from "./ui/Notice";

interface EnquiryThreadProps {
  enquiry: EnquiryListItem;
  messages: EnquiryMessage[];
  loading: boolean;
  error: string | null;
  ownProfileId: string;
  currency: string;
  canEdit: boolean;
  onBack: () => void;
  onSend: (message: string) => Promise<void>;
  onAddToBudget: () => Promise<void>;
}

/** The thread's quote line shows whole units — no cents. */
const fmtMinor = (minor: number, currency: string): string =>
  formatMinor(minor, currency, { wholeUnits: true });

export default function EnquiryThread(props: EnquiryThreadProps) {
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);

  const handleSend = () => {
    const text = draft().trim();
    if (!text || sending()) return;
    setSending(true);
    props
      .onSend(text)
      .then(() => {
        setDraft("");
        haptic("commit");
      })
      .catch(() => {
        haptic("reject");
        toast.error("Couldn't send your message. Please try again.");
      })
      .finally(() => {
        setSending(false);
      });
  };

  return (
    <div class="flex flex-col gap-4">
      {/* Back + header */}
      <div class="flex items-center gap-3">
        <button
          type="button"
          onClick={props.onBack}
          class="text-gold-dim hover:text-gold text-[0.82rem] underline-offset-2 hover:underline"
          aria-label="Back"
        >
          ← Back
        </button>
        <div class="flex flex-1 flex-wrap items-center gap-2">
          <span class="text-text text-[0.95rem] font-medium">{props.enquiry.vendorName}</span>
          <span class="bg-surface/60 text-text-muted rounded-full px-2 py-0.5 text-[0.72rem]">
            {categoryLabel(props.enquiry.category)}
          </span>
        </div>
      </div>

      {/* Non-E2E notice. `info`, and no `alert`: it is standing house-keeping
          about the channel, not a response to anything the host just did. */}
      <Notice tone="info">
        Enquiries aren't end-to-end encrypted. cire can read these messages to keep the marketplace
        safe — please don't share passwords or card details.
      </Notice>

      {/* Quote card */}
      <Show when={props.enquiry.quotedMinor != null}>
        <div class="border-border bg-surface/10 flex flex-wrap items-center gap-3 rounded-sm border px-3 py-2">
          <span class="text-gold-dim font-body text-[0.68rem] tracking-[0.16em] uppercase">
            Quote
          </span>
          <span class="text-text flex-1 text-[0.9rem] font-medium">
            {fmtMinor(props.enquiry.quotedMinor!, props.currency)}
          </span>
          <Show when={props.canEdit}>
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                void props
                  .onAddToBudget()
                  .then(() => haptic("commit"))
                  .catch(() => haptic("reject"));
              }}
            >
              Add to budget
            </Button>
          </Show>
        </div>
      </Show>

      {/* Message list */}
      <div class="flex flex-col gap-2">
        <Show when={props.loading}>
          <p class="text-text-muted text-[0.85rem] italic">Loading messages…</p>
        </Show>
        <Show when={props.error}>
          <Notice tone="error" alert>
            {props.error}
          </Notice>
        </Show>
        <For each={props.messages}>
          {(m) => {
            const isMine = m.senderProfileId === props.ownProfileId;
            return (
              <div
                data-mine={String(isMine)}
                class={`max-w-[75%] rounded-sm px-3 py-2 text-[0.88rem] ${
                  isMine ? "bg-gold/20 text-text self-end" : "bg-surface/30 text-text self-start"
                }`}
              >
                {m.body}
              </div>
            );
          }}
        </For>
      </div>

      {/* Send box (hidden when !canEdit) */}
      <Show when={props.canEdit}>
        <div class="flex items-end gap-2">
          {/* The label is hidden, not absent: the box sits under a thread whose
              heading already says whose it is, but a screen reader still needs
              the control named. */}
          <Field label="Reply" labelHidden class="flex-1">
            {(field) => (
              <Textarea
                {...field}
                placeholder="Write a reply…"
                value={draft()}
                onInput={(e) => setDraft(e.currentTarget.value)}
                rows={3}
              />
            )}
          </Field>
          <Button
            variant="primary"
            onClick={handleSend}
            disabled={sending() || draft().trim() === ""}
          >
            Send
          </Button>
        </div>
      </Show>
    </div>
  );
}
