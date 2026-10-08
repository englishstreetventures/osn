import Button from "@cire/ui/button";
import { useAuth } from "@shared/rp-auth/solid";
import { Field } from "@shared/ui/ui/field";
import { Input } from "@shared/ui/ui/input";
import { Modal } from "@shared/ui/ui/modal";
import { createSignal, Show } from "solid-js";

import { isAuthExpired, redirectToLogin } from "../lib/api";
import type { PaidTier } from "../lib/tiers";
import { redeemUnlockCode } from "../lib/unlock-code";

/**
 * "Have a code?": an owner types an unlock code and the wedding moves to the
 * tier it names, with no payment.
 *
 * A link that opens a small dialog, so it can sit under anything that offers
 * a tier. Rendered only for an owner; the API refuses everyone else
 * regardless, and words every refusal (`lib/unlock-code.ts`).
 */
export default function UnlockCodeDialog(props: {
  weddingId: string;
  /** The code was accepted and the wedding is on `tier` now. */
  onRedeemed: (tier: PaidTier) => void;
}) {
  const { authFetch } = useAuth();
  const [open, setOpen] = createSignal(false);
  const [code, setCode] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const typed = () => code().trim().length > 0;
  const errors = () => {
    const message = error();
    return message ? [message] : undefined;
  };

  function close() {
    if (busy()) return;
    setOpen(false);
    setCode("");
    setError(null);
  }

  async function submit() {
    if (!typed() || busy()) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await redeemUnlockCode(authFetch, props.weddingId, code());
      if (outcome.ok) {
        setOpen(false);
        setCode("");
        props.onRedeemed(outcome.tier);
        return;
      }
      setError(outcome.message);
    } catch (err) {
      if (isAuthExpired(err)) {
        redirectToLogin();
        return;
      }
      setError("Could not check the code. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button variant="link" type="button" class="self-start" onClick={() => setOpen(true)}>
        Have a code?
      </Button>

      <Modal open={open()} onClose={close} label="Use a code" class="w-full max-w-md">
        <form
          class="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <p class="font-display text-text text-ui-md font-light">Have a code?</p>
          <p class="font-body text-text-muted text-ui-sm leading-relaxed">
            If someone gave you a code for Gold or Crimson, enter it here. It moves this wedding to
            that plan, with nothing to pay.
          </p>
          <Field label="Code" errors={errors()}>
            {(field) => (
              <Input
                {...field}
                name="unlockCode"
                value={code()}
                autocomplete="off"
                autocapitalize="off"
                spellcheck={false}
                maxLength={64}
                placeholder="xxxx-xxxx-xxxx-xxxx"
                onInput={(e) => {
                  setCode(e.currentTarget.value);
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
            <Button variant="primary" type="submit" disabled={!typed() || busy()}>
              <Show when={busy()} fallback="Use code">
                Checking…
              </Show>
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
