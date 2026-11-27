import Button from "@cire/ui/button";
import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import { Modal } from "@shared/ui/ui/modal";
import { createSignal, Show } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin, weddingPath } from "../lib/api";
import type { InAppLink } from "../lib/link-click";
import { haptic } from "../lib/touch-feedback";
import PayoutHolderNote, { payoutHolderSentence } from "./PayoutHolderNote";

/** The id of the note under the button when the caller holds the payout account. */
const HOLDER_NOTE_ID = "leave-payout-holder-note";

interface LeaveWeddingProps {
  weddingId: string;
  /** Called once the caller has left, after the confirmation toast. The
   *  parent drops the wedding from the organiser's list, which unmounts this
   *  control and releases the wedding's cached rows. */
  onLeft?: () => void;
  /** The list's read says the caller holds the wedding's payout account, so
   *  the API will refuse their leave until it is handed over: a note under the
   *  button says why. The button still asks and sends, since the read can be
   *  stale; the API's refusal decides. */
  payoutHolder?: boolean;
  /** Money gifts, where the account is handed over, when the reader can open it. */
  moneyGifts?: InAppLink;
  /** The API refused the leave for the payout account: the caller's seat is
   *  marked, so the page says why from now on. */
  onHoldsPayoutAccount?: () => void;
}

/**
 * "Leave this wedding": a button, a confirm dialog, and `DELETE /hosts/me`.
 * Offered to every seat holder — the co-host panel shows it to owners, editors
 * and viewers, the run-sheet screen to helpers. An owner may leave while
 * another owner remains; the API refuses the last one (409 `last_owner`), and
 * an owner holding the wedding's Stripe account (409 `holds_payout_account`),
 * and each message says what would let them go.
 */
export default function LeaveWedding(props: LeaveWeddingProps) {
  const { authFetch } = useAuth();
  const [confirming, setConfirming] = createSignal(false);
  const [leaving, setLeaving] = createSignal(false);

  /**
   * Delete the caller's own seat. A 403 means the seat is already gone (the
   * owner removed it, or another tab left first). That 403 has already made
   * the dashboard ask the API for the organiser's weddings (`watchForbidden`),
   * and the answer drops this one, so `onLeft` is not called: a local drop
   * would throw that answer away and ask a second time.
   */
  async function leave() {
    setLeaving(true);
    try {
      const res = await authFetch(apiUrl(weddingPath(props.weddingId, "/hosts/me")), {
        method: "DELETE",
      });
      if (res.status === 401) return redirectToLogin();
      if (res.status === 403) {
        setConfirming(false);
        toast.success("You're no longer a host of this wedding.");
        return;
      }
      if (!res.ok) {
        haptic("reject");
        const error =
          res.status === 409
            ? ((await res.json().catch(() => null)) as { error?: unknown } | null)?.error
            : null;
        if (error === "holds_payout_account") {
          // The caller holds the account: the leave cannot happen here, so the
          // dialog goes and the seat says why.
          setConfirming(false);
          toast.error(payoutHolderSentence(null));
          props.onHoldsPayoutAccount?.();
          return;
        }
        toast.error(
          error === "last_owner"
            ? "You're this wedding's only owner. Make someone else an owner first, or delete the wedding."
            : "Could not leave this wedding. Please try again.",
        );
        return;
      }
      setConfirming(false);
      haptic("commit");
      toast.success("You've left this wedding.");
      props.onLeft?.();
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      haptic("reject");
      toast.error("Could not leave this wedding. Is the API running?");
    } finally {
      setLeaving(false);
    }
  }

  return (
    <>
      <section
        aria-labelledby="leave-wedding-heading"
        class="border-border flex flex-col gap-3 border-t pt-6 text-left"
      >
        <h3 id="leave-wedding-heading" class="font-display text-text text-ui-md font-light">
          Leave this wedding
        </h3>
        <p class="font-body text-text-muted text-ui-sm leading-ui-normal max-w-prose">
          Give up your seat. The wedding leaves your list and any emails about it stop. An owner can
          add you back.
        </p>
        <Button
          class="self-start"
          variant="danger"
          size="sm"
          type="button"
          aria-describedby={props.payoutHolder ? HOLDER_NOTE_ID : undefined}
          onClick={() => setConfirming(true)}
        >
          Leave this wedding
        </Button>
        <Show when={props.payoutHolder}>
          <PayoutHolderNote
            id={HOLDER_NOTE_ID}
            testId={HOLDER_NOTE_ID}
            name={null}
            moneyGifts={props.moneyGifts}
            class="max-w-prose"
          />
        </Show>
      </section>

      <Modal
        open={confirming()}
        onClose={() => {
          if (!leaving()) setConfirming(false);
        }}
        label="Leave this wedding"
        class="w-full max-w-md"
      >
        <div class="flex flex-col gap-4">
          <p class="font-display text-text text-ui-md font-light">Leave this wedding?</p>
          <p class="font-body text-text-muted text-ui-sm leading-ui-normal">
            You lose access to it straight away. To come back, ask an owner to add you again.
          </p>
          <div class="flex flex-wrap justify-end gap-2">
            <Button
              variant="quiet"
              type="button"
              disabled={leaving()}
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              type="button"
              disabled={leaving()}
              onClick={() => void leave()}
            >
              {leaving() ? "Leaving…" : "Yes, leave"}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}
