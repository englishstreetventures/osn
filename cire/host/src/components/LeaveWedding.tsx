import Button from "@cire/ui/button";
import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import { Modal } from "@shared/ui/ui/modal";
import { createSignal } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin, weddingPath } from "../lib/api";
import { haptic } from "../lib/haptics";

interface LeaveWeddingProps {
  weddingId: string;
  /** Called once the caller has left, after the confirmation toast. The
   *  parent drops the wedding from the organiser's list, which unmounts this
   *  control and releases the wedding's cached rows. */
  onLeft?: () => void;
}

/**
 * "Leave this wedding": a button, a confirm dialog, and `DELETE /hosts/me`.
 * Offered to every seat holder — the co-host panel shows it to editors and
 * viewers, the run-sheet screen to helpers — and never to the owner, whom the
 * API refuses (409): the owner has no seat to leave.
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
        toast.error(
          res.status === 409
            ? "You own this wedding, so you can't leave it."
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
        <p class="font-body text-text-muted text-ui-sm max-w-prose leading-relaxed">
          Give up your seat. The wedding leaves your list and any emails about it stop. The owner or
          an editor can add you back.
        </p>
        <Button
          class="self-start"
          variant="danger"
          size="sm"
          type="button"
          onClick={() => setConfirming(true)}
        >
          Leave this wedding
        </Button>
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
          <p class="font-body text-text-muted text-ui-sm leading-relaxed">
            You lose access to it straight away. To come back, ask the owner or an editor to add you
            again.
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
