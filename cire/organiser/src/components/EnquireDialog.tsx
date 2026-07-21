import { useAuth } from "@osn/client/solid";
import { createSignal, Show } from "solid-js";
import { toast } from "solid-toast";

import { redirectToLogin } from "../lib/api";
import { enquiryErrorMessage, EnquiryApiError, openEnquiry } from "../lib/enquiries-api";
import { type EnquiryListItem, upsertCachedEnquiry } from "../lib/enquiries-store";

export interface EnquireDialogProps {
  open: boolean;
  weddingId: string;
  directoryVendorId: string;
  category: string;
  vendorName: string;
  onClose: () => void;
  onSent?: (item: EnquiryListItem) => void;
}

export default function EnquireDialog(props: EnquireDialogProps) {
  const { authFetch } = useAuth();
  const [message, setMessage] = createSignal("");
  const [sending, setSending] = createSignal(false);

  const handleSend = async () => {
    const text = message().trim();
    if (!text || sending()) return;
    setSending(true);
    try {
      const item = await openEnquiry(authFetch, props.weddingId, {
        directoryVendorId: props.directoryVendorId,
        category: props.category,
        message: text,
        vendorName: props.vendorName,
      });
      upsertCachedEnquiry(props.weddingId, item);
      toast.success("Enquiry sent");
      props.onSent?.(item);
      setMessage("");
      props.onClose();
    } catch (err) {
      if (err instanceof EnquiryApiError && err.status === 401) {
        redirectToLogin();
      } else {
        toast.error(enquiryErrorMessage(err));
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
        onClick={(e) => {
          if (e.target === e.currentTarget) props.onClose();
        }}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Enquire with ${props.vendorName}`}
          class="border-border bg-bg flex w-full max-w-lg flex-col gap-4 rounded-sm border p-6"
        >
          <header class="flex flex-col gap-1">
            <p class="font-body text-gold text-[0.72rem] tracking-[0.2em] uppercase">Enquiry</p>
            <h3 class="font-display text-text text-[1.2rem] font-light italic">
              Enquire with {props.vendorName}
            </h3>
          </header>

          <label class="flex flex-col gap-1.5">
            <span class="text-gold-dim font-body text-[0.64rem] tracking-[0.14em] uppercase">
              Your message
            </span>
            <textarea
              value={message()}
              onInput={(e) => setMessage(e.currentTarget.value)}
              placeholder="Introduce yourselves and ask your question…"
              rows={5}
              class="border-border bg-bg text-text w-full rounded-sm border px-3 py-2 text-[0.85rem] focus:outline-none"
            />
          </label>

          <div class="flex items-center gap-3">
            <button
              type="button"
              disabled={sending() || message().trim() === ""}
              onClick={() => void handleSend()}
              class="bg-gold text-bg rounded-sm px-4 py-1.5 text-[0.78rem] tracking-[0.08em] uppercase disabled:opacity-60"
            >
              {sending() ? "Sending…" : "Send"}
            </button>
            <button
              type="button"
              onClick={props.onClose}
              class="text-text-muted hover:text-text text-[0.78rem]"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}
