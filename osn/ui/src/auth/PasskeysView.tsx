import type { PasskeysClient, PasskeySummary, StepUpClient, StepUpToken } from "@osn/client";
import { createResource, createSignal, For, Show } from "solid-js";

import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { StepUpDialog } from "./StepUpDialog";

/**
 * Settings-panel surface for listing, renaming, and deleting the caller's
 * passkeys. Mirrors `SessionsView` in shape.
 *
 * Design notes
 * ------------
 * - The list response intentionally omits `credentialId` (S-L2) — the
 *   only handle the UI needs is the opaque `pk_<hex>` `id`.
 * - Both rename and delete are step-up gated. Rename is gated (S-M2)
 *   because relabelling is a precondition-inflation attack on the very
 *   confirmation prompt the user uses to choose which credential to
 *   delete.
 * - Once a step-up is in flight, every Rename / Delete button on the
 *   page is disabled (S-L1) so a rapid double-click can't mutate a
 *   different credential than the one the user just confirmed.
 */

export interface PasskeysViewProps {
  client: PasskeysClient;
  stepUpClient: StepUpClient;
  accessToken: string;
  /**
   * Executes the browser-side WebAuthn assertion for the step-up ceremony.
   * Kept caller-side so `@osn/ui` doesn't pull `@simplewebauthn/browser`.
   */
  runPasskeyCeremony?: (options: unknown) => Promise<unknown>;
}

function formatTs(ts: number | null): string {
  if (ts === null) return "never";
  return new Date(ts * 1000).toLocaleString();
}

function friendlyLabel(p: PasskeySummary): string {
  if (p.label && p.label.trim().length > 0) return p.label;
  if (p.backupEligible) return "Synced passkey";
  return "Device passkey";
}

type PendingAction = { kind: "rename"; id: string; label: string } | { kind: "delete"; id: string };

export function PasskeysView(props: PasskeysViewProps) {
  const [reloadKey, setReloadKey] = createSignal(0);
  const [passkeys] = createResource(reloadKey, async () => {
    const res = await props.client.list({ accessToken: props.accessToken });
    return res.passkeys;
  });
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [draftLabel, setDraftLabel] = createSignal("");
  const [pending, setPending] = createSignal<PendingAction | null>(null);

  function startEdit(p: PasskeySummary) {
    setEditingId(p.id);
    setDraftLabel(p.label ?? "");
  }

  function cancelEdit() {
    setEditingId(null);
    setDraftLabel("");
  }

  // S-L1: while a step-up ceremony is in flight, freeze every destructive
  // button on the page. Otherwise a rapid double-click could open the
  // dialog with a different `pending` than the one the user thought they
  // confirmed (the `confirm`/dialog is async; the second click overwrites).
  const locked = () => busy() || pending() !== null;

  function requestRename(id: string) {
    if (locked()) return;
    const label = draftLabel().trim();
    if (label.length === 0) return;
    setError(null);
    setPending({ kind: "rename", id, label });
  }

  function requestDelete(id: string) {
    if (locked()) return;
    if (!window.confirm("Remove this passkey? You'll need another credential to sign in.")) {
      return;
    }
    setError(null);
    setPending({ kind: "delete", id });
  }

  async function handleStepUp(token: StepUpToken) {
    const action = pending();
    if (!action) return;
    setBusy(true);
    setError(null);
    try {
      if (action.kind === "rename") {
        await props.client.rename({
          accessToken: props.accessToken,
          id: action.id,
          label: action.label,
          stepUpToken: token.token,
        });
        cancelEdit();
      } else {
        await props.client.delete({
          accessToken: props.accessToken,
          id: action.id,
          stepUpToken: token.token,
        });
      }
      setReloadKey((k) => k + 1);
    } catch (e) {
      const fallback =
        action.kind === "rename" ? "Couldn't rename passkey" : "Couldn't delete passkey";
      setError(e instanceof Error ? e.message : fallback);
    } finally {
      setBusy(false);
      setPending(null);
    }
  }

  function cancelStepUp() {
    setPending(null);
  }

  return (
    <div class="flex flex-col gap-3">
      <div class="flex items-center justify-between">
        <h2 class="text-lg font-semibold">Passkeys</h2>
      </div>
      <Show when={error()}>{(msg) => <p class="text-destructive text-sm">{msg()}</p>}</Show>
      <Show when={passkeys.loading}>
        <p class="text-muted-foreground text-sm">Loading…</p>
      </Show>
      <Show when={passkeys()}>
        {(list) => (
          <ul class="flex flex-col gap-2">
            <For each={list()}>
              {(p: PasskeySummary) => (
                <li class="flex items-center justify-between rounded-md border p-3">
                  <div class="flex flex-col gap-0.5">
                    <Show
                      when={editingId() === p.id}
                      fallback={
                        <span class="font-medium">
                          {friendlyLabel(p)}
                          <Show when={p.backupEligible}>
                            <span class="text-muted-foreground ml-2 text-xs">(synced)</span>
                          </Show>
                        </span>
                      }
                    >
                      <div class="flex items-center gap-2">
                        <Input
                          class="h-8"
                          value={draftLabel()}
                          maxLength={64}
                          onInput={(e) => setDraftLabel(e.currentTarget.value)}
                        />
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => requestRename(p.id)}
                          disabled={locked() || draftLabel().trim().length === 0}
                        >
                          Save
                        </Button>
                        <Button variant="ghost" size="sm" onClick={cancelEdit} disabled={busy()}>
                          Cancel
                        </Button>
                      </div>
                    </Show>
                    <span class="text-muted-foreground text-xs">
                      Added {formatTs(Math.floor(p.createdAt))} · Last used {formatTs(p.lastUsedAt)}
                    </span>
                  </div>
                  <Show when={editingId() !== p.id}>
                    <div class="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => startEdit(p)}
                        disabled={locked()}
                      >
                        Rename
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => requestDelete(p.id)}
                        disabled={locked()}
                      >
                        Delete
                      </Button>
                    </div>
                  </Show>
                </li>
              )}
            </For>
          </ul>
        )}
      </Show>
      <Show when={pending()}>
        <StepUpDialog
          client={props.stepUpClient}
          accessToken={props.accessToken}
          onToken={handleStepUp}
          onCancel={cancelStepUp}
          runPasskeyCeremony={props.runPasskeyCeremony}
        />
      </Show>
    </div>
  );
}
