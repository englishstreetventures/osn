import Button from "@cire/ui/button";
import Card, { cardBoxClass } from "@cire/ui/card";
import Eyebrow from "@cire/ui/eyebrow";
import MessageThread, { type MessageThreadItem } from "@cire/ui/message-thread";
import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import { Field } from "@shared/ui/ui/field";
import { Input } from "@shared/ui/ui/input";
import { Notice } from "@shared/ui/ui/notice";
import { createResource, createSignal } from "solid-js";

import {
  friendlyEnquiryError,
  getEnquiryMessages,
  replyToEnquiry,
  submitQuote,
  type VendorEnquiryMessage,
} from "../lib/enquiries-store";
import { haptic } from "../lib/touch-feedback";

/**
 * The quote form, a box inside the thread's card: the card's border and the
 * small corner a nested box takes (host DESIGN.md §4), no fill of its own.
 */
const QUOTE_FORM_CLASS = `${cardBoxClass({ fill: "none", nested: true })} flex flex-col gap-4 p-4`;

// AUD formatter — acceptable for v1; wedding currency context not available in vendor app.
const aud = new Intl.NumberFormat(undefined, { style: "currency", currency: "AUD" });

interface VendorEnquiryThreadProps {
  enquiryId: string;
  ownProfileId: string;
  onBack: () => void;
  onQuoted?: () => void;
}

export default function VendorEnquiryThread(props: VendorEnquiryThreadProps) {
  const { authFetch } = useAuth();

  // ── Messages resource ─────────────────────────────────────────────────────
  const [messages, { mutate, refetch }] = createResource(() =>
    getEnquiryMessages(authFetch, props.enquiryId),
  );

  // `latest`, and only once there is a value: reading the resource while it
  // loads would suspend the view around the card, and reading it once it has
  // failed would throw.
  const thread = () =>
    (messages.state === "ready" || messages.state === "refreshing"
      ? (messages.latest ?? [])
      : []
    ).map((m): MessageThreadItem => ({
      id: m.id,
      from: m.senderProfileId === props.ownProfileId ? "me" : "them",
      body: m.body,
      sentAt: m.createdAt,
      undelivered: m.id === "pending",
    }));

  // ── Reply ─────────────────────────────────────────────────────────────────
  const [replyError, setReplyError] = createSignal<string | null>(null);

  /** Rejects on failure, so the reply box keeps the words. */
  async function send(text: string) {
    setReplyError(null);
    let sent: VendorEnquiryMessage;
    try {
      sent = await replyToEnquiry(authFetch, props.enquiryId, text);
    } catch (err) {
      haptic("reject");
      const message = friendlyEnquiryError(err);
      setReplyError(message);
      toast.error(message);
      throw err;
    }
    haptic("commit");
    // Put the sent message into the thread rather than reading the whole
    // thread back to learn one row the server has just returned. First,
    // because the API lists a thread newest first. A thread not yet read has
    // no list to add it to, and its read may have gone out before the reply,
    // so it is read again.
    if (messages.state === "ready") mutate((list) => [sent, ...(list ?? [])]);
    else void refetch();
  }

  // ── Quote form state ──────────────────────────────────────────────────────
  const [quoteAmount, setQuoteAmount] = createSignal("");
  const [quoteNote, setQuoteNote] = createSignal("");
  const [quoting, setQuoting] = createSignal(false);
  const [quoteError, setQuoteError] = createSignal<string | null>(null);

  // Parse amount as a major-unit number; valid iff it's finite and > 0.
  const parsedAmount = () => {
    const n = Number(quoteAmount());
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  const quoteDisabled = () => quoting() || parsedAmount() === null;

  async function handleQuote() {
    if (quoteDisabled()) return;
    const major = parsedAmount()!;
    const minor = Math.round(major * 100);
    const note = quoteNote().trim() || undefined;
    setQuoting(true);
    setQuoteError(null);
    try {
      await submitQuote(authFetch, props.enquiryId, minor, note);
      haptic("commit");
      toast.success("Quote sent");
      props.onQuoted?.();
      setQuoteAmount("");
      void refetch();
    } catch (err) {
      haptic("reject");
      const message = friendlyEnquiryError(err);
      setQuoteError(message);
      toast.error(message);
    } finally {
      setQuoting(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <Card>
      <Button variant="quiet" size="sm" onClick={() => props.onBack()} class="self-start">
        ← Back to enquiries
      </Button>

      {/* A standing note, so `info` and no `alert`: it was on screen before the
          vendor arrived and has nothing to interrupt anyone about. */}
      <Notice tone="info">
        Enquiries aren't end-to-end encrypted. cire can read these messages to keep the marketplace
        safe — please don't share passwords or card details.
      </Notice>

      <MessageThread
        messages={thread()}
        loading={messages.loading}
        error={messages.error ? "Could not load messages. Please refresh." : null}
        emptyHint="Your reply will start the thread."
        reply={{ onSend: send, error: replyError() }}
      />

      {/* ── Quote form ───────────────────────────────────────────────────── */}
      <div class={QUOTE_FORM_CLASS}>
        <Eyebrow>Send a quote</Eyebrow>

        {/*
          The formatted amount is the field's `hint`, not a line inside its
          `<label>`. Inside the label it became part of the input's accessible
          *name*, so the box announced itself as "Quote amount $1,200.00" — and
          re-announced the whole thing on every keystroke.

          The `$` is decoration for the same reason: `type="number"` already
          means the box holds a number, and the currency is stated in full
          underneath the moment there is anything to state it about.
        */}
        <Field
          label="Quote amount"
          hint={parsedAmount() !== null ? aud.format(parsedAmount()!) : undefined}
          errors={quoteError() ? [quoteError()!] : undefined}
        >
          {(field) => (
            <div class="flex items-center gap-2">
              <span aria-hidden="true" class="font-body text-text-muted text-ui-base">
                $
              </span>
              <Input
                size="form"
                {...field}
                type="number"
                min="0.01"
                step="0.01"
                placeholder="0.00"
                value={quoteAmount()}
                onInput={(e) => setQuoteAmount(e.currentTarget.value)}
                disabled={quoting()}
                class="max-w-48"
              />
            </div>
          )}
        </Field>

        <Field
          label={
            <>
              Note <span class="lowercase">(optional)</span>
            </>
          }
        >
          {(field) => (
            <Input
              size="form"
              {...field}
              placeholder="Anything the couple should know about the quote"
              value={quoteNote()}
              onInput={(e) => setQuoteNote(e.currentTarget.value)}
              disabled={quoting()}
            />
          )}
        </Field>

        <Button
          variant="primary"
          onClick={() => void handleQuote()}
          disabled={quoteDisabled()}
          class="self-start"
        >
          {quoting() ? "Sending quote…" : "Send quote"}
        </Button>
      </div>
    </Card>
  );
}
