import { useAuth } from "@osn/client/solid";
import { createResource, createSignal, For, Show } from "solid-js";
import { toast } from "solid-toast";

import {
  friendlyEnquiryError,
  getEnquiryMessages,
  replyToEnquiry,
  submitQuote,
} from "../lib/enquiries-store";

// ── Tailwind class constants (mirrors ListingEditor idiom) ─────────────────
const labelClass = "font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase";
const inputClass =
  "border-border bg-bg font-body text-text focus:border-gold rounded-sm border px-3 py-2 text-[0.95rem] transition-colors outline-none placeholder:opacity-40 disabled:opacity-40 w-full";

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

  const sendDisabled = () => sending() || draft().trim() === "";

  async function handleSend() {
    if (sendDisabled()) return;
    const text = draft().trim();
    setSending(true);
    try {
      await replyToEnquiry(authFetch, props.enquiryId, text);
      setDraft("");
      void refetch();
    } catch (err) {
      toast.error(friendlyEnquiryError(err));
    } finally {
      setSending(false);
    }
  }

  // ── Quote form state ──────────────────────────────────────────────────────
  const [quoteAmount, setQuoteAmount] = createSignal("");
  const [quoteNote, setQuoteNote] = createSignal("");
  const [quoting, setQuoting] = createSignal(false);

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
    try {
      await submitQuote(authFetch, props.enquiryId, minor, note);
      toast.success("Quote sent");
      props.onQuoted?.();
      setQuoteAmount("");
      void refetch();
    } catch (err) {
      toast.error(friendlyEnquiryError(err));
    } finally {
      setQuoting(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div class="border-border bg-surface/30 flex flex-col gap-6 rounded-sm border p-6">
      {/* Back button */}
      <button
        type="button"
        onClick={() => props.onBack()}
        class="text-text-muted hover:text-gold font-body self-start text-[0.78rem] uppercase"
      >
        ← Back to enquiries
      </button>

      {/* Non-E2E notice */}
      <p class="border-border bg-surface/40 text-text-muted rounded-sm border px-4 py-2.5 text-[0.8rem]">
        Enquiries aren't end-to-end encrypted. cire can read these messages to keep the marketplace
        safe — please don't share passwords or card details.
      </p>

      {/* ── Messages ─────────────────────────────────────────────────────── */}
      <Show when={messages.loading}>
        <p
          role="status"
          class="font-body text-text-muted animate-pulse text-[0.88rem] tracking-[0.1em] uppercase"
        >
          Loading messages…
        </p>
      </Show>

      <Show when={messages.error}>
        <p
          role="alert"
          class="border-error/20 bg-error/5 text-error rounded-sm border p-4 text-[0.88rem]"
        >
          Could not load messages. Please refresh.
        </p>
      </Show>

      <Show when={!messages.loading && !messages.error}>
        <Show
          when={(messages()?.length ?? 0) === 0}
          fallback={
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
                            ? "bg-gold/20 text-text"
                            : "border-border bg-surface/50 text-text border"
                        }`}
                      >
                        {m.body}
                        <p class="text-text-muted mt-1 text-[0.68rem]">
                          {new Date(m.createdAt).toLocaleTimeString(undefined, {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </p>
                      </div>
                    </div>
                  );
                }}
              </For>
            </div>
          }
        >
          <p class="text-text-muted font-body text-[0.9rem]">No messages yet.</p>
        </Show>
      </Show>

      {/* ── Reply box ────────────────────────────────────────────────────── */}
      <div class="flex flex-col gap-2">
        <textarea
          rows={3}
          placeholder="Write a reply…"
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          class={`${inputClass} resize-y`}
          disabled={sending()}
        />
        <button
          type="button"
          onClick={() => void handleSend()}
          disabled={sendDisabled()}
          class="border-gold bg-gold font-body text-bg hover:bg-gold-dim self-end rounded-sm border px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
        >
          {sending() ? "Sending…" : "Send"}
        </button>
      </div>

      {/* ── Quote form ───────────────────────────────────────────────────── */}
      <div class="border-border flex flex-col gap-4 rounded-sm border p-4">
        <p class="text-gold-dim font-body text-[0.68rem] tracking-[0.16em] uppercase">
          Send a quote
        </p>

        {/* Amount input */}
        <label class="flex flex-col gap-1.5" for="quote-amount">
          <span class={labelClass}>Quote amount</span>
          <div class="flex items-center gap-2">
            <span class="text-text-muted font-body text-[0.95rem]">$</span>
            <input
              id="quote-amount"
              type="number"
              min="0.01"
              step="0.01"
              placeholder="0.00"
              value={quoteAmount()}
              onInput={(e) => setQuoteAmount(e.currentTarget.value)}
              disabled={quoting()}
              class={`${inputClass} max-w-[12rem]`}
            />
          </div>
          <Show when={parsedAmount() !== null}>
            <p class="text-text-muted font-body text-[0.75rem]">{aud.format(parsedAmount()!)}</p>
          </Show>
        </label>

        {/* Optional note */}
        <label class="flex flex-col gap-1.5" for="quote-note">
          <span class={labelClass}>Note (optional)</span>
          <input
            id="quote-note"
            type="text"
            placeholder="Add a note (optional)"
            value={quoteNote()}
            onInput={(e) => setQuoteNote(e.currentTarget.value)}
            disabled={quoting()}
            class={inputClass}
          />
        </label>

        <button
          type="button"
          onClick={() => void handleQuote()}
          disabled={quoteDisabled()}
          class="border-gold bg-gold font-body text-bg hover:bg-gold-dim self-start rounded-sm border px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
        >
          {quoting() ? "Sending quote…" : "Send quote"}
        </button>
      </div>
    </div>
  );
}
