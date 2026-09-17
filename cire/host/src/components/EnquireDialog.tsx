import Button from "@cire/ui/button";
import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import { Field } from "@shared/ui/ui/field";
import { Modal } from "@shared/ui/ui/modal";
import { Textarea } from "@shared/ui/ui/textarea";
import { createSignal, createUniqueId } from "solid-js";

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

  const titleId = createUniqueId();

  return (
    // Was a `fixed inset-0 z-50` scrim in a `<Portal>`, portalled because the
    // dashboard shell sets `container-type` on its layout boxes — which brings
    // `contain: layout` and makes them the containing block for `position:
    // fixed` descendants. The top layer is outside every stacking context, so
    // there is nothing left to escape and nothing to portal past.
    <Modal
      open={props.open}
      onClose={dismiss}
      labelledBy={titleId}
      class="flex w-full max-w-lg flex-col gap-4"
    >
      <header class="flex flex-col gap-1">
        <p class="font-body text-gold text-ui-xs tracking-ui-widest uppercase">Enquiry</p>
        <h3 id={titleId} class="font-display text-text text-ui-lg font-light">
          Enquire with {props.vendorName}
        </h3>
      </header>

      <Field label="Your message">
        {(field) => (
          <Textarea
            {...field}
            value={message()}
            onInput={(e) => setMessage(e.currentTarget.value)}
            placeholder="Introduce yourselves and ask your question…"
            rows={5}
          />
        )}
      </Field>

      <div class="flex items-center gap-3">
        <Button
          variant="primary"
          size="sm"
          disabled={sending() || message().trim() === ""}
          onClick={() => void handleSend()}
        >
          {sending() ? "Sending…" : "Send"}
        </Button>
        <Button variant="bare" type="button" onClick={dismiss}>
          Cancel
        </Button>
      </div>
    </Modal>
  );
}
