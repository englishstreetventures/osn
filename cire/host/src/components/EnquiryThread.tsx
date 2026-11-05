import Button from "@cire/ui/button";
import Eyebrow from "@cire/ui/eyebrow";
import MessageThread, { type MessageThreadItem } from "@cire/ui/message-thread";
import { toast } from "@shared/toast";
import { Chip } from "@shared/ui/ui/chip";
import { Notice } from "@shared/ui/ui/notice";
import { Show } from "solid-js";

import type { EnquiryListItem, EnquiryMessage } from "../lib/enquiries-store";
// Shared, memoised formatters — see `lib/money.ts`.
import { formatMinor } from "../lib/money";
import { categoryLabel } from "../lib/service-categories";
import { haptic } from "../lib/touch-feedback";

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
  const messages = () =>
    props.messages.map((m): MessageThreadItem => ({
      id: m.id,
      from: m.senderProfileId === props.ownProfileId ? "me" : "them",
      body: m.body,
      sentAt: m.createdAt,
      // The API's stand-in for the couple's first message, held until the
      // vendor has an account to receive it.
      undelivered: m.id === "pending",
    }));

  /** Rejects on failure, so the reply box keeps the words. */
  async function send(text: string) {
    try {
      await props.onSend(text);
    } catch (err) {
      haptic("reject");
      toast.error("Couldn't send your message. Please try again.");
      throw err;
    }
    haptic("commit");
  }

  return (
    <div class="flex flex-col gap-4">
      {/* Back + header */}
      <div class="flex items-center gap-3">
        <Button variant="link" type="button" onClick={props.onBack} aria-label="Back">
          ← Back
        </Button>
        <div class="flex flex-1 flex-wrap items-center gap-2">
          <span class="text-text text-ui-base font-medium">{props.enquiry.vendorName}</span>
          <Chip treatment="tag">{categoryLabel(props.enquiry.category)}</Chip>
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
          <Eyebrow as="span" tone="muted">
            Quote
          </Eyebrow>
          <span class="text-text text-ui-base flex-1 font-medium">
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

      <MessageThread
        messages={messages()}
        loading={props.loading}
        error={props.error}
        emptyHint="Your message will start the thread."
        reply={props.canEdit ? { onSend: send } : undefined}
      />
    </div>
  );
}
