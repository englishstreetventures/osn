import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import { createSignal, Show } from "solid-js";
import { Portal } from "solid-js/web";

import { redirectToLogin } from "../lib/api";
import { enquiryErrorMessage, EnquiryApiError, openEnquiry } from "../lib/enquiries-api";
import { type EnquiryListItem, upsertCachedEnquiry } from "../lib/enquiries-store";
import { haptic } from "../lib/haptics";

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

  /** Close without sending. Every path that abandons the dialog — the scrim,
   *  the Cancel button — goes through here, so the "nothing happened" buzz is
   *  written once. The send path closes without it: a successful send already
   *  confirmed itself, and two buzzes in a row would read as two events. */
  const dismiss = () => {
    haptic("dismiss");
    props.onClose();
  };

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
      // Sent. The dialog is about to vanish and the toast sits at the edge of
      // vision, so the buzz is what tells the host the message actually left.
      haptic("commit");
      toast.success("Enquiry sent");
      props.onSent?.(item);
      setMessage("");
      props.onClose();
    } catch (err) {
      if (err instanceof EnquiryApiError && err.status === 401) {
        redirectToLogin();
      } else {
        // The dialog stays open with the message still in it — buzz so the
        // host doesn't read the unchanged dialog as "nothing happened yet".
        haptic("reject");
        toast.error(enquiryErrorMessage(err));
      }
    } finally {
      setSending(false);
    }
  };

  return (
    <Show when={props.open}>
      {/* Portalled to document.body: the dashboard shell sets `container-type`
          on its layout boxes, which brings `contain: layout` with it and makes
          them the containing block for `position: fixed` descendants. */}
      <Portal>
        <div
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={(e) => {
            if (e.target === e.currentTarget) dismiss();
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
              <h3 class="font-display text-text text-[1.2rem] font-light">
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
                onClick={dismiss}
                class="text-text-muted hover:text-text text-[0.78rem]"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </Portal>
    </Show>
  );
}
