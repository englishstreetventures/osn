import Button from "@cire/ui/button";
import { useAuth } from "@shared/rp-auth/solid";
import { Field } from "@shared/ui/ui/field";
import { Input } from "@shared/ui/ui/input";
import { Modal } from "@shared/ui/ui/modal";
import { createSignal, Show } from "solid-js";

import { isAuthExpired, redirectToLogin } from "../lib/api";
import { deleteWedding } from "../lib/wedding-lifecycle";

/**
 * The danger zone at the foot of Settings: an owner deletes the wedding.
 *
 * One owner's confirmation is enough — every owner holds every owner power —
 * so the confirmation is typing the wedding's link name, the one thing that
 * names this wedding and no other. The delete is soft: guests lose the invite
 * at once, and any owner can restore it from the wedding list for 7 days.
 * Rendered only for an owner; the API refuses everyone else regardless.
 */
export default function DeleteWeddingDialog(props: {
  weddingId: string;
  /** The wedding's slug — what the owner must type. */
  slug: string;
  /** The delete went through; the wedding can be restored until `restoreUntil` (ISO). */
  onDeleted: (restoreUntil: string) => void;
}) {
  const { authFetch } = useAuth();
  const [open, setOpen] = createSignal(false);
  const [typed, setTyped] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const confirmed = () => typed() === props.slug && props.slug.length > 0;
  const errors = () => {
    const message = error();
    return message ? [message] : undefined;
  };

  function close() {
    if (busy()) return;
    setOpen(false);
    setTyped("");
    setError(null);
  }

  async function confirm() {
    if (!confirmed() || busy()) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await deleteWedding(authFetch, props.weddingId, typed());
      if (outcome.ok) {
        setOpen(false);
        props.onDeleted(outcome.restoreUntil);
        return;
      }
      setError(outcome.message);
    } catch (err) {
      if (isAuthExpired(err)) {
        redirectToLogin();
        return;
      }
      setError("Could not delete the wedding. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section
      aria-labelledby="danger-zone-title"
      class="border-ui-danger/30 flex flex-col gap-3 rounded-sm border p-5"
    >
      <h3 id="danger-zone-title" class="font-display text-text text-ui-md font-light">
        Delete this wedding
      </h3>
      <p class="font-body text-text-muted text-ui-sm leading-relaxed">
        Guests lose the invite straight away. You or any other owner can restore it from your
        wedding list for 7 days; after that it is deleted for good, with its guests, replies and
        gifts.
      </p>
      <Button variant="quietDanger" type="button" class="self-start" onClick={() => setOpen(true)}>
        Delete wedding…
      </Button>

      <Modal open={open()} onClose={close} label="Delete this wedding" class="w-full max-w-md">
        <form
          class="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void confirm();
          }}
        >
          <p class="font-display text-text text-ui-md font-light">Delete this wedding?</p>
          <ul class="font-body text-text-muted text-ui-sm flex list-disc flex-col gap-1 pl-5 leading-relaxed">
            <li>Every guest&apos;s invite link and code stop working at once.</li>
            <li>
              You or any other owner can restore it from your wedding list for 7 days, exactly as it
              was. After that it is deleted for good.
            </li>
            <li>
              Want a copy? Download the guest list and gift log from the Guests and Registry tabs
              first.
            </li>
            <li>
              A Stripe account you connected for cash gifts stays with Stripe. Close it from your
              Stripe Express dashboard if you no longer need it.
            </li>
          </ul>
          <Field
            label={
              <>
                Type <span class="normal-case">{props.slug}</span> to confirm
              </>
            }
            errors={errors()}
          >
            {(field) => (
              <Input
                {...field}
                value={typed()}
                autocomplete="off"
                spellcheck={false}
                onInput={(e) => {
                  setTyped(e.currentTarget.value);
                  setError(null);
                }}
                disabled={busy()}
              />
            )}
          </Field>
          <div class="flex flex-wrap justify-end gap-2">
            <Button variant="quiet" type="button" onClick={close} disabled={busy()}>
              Cancel
            </Button>
            <Button variant="danger" type="submit" disabled={!confirmed() || busy()}>
              <Show when={busy()} fallback="Delete wedding">
                Deleting…
              </Show>
            </Button>
          </div>
        </form>
      </Modal>
    </section>
  );
}
