import {
  describeAuthError,
  type RecoveryClient,
  type RecoveryCodesStatus,
  type StepUpClient,
  type StepUpToken,
  type TotpClient,
} from "@osn/client";
import { Button } from "@shared/ui/ui/button";
import { Card } from "@shared/ui/ui/card";
import { Checkbox } from "@shared/ui/ui/checkbox";
import { Dialog, DialogContent } from "@shared/ui/ui/dialog";
import { Notice } from "@shared/ui/ui/notice";
import { Skeleton } from "@shared/ui/ui/skeleton";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";

import { AuthHeader } from "./AuthHeader";
import { LoadFailed } from "./LoadFailed";
import { ownRead, writeEnd, type SettingsRead, type WriteEnd } from "./settings-read";
import { StepUpDialog, type RunPasskeyCeremony } from "./StepUpDialog";
import { stepAction, ViewStep } from "./ViewParts";

/**
 * Settings-panel surface for generating and displaying recovery codes
 * (Copenhagen Book M2). The codes are returned by the server exactly once;
 * this component surfaces a copy-to-clipboard and a .txt download so users
 * can reliably save them before dismissing.
 *
 * Design notes
 * ------------
 * - The component never persists the codes anywhere in the client — no
 *   localStorage, no application state beyond the signal that drives this
 *   view. Once the user dismisses, the codes are gone on the client side.
 *   The server keeps only hashes.
 * - Generation is step-up gated (M-PK1): a stolen access token alone must not
 *   be able to burn the account's existing codes. The ceremony runs through
 *   `StepUpDialog`, exactly as in `PasskeysView`, and the token it mints is
 *   passed straight to the generate call.
 * - The status line (`GET /recovery/status`) is what tells a user they have
 *   no codes at all. It carries counts only, never a code, so it needs no
 *   step-up — and gating it would be circular, since the answer is what tells
 *   the user whether starting a ceremony is worth it. A failed status read
 *   never blocks generation: it says so in the count's place, with a Try
 *   again, and leaves the count unknown.
 * - Regenerating invalidates any previous set server-side, so it asks for
 *   confirmation first — the easy footgun is rotating the set while the
 *   previous codes are still taped to a fridge somewhere.
 * - The count may be one the host remembered, being read again behind it
 *   (`read`). Generate is busy from the press until that read lands, and
 *   chooses between the warning and the step-up from what it says. A new set
 *   forgets the old count at once, so it is never shown again; the count is
 *   read again behind the codes on screen.
 */

export interface RecoveryCodesViewProps {
  /** Recovery client, built via `createRecoveryClient({ issuerUrl, authFetch })`. */
  client: RecoveryClient;
  /** Step-up client, built via `createStepUpClient({ issuerUrl, authFetch })`. */
  stepUpClient: StepUpClient;
  /**
   * Executes the browser-side WebAuthn assertion for the step-up ceremony.
   * Kept caller-side so the host picks the WebAuthn wrapper.
   */
  runPasskeyCeremony?: RunPasskeyCeremony;
  /**
   * TOTP client. Supplied, the step-up dialog offers the authenticator-app
   * factor wherever the ceremony and the account allow it. Omitted, it does
   * not. See `StepUpDialog.totpClient`.
   */
  totpClient?: TotpClient;
  /**
   * The host cannot deliver mail: the step-up sheet offers no emailed link.
   * See `StepUpDialog.passkeyOnly`. No host passes it today.
   */
  passkeyOnly?: boolean;
  /** Fires once the user has acknowledged saving the codes. */
  onSaved?: () => void;
  /** Product name the downloaded file is named after — e.g. "Musubi". */
  productName: string;
  /**
   * The status, read by the host (Musubi's page cache), which may draw it
   * from memory and read it again behind it. Read once, when the view mounts.
   * Omitted, the view reads `client.getRecoveryCodesStatus()` itself.
   */
  read?: SettingsRead<RecoveryCodesStatus>;
}

/**
 * The name the codes download under, led by the product so a user who keeps
 * codes for several services can tell the files apart: "Musubi" →
 * `musubi-recovery-codes.txt`. Accents fold to their plain letter; anything
 * else that is not an ASCII letter or digit becomes a hyphen, and a name left
 * with nothing falls back to the bare filename.
 */
export function recoveryCodesFileName(productName: string): string {
  const slug = productName
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug ? `${slug}-recovery-codes.txt` : "recovery-codes.txt";
}

function formatDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function RecoveryCodesView(props: RecoveryCodesViewProps) {
  const [codes, setCodes] = createSignal<string[] | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [acknowledged, setAcknowledged] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [confirmRotate, setConfirmRotate] = createSignal(false);
  // Generate pressed while the count is read again: busy until it lands.
  const [checking, setChecking] = createSignal(false);

  // The freshly-shown codes are the ONLY copy the client ever holds, and the
  // previous set is already revoked server-side by the time they render — so
  // reloading, closing the tab, or switching the Settings hash-tab before the
  // user saves loses the codes silently. Warn while they're on screen and
  // unacknowledged.
  const unsaved = () => codes() !== null && !acknowledged();
  const NAV_WARNING = "You haven't saved your new recovery codes yet. Leave without saving them?";

  function handleBeforeUnload(e: BeforeUnloadEvent) {
    if (!unsaved()) return;
    e.preventDefault();
    // Legacy browsers gate the native prompt on a set `returnValue`.
    e.returnValue = "";
  }

  // In-app tab switches move the URL hash rather than unload the page, so
  // `beforeunload` never fires for them. Re-entrancy flag: reverting the hash
  // itself emits another `hashchange` we must ignore.
  let revertingHash = false;
  let lastHash = typeof location !== "undefined" ? location.hash : "";
  function handleNavGuard() {
    if (revertingHash) {
      revertingHash = false;
      lastHash = location.hash;
      return;
    }
    if (unsaved() && !window.confirm(NAV_WARNING)) {
      // User chose to stay — undo the navigation so the codes stay on screen.
      revertingHash = true;
      location.hash = lastHash;
      return;
    }
    lastHash = location.hash;
  }

  onMount(() => {
    if (typeof window === "undefined") return;
    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("hashchange", handleNavGuard);
    window.addEventListener("popstate", handleNavGuard);
  });
  onCleanup(() => {
    if (typeof window === "undefined") return;
    window.removeEventListener("beforeunload", handleBeforeUnload);
    window.removeEventListener("hashchange", handleNavGuard);
    window.removeEventListener("popstate", handleNavGuard);
  });

  // Fails soft: a status read that errors leaves the count unknown rather than
  // stranding the user on an error screen with no way to make codes. The
  // failure is never a count: it shows in the count's place, with Try again.
  const status = props.read ?? ownRead(() => props.client.getRecoveryCodesStatus());

  const count = () => status.value() ?? null;
  const readFailure = status.failure;
  const hasCodes = () => {
    const s = count();
    return s != null && s.total > 0;
  };

  // An unreadable status counts as "might have codes". Rotation is
  // destructive, so a failed count must not silently skip the warning.
  const mayHaveCodes = () => {
    const s = count();
    return s == null || s.total > 0;
  };

  // The skeleton and the disabled "Checking…" stand for a count not yet
  // known: before the first read lands, and after a new set until it is read
  // again — the old set's count is never shown once it is gone. A read behind
  // a count already shown leaves it on screen.
  const firstLoad = () => status.state() === "pending";

  // Freezes the generate button while a ceremony is in flight, so a double
  // click can't queue a second rotation behind the first — and while the
  // count is unknown, since then the panel can't tell a first set from a
  // rotation and would warn a brand-new user about codes they don't have.
  const locked = () => busy() || pending() || checking() || firstLoad();

  async function requestGenerate() {
    if (locked()) return;
    setError(null);
    // The count on screen may be one remembered and being read again: wait
    // for that read, busy from the press, and decide from what it says.
    setChecking(true);
    try {
      await status.settled();
    } finally {
      setChecking(false);
    }
    if (locked()) return;
    // Rotation is destructive — the existing set is revoked the moment the new
    // one is minted. Gate it behind an explicit confirmation dialog. A brand-new
    // account (no codes to lose) skips straight to the ceremony.
    if (mayHaveCodes()) {
      setConfirmRotate(true);
      return;
    }
    setPending(true);
  }

  function confirmRotation() {
    setConfirmRotate(false);
    setPending(true);
  }

  async function handleStepUp(token: StepUpToken) {
    setPending(false);
    setBusy(true);
    setError(null);
    const finish: (end: WriteEnd<RecoveryCodesStatus>) => void = status.write();
    try {
      const res = await props.client.generateRecoveryCodes({
        stepUpToken: token.token,
      });
      setCodes(res.codes);
      setAcknowledged(false);
      // The old set's count goes now, and the new one is read behind the
      // codes on screen. The codes themselves never reach the read.
      finish("unknown");
    } catch (e) {
      finish(writeEnd(e));
      setError(describeAuthError(e));
    } finally {
      setBusy(false);
    }
  }

  function cancelStepUp() {
    setPending(false);
  }

  async function copyToClipboard() {
    const c = codes();
    if (!c) return;
    await navigator.clipboard.writeText(c.join("\n"));
  }

  function downloadTxt() {
    const c = codes();
    if (!c) return;
    const blob = new Blob([c.join("\n") + "\n"], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = recoveryCodesFileName(props.productName);
    a.click();
    URL.revokeObjectURL(url);
  }

  function acknowledge() {
    setAcknowledged(true);
    setCodes(null);
    props.onSaved?.();
  }

  return (
    <div class="flex flex-col gap-4">
      <Show
        when={codes() !== null}
        fallback={
          <div class="flex flex-col gap-3">
            <p class="text-ui-sm leading-ui-snug text-ui-ink-secondary">
              Recovery codes let you sign in if you lose every device with your passkey. Each code
              works once. Generating a new set invalidates any previous codes.
            </p>
            {/* The first `GET /recovery/status` read gates the button (it is
                what tells a rotation from a first set), so on a slow link the
                panel would otherwise show a blank gap above a disabled
                button — indistinguishable from a broken one. Reserve the
                line's height so nothing shifts when the count lands. */}
            <div aria-busy={firstLoad() || undefined}>
              <Show
                when={!firstLoad()}
                fallback={<Skeleton standsFor="line" width={56} height={5} />}
              >
                <Show when={readFailure()}>
                  {(failure) => (
                    <LoadFailed
                      lead="Your recovery codes didn't load."
                      error={failure().error}
                      onRetry={status.retry}
                    />
                  )}
                </Show>
                {/* The count, kept on screen while it is read again behind it. */}
                <Show when={count()}>
                  {(s) => (
                    <Show
                      when={s().total > 0}
                      fallback={
                        <Notice tone="warn" size="sm">
                          You don&apos;t have any recovery codes yet. Without them, losing every
                          device with your passkey locks you out.
                        </Notice>
                      }
                    >
                      <p class="text-ui-sm leading-ui-snug text-ui-ink-secondary">
                        {s().active} of {s().total} codes unused
                        <Show when={s().generatedAt}>
                          {(ts) => <> · created {formatDate(ts())}</>}
                        </Show>
                      </p>
                    </Show>
                  )}
                </Show>
              </Show>
            </div>
            <Show when={error()}>
              {(msg) => (
                <Notice tone="danger" size="inline" alert>
                  {msg()}
                </Notice>
              )}
            </Show>
            {/* Busy only for a wait this button started — its generate, or
                the read again it waits on; a count not yet known and an open
                step-up hold it disabled. */}
            <Button
              onClick={requestGenerate}
              busy={busy() || checking()}
              disabled={!busy() && !checking() && (pending() || firstLoad())}
            >
              {busy()
                ? "Generating…"
                : // Same reason as the skeleton: say why the button is
                  // disabled instead of leaving it looking dead.
                  checking() || firstLoad()
                  ? "Checking…"
                  : hasCodes()
                    ? "Generate new codes"
                    : "Generate recovery codes"}
            </Button>
          </div>
        }
      >
        <div class="flex flex-col gap-3">
          <p class="text-ui-sm leading-ui-snug text-ui-ink-secondary">
            Save these codes somewhere safe. You will not see them again.
          </p>
          {/* The codes are already the person's, held here to copy: a well. */}
          <Card variant="muted" radius="md" padding="sm">
            <ul class="font-ui-mono text-ui-sm text-ui-ink grid grid-cols-2 gap-2">
              <For each={codes()!}>{(c) => <li>{c}</li>}</For>
            </ul>
          </Card>
          <div class="flex flex-wrap gap-2">
            <Button variant="outline" onClick={copyToClipboard}>
              Copy
            </Button>
            <Button variant="outline" onClick={downloadTxt}>
              Download .txt
            </Button>
          </div>
          <Checkbox
            size="sm"
            touch
            checked={acknowledged()}
            onChange={setAcknowledged}
            label="I've saved these codes somewhere safe."
          />
          <Button onClick={acknowledge} disabled={!acknowledged()}>
            Done
          </Button>
        </div>
      </Show>
      <Dialog open={confirmRotate()} onOpenChange={setConfirmRotate}>
        <DialogContent presentation="sheet" class="md:max-w-sm">
          <AuthHeader host="dialog" title="Generate a new set?" />
          <ViewStep
            host="dialog"
            onCancel={() => setConfirmRotate(false)}
            action={
              <Button {...stepAction("dialog")} onClick={confirmRotation}>
                Generate new set
              </Button>
            }
          >
            <div class="flex flex-col gap-2">
              <p class="text-ui-sm leading-ui-snug text-ui-ink-secondary">
                Your existing recovery codes stop working immediately — any copy you've saved
                elsewhere becomes useless.
              </p>
              <p class="text-ui-sm leading-ui-snug text-ui-ink-secondary">
                You'll be asked to confirm with your passkey before the new codes are generated.
              </p>
            </div>
          </ViewStep>
        </DialogContent>
      </Dialog>
      <Show when={pending()}>
        <StepUpDialog
          client={props.stepUpClient}
          onToken={handleStepUp}
          onCancel={cancelStepUp}
          runPasskeyCeremony={props.runPasskeyCeremony}
          passkeyOnly={props.passkeyOnly}
          totpClient={props.totpClient}
          reason="To generate recovery codes, confirm it's you."
          purpose="recovery_generate"
        />
      </Show>
    </div>
  );
}
