import type { RecoveryClient, StepUpClient, StepUpToken } from "@osn/client";
import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import { Button } from "../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { StepUpDialog } from "./StepUpDialog";

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
 *   never blocks generation; it just leaves the count unknown.
 * - Regenerating invalidates any previous set server-side, so it asks for
 *   confirmation first — the easy footgun is rotating the set while the
 *   previous codes are still taped to a fridge somewhere.
 */

export interface RecoveryCodesViewProps {
  /** Recovery client, built via `createRecoveryClient({ issuerUrl })`. */
  client: RecoveryClient;
  /** Step-up client, built via `createStepUpClient({ issuerUrl })`. */
  stepUpClient: StepUpClient;
  /** The caller's current access token — required to authenticate generate. */
  accessToken: string;
  /**
   * Executes the browser-side WebAuthn assertion for the step-up ceremony.
   * Kept caller-side so `@osn/ui` doesn't pull `@simplewebauthn/browser`.
   */
  runPasskeyCeremony?: (options: unknown) => Promise<unknown>;
  /**
   * Force the step-up ceremony to use the passkey factor only, suppressing
   * the OTP ("email me a code") option. Set this for accounts whose host has
   * no deliverable transactional email, so the user is never offered a code
   * that won't arrive.
   */
  passkeyOnly?: boolean;
  /** Fires once the user has acknowledged saving the codes. */
  onSaved?: () => void;
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
  const [reloadKey, setReloadKey] = createSignal(0);

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
  // stranding the user on an error screen with no way to make codes.
  const [status] = createResource(reloadKey, async () => {
    try {
      return await props.client.getRecoveryCodesStatus({ accessToken: props.accessToken });
    } catch {
      return null;
    }
  });

  // P-W2: read `status.latest` rather than `status()` so the button label
  // doesn't join the resource's Suspense boundary and blank the whole panel
  // on every refetch.
  const hasCodes = () => {
    const s = status.latest;
    return s != null && s.total > 0;
  };

  // S-L1: an unreadable status counts as "might have codes". Rotation is
  // destructive, so a failed count must not silently skip the warning.
  const mayHaveCodes = () => {
    const s = status.latest;
    return s == null || s.total > 0;
  };

  // Freezes the generate button while a ceremony is in flight, so a double
  // click can't queue a second rotation behind the first — and until the first
  // status read lands, since before that the panel can't tell a first set from
  // a rotation and would warn a brand-new user about codes they don't have.
  const locked = () => busy() || pending() || status.loading;

  function requestGenerate() {
    if (locked()) return;
    setError(null);
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
    try {
      const res = await props.client.generateRecoveryCodes({
        accessToken: props.accessToken,
        stepUpToken: token.token,
      });
      setCodes(res.codes);
      setAcknowledged(false);
      // No status refetch here: the codes list has replaced the status line,
      // and `acknowledge()` refetches once the user leaves it.
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to generate recovery codes");
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
    a.download = "osn-recovery-codes.txt";
    a.click();
    URL.revokeObjectURL(url);
  }

  function acknowledge() {
    setAcknowledged(true);
    setCodes(null);
    setReloadKey((k) => k + 1);
    props.onSaved?.();
  }

  return (
    <div class="flex flex-col gap-4">
      <Show
        when={codes() !== null}
        fallback={
          <div class="flex flex-col gap-3">
            <p class="text-muted-foreground text-sm">
              Recovery codes let you sign in if you lose every device with your passkey. Each code
              works once. Generating a new set invalidates any previous codes.
            </p>
            <Show when={!status.loading}>
              <Show
                when={status()}
                fallback={
                  <p class="text-muted-foreground text-sm">
                    Couldn't check whether you have recovery codes.
                  </p>
                }
              >
                {(s) => (
                  <Show
                    when={s().total > 0}
                    fallback={
                      <p class="text-destructive text-sm">
                        You don't have any recovery codes yet. Without them, losing every device
                        with your passkey locks you out.
                      </p>
                    }
                  >
                    <p class="text-muted-foreground text-sm">
                      {s().active} of {s().total} codes unused
                      <Show when={s().generatedAt}>
                        {(ts) => <> · created {formatDate(ts())}</>}
                      </Show>
                    </p>
                  </Show>
                )}
              </Show>
            </Show>
            <Button onClick={requestGenerate} disabled={locked()}>
              {busy()
                ? "Generating…"
                : hasCodes()
                  ? "Generate new codes"
                  : "Generate recovery codes"}
            </Button>
            <Show when={error()}>{(msg) => <p class="text-destructive text-sm">{msg()}</p>}</Show>
          </div>
        }
      >
        <div class="flex flex-col gap-3">
          <p class="text-muted-foreground text-sm">
            Save these codes somewhere safe. You will not see them again.
          </p>
          <ul class="bg-muted/40 grid grid-cols-2 gap-2 rounded-md border p-3 font-mono text-sm">
            <For each={codes()!}>{(c) => <li>{c}</li>}</For>
          </ul>
          <div class="flex flex-wrap gap-2">
            <Button variant="outline" onClick={copyToClipboard}>
              Copy
            </Button>
            <Button variant="outline" onClick={downloadTxt}>
              Download .txt
            </Button>
          </div>
          <label class="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={acknowledged()}
              onChange={(e) => setAcknowledged(e.currentTarget.checked)}
            />
            I've saved these codes somewhere safe.
          </label>
          <Button onClick={acknowledge} disabled={!acknowledged()}>
            Done
          </Button>
        </div>
      </Show>
      <Dialog open={confirmRotate()} onOpenChange={setConfirmRotate}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Generate a new set?</DialogTitle>
          </DialogHeader>
          <div class="flex flex-col gap-2 p-4">
            <p class="text-muted-foreground text-sm">
              Your existing recovery codes stop working immediately — any copy you've saved
              elsewhere becomes useless.
            </p>
            <p class="text-muted-foreground text-sm">
              You'll be asked to confirm with your passkey before the new codes are generated.
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmRotate(false)}>
              Cancel
            </Button>
            <Button onClick={confirmRotation}>Generate new set</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Show when={pending()}>
        <StepUpDialog
          client={props.stepUpClient}
          accessToken={props.accessToken}
          onToken={handleStepUp}
          onCancel={cancelStepUp}
          runPasskeyCeremony={props.runPasskeyCeremony}
          passkeyOnly={props.passkeyOnly}
          reason="to generate recovery codes"
          purpose="recovery_generate"
        />
      </Show>
    </div>
  );
}
