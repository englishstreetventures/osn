import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import { createResource, createSignal, For, Show } from "solid-js";

import {
  friendlyEnquiryError,
  getEnquiryMessages,
  replyToEnquiry,
  submitQuote,
} from "../lib/enquiries-store";
import { haptic } from "../lib/haptics";
import Button from "./ui/Button";
import Card, { CardEyebrow } from "./ui/Card";
import Field, { Input, Textarea } from "./ui/Field";
import Loading from "./ui/Loading";
import Notice from "./ui/Notice";

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
  const [messages, { refetch }] = createResource(() =>
    getEnquiryMessages(authFetch, props.enquiryId),
  );

  // ── Reply box state ───────────────────────────────────────────────────────
  const [draft, setDraft] = createSignal("");
  const [sending, setSending] = createSignal(false);
  const [replyError, setReplyError] = createSignal<string | null>(null);

  const sendDisabled = () => sending() || draft().trim() === "";

  async function handleSend() {
    if (sendDisabled()) return;
    const text = draft().trim();
    setSending(true);
    setReplyError(null);
    try {
      await replyToEnquiry(authFetch, props.enquiryId, text);
      haptic("commit");
      setDraft("");
      void refetch();
    } catch (err) {
      haptic("reject");
      const message = friendlyEnquiryError(err);
      setReplyError(message);
      toast.error(message);
    } finally {
      setSending(false);
    }
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

      {/* ── Messages ─────────────────────────────────────────────────────── */}
      <Show when={messages.loading}>
        <Loading label="Loading messages…" />
      </Show>

      <Show when={messages.error}>
        <Notice tone="error" alert>
          Could not load messages. Please refresh.
        </Notice>
      </Show>

      <Show when={!messages.loading && !messages.error}>
        <Show
          when={(messages()?.length ?? 0) > 0}
          fallback={
            <p class="font-body text-text-muted text-[0.9rem]">
              No messages yet. Your reply will start the thread.
            </p>
          }
        >
          <div class="flex flex-col gap-3">
            <For each={messages()}>
              {(m) => {
                const mine = m.senderProfileId === props.ownProfileId;
                return (
                  <div
                    data-mine={String(mine)}
                    class={`flex ${mine ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      class={`font-body max-w-[75%] rounded-sm px-4 py-2.5 text-[0.9rem] ${
                        mine
                          ? "bg-brand text-on-brand"
                          : "border-border bg-surface/50 text-text border"
                      }`}
                    >
                      {/* Who said it, for anyone who cannot see which side of
                          the column the bubble is on. Alignment is the only
                          thing that carried it before. */}
                      <span class="sr-only">{mine ? "You wrote: " : "They wrote: "}</span>
                      {m.body}
                      <time
                        datetime={new Date(m.createdAt).toISOString()}
                        class="text-text-muted mt-1 block text-[0.68rem]"
                      >
                        {new Date(m.createdAt).toLocaleTimeString(undefined, {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    </div>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </Show>

      {/* ── Reply box ────────────────────────────────────────────────────── */}
      <div class="flex flex-col gap-2">
        <Field label="Reply" labelHidden errors={replyError() ? [replyError()!] : undefined}>
          {(field) => (
            <Textarea
              {...field}
              rows={3}
              placeholder="Write a reply…"
              value={draft()}
              onInput={(e) => setDraft(e.currentTarget.value)}
              disabled={sending()}
            />
          )}
        </Field>
        <Button
          variant="primary"
          onClick={() => void handleSend()}
          disabled={sendDisabled()}
          class="self-end"
        >
          {sending() ? "Sending…" : "Send"}
        </Button>
      </div>

      {/* ── Quote form ───────────────────────────────────────────────────── */}
      <div class="border-border flex flex-col gap-4 rounded-sm border p-4">
        <CardEyebrow>Send a quote</CardEyebrow>

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
              <span aria-hidden="true" class="font-body text-text-muted text-[0.95rem]">
                $
              </span>
              <Input
                {...field}
                type="number"
                min="0.01"
                step="0.01"
                placeholder="0.00"
                value={quoteAmount()}
                onInput={(e) => setQuoteAmount(e.currentTarget.value)}
                disabled={quoting()}
                class="max-w-[12rem]"
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
