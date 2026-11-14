import {
  describeAuthError,
  type PasskeysClient,
  type PasskeySummary,
  type StepUpClient,
  type StepUpToken,
  type TotpClient,
} from "@osn/client";
import { Button } from "@shared/ui/ui/button";
import { Input } from "@shared/ui/ui/input";
import { Notice } from "@shared/ui/ui/notice";
import { createResource, createSignal, createUniqueId, For, Show } from "solid-js";

import { fieldError, plainError, type FieldError } from "./error-lines";
import { LoadFailed } from "./LoadFailed";
import { describePasskeyError } from "./passkey-errors";
import { RowPlaceholder } from "./RowPlaceholder";
import { SettingsRow } from "./SettingsRow";
import { StepUpDialog, type RunPasskeyCeremony, type RunPasskeyRegistration } from "./StepUpDialog";

/**
 * Settings-panel surface for listing, renaming, and deleting the caller's
 * passkeys. Mirrors `SessionsView` in shape.
 *
 * Design notes
 * ------------
 * - The list response intentionally omits `credentialId` — the
 *   only handle the UI needs is the opaque `pk_<hex>` `id`.
 * - Both rename and delete are step-up gated. Rename is gated
 *   because relabelling is a precondition-inflation attack on the very
 *   confirmation prompt the user uses to choose which credential to
 *   delete.
 * - Once a step-up is in flight, every Rename / Remove button on the
 *   page is disabled so a rapid double-click can't mutate a
 *   different credential than the one the user just confirmed.
 * - A removal asks nothing of its own: the step-up sheet opens titled with
 *   the passkey's name, its warning says what removing it costs, and the
 *   factor picked there commits it.
 */

export interface PasskeysViewProps {
  client: PasskeysClient;
  stepUpClient: StepUpClient;
  /**
   * Profile ID used for passkey enrolment. Required to surface the "Add a
   * passkey" button; without it, enrolment stays hidden and only the
   * list / rename / remove surface renders.
   */
  profileId?: string;
  /**
   * Executes the browser-side WebAuthn assertion for the step-up ceremony.
   * Kept caller-side so the host picks the WebAuthn wrapper.
   */
  runPasskeyCeremony?: RunPasskeyCeremony;
  /**
   * Executes the browser-side WebAuthn attestation ceremony for adding a
   * new passkey. Same caller-side pattern as `runPasskeyCeremony`.
   */
  runPasskeyRegistration?: RunPasskeyRegistration;
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
}

function formatTs(ts: number | null): string {
  if (ts === null) return "never";
  return new Date(ts * 1000).toLocaleString();
}

/** The passkey a pending removal names. */
function removing(action: PendingAction): string {
  return action.kind === "delete" ? action.name : "";
}

function friendlyLabel(p: PasskeySummary): string {
  if (p.label && p.label.trim().length > 0) return p.label;
  if (p.backupEligible) return "Synced passkey";
  return "Device passkey";
}

type PendingAction =
  | { kind: "rename"; id: string; label: string }
  | { kind: "delete"; id: string; name: string }
  | { kind: "add" };

export function PasskeysView(props: PasskeysViewProps) {
  const [reloadKey, setReloadKey] = createSignal(0);
  const [passkeys] = createResource(reloadKey, async () => {
    const res = await props.client.list();
    return res.passkeys;
  });
  /**
   * The list once a read has landed, kept on screen while it is read again,
   * and nothing before the first read lands or after one fails. It reads
   * `state` first and never calls `passkeys()`: a failed resource throws when
   * read, and a loading one joins the host's Suspense boundary, which on
   * Settings swaps the whole tab for its fallback.
   */
  const list = () => {
    const state = passkeys.state;
    return state === "ready" || state === "refreshing" ? passkeys.latest : undefined;
  };
  // A refused rename sits under the rename field, tied to it; any other
  // failure sits under the heading.
  const [error, setError] = createSignal<(FieldError & { rename: boolean }) | null>(null);
  const errorId = createUniqueId();
  const renameError = () => (error()?.rename ? error() : null);
  const [busy, setBusy] = createSignal(false);
  const [editingId, setEditingId] = createSignal<string | null>(null);
  const [draftLabel, setDraftLabel] = createSignal("");
  const [pending, setPending] = createSignal<PendingAction | null>(null);

  function startEdit(p: PasskeySummary) {
    setError(null);
    setEditingId(p.id);
    setDraftLabel(p.label ?? "");
  }

  function cancelEdit() {
    setEditingId(null);
    setDraftLabel("");
  }

  // While a step-up ceremony is in flight, freeze every destructive
  // button on the page. Otherwise a rapid double-click could open the
  // dialog with a different `pending` than the one the user thought they
  // confirmed (the sheet opens asynchronously; the second click overwrites).
  // And while a landed list is read again: a passkey just deleted is still on
  // screen until the read lands, and acting on it would run a step-up for
  // nothing. Not on the first read, when there is no row to act on.
  const locked = () => busy() || pending() !== null || passkeys.state === "refreshing";

  function requestRename(id: string) {
    if (locked()) return;
    const label = draftLabel().trim();
    if (label.length === 0) return;
    setError(null);
    setPending({ kind: "rename", id, label });
  }

  function requestDelete(p: PasskeySummary) {
    if (locked()) return;
    setError(null);
    setPending({ kind: "delete", id: p.id, name: friendlyLabel(p) });
  }

  function requestAdd() {
    if (locked()) return;
    if (!props.profileId || !props.runPasskeyRegistration) return;
    setError(null);
    setPending({ kind: "add" });
  }

  async function handleStepUp(token: StepUpToken) {
    const action = pending();
    if (!action) return;
    setBusy(true);
    setError(null);
    try {
      if (action.kind === "rename") {
        await props.client.rename({
          id: action.id,
          label: action.label,
          stepUpToken: token.token,
        });
        cancelEdit();
      } else if (action.kind === "delete") {
        await props.client.delete({
          id: action.id,
          stepUpToken: token.token,
        });
      } else {
        // kind === "add" — guarded by requestAdd().
        const profileId = props.profileId!;
        const runRegistration = props.runPasskeyRegistration!;
        const options = await props.client.registerBegin({
          profileId,
          stepUpToken: token.token,
        });
        const attestation = await runRegistration(options);
        await props.client.registerComplete({
          profileId,
          attestation,
        });
      }
      setReloadKey((k) => k + 1);
    } catch (e) {
      if (action.kind === "rename") {
        setError({ ...fieldError(describeAuthError(e), e), rename: true });
      } else if (action.kind === "delete") {
        setError({ ...plainError(describeAuthError(e)), rename: false });
      } else {
        // Adding runs the browser's ceremony between two server calls.
        setError({ ...plainError(describePasskeyError(e, "registration")), rename: false });
      }
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
      {/* The action goes under the heading when the two do not fit on one line. */}
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h2 class="text-ui-ink text-ui-md font-ui-title">Passkeys</h2>
        <Show when={props.profileId && props.runPasskeyRegistration}>
          <Button size="sm" class="max-md:h-10" onClick={requestAdd} disabled={locked()}>
            Add a passkey
          </Button>
        </Show>
      </div>
      <Show when={!error()?.rename && error()}>
        {(line) => (
          <Notice tone="danger" size="inline" alert>
            {line().text}
          </Notice>
        )}
      </Show>
      {/* The list's place: one row's placeholder until the first read lands
          (every account has a passkey), the failure, or the list. */}
      <div aria-busy={passkeys.loading || undefined}>
        <Show when={passkeys.loading && list() === undefined}>
          <RowPlaceholder />
        </Show>
        <Show when={!passkeys.loading && passkeys.error}>
          {(err) => (
            <LoadFailed
              lead="Your passkeys didn't load."
              error={err()}
              onRetry={() => setReloadKey((k) => k + 1)}
            />
          )}
        </Show>
        <Show when={list()}>
          {(rows) => (
            <ul class="flex flex-col gap-2">
              <For each={rows()}>
                {(p: PasskeySummary) => (
                  <li>
                    <SettingsRow
                      name={
                        <>
                          {friendlyLabel(p)}
                          <Show when={p.backupEligible}>
                            <span class="text-ui-ink-secondary text-ui-xs ml-2 font-normal">
                              (synced)
                            </span>
                          </Show>
                        </>
                      }
                      editing={editingId() === p.id}
                      editor={
                        <>
                          <div class="flex items-center gap-2">
                            <Input
                              size="sm"
                              autocomplete="off"
                              value={draftLabel()}
                              maxLength={64}
                              onInput={(e) => setDraftLabel(e.currentTarget.value)}
                              aria-label="Passkey name"
                              aria-describedby={renameError() ? errorId : undefined}
                              aria-invalid={renameError()?.invalid || undefined}
                            />
                            <Button
                              variant="outline"
                              size="sm"
                              class="shrink-0 max-md:h-10"
                              onClick={() => requestRename(p.id)}
                              disabled={locked() || draftLabel().trim().length === 0}
                            >
                              Save
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              class="shrink-0 max-md:h-10"
                              onClick={cancelEdit}
                              disabled={busy()}
                            >
                              Cancel
                            </Button>
                          </div>
                          <Show when={renameError()}>
                            {(line) => (
                              <Notice tone="danger" size="inline" alert id={errorId}>
                                {line().text}
                              </Notice>
                            )}
                          </Show>
                        </>
                      }
                      meta={[
                        `Added ${formatTs(Math.floor(p.createdAt))}`,
                        `Last used ${formatTs(p.lastUsedAt)}`,
                      ]}
                      actions={
                        // Each action names its passkey, so two rows' buttons
                        // never share a name.
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            class="max-md:h-10"
                            onClick={() => startEdit(p)}
                            disabled={locked()}
                            aria-label={`Rename ${friendlyLabel(p)}`}
                          >
                            Rename
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            class="max-md:h-10"
                            onClick={() => requestDelete(p)}
                            disabled={locked()}
                            aria-label={`Remove ${friendlyLabel(p)}`}
                          >
                            Remove
                          </Button>
                        </>
                      }
                    />
                  </li>
                )}
              </For>
            </ul>
          )}
        </Show>
      </div>
      <details class="text-ui-sm leading-ui-snug text-ui-ink-secondary mt-2">
        {/* Drawn here, so it takes Button's ring (DESIGN.md §9). */}
        <summary class="text-ui-ink rounded-ui-sm focus-visible:ring-ui-focus cursor-pointer font-medium focus-visible:ring-2 focus-visible:outline-hidden">
          Signing in somewhere new?
        </summary>
        <div class="mt-2 flex flex-col gap-2">
          <p>There are three ways onto a device that has no passkey yet:</p>
          <ul class="list-inside list-disc">
            <li>
              <span class="text-ui-ink font-medium">Backed-up passkey</span> — if your passkey is
              saved to iCloud Keychain, Google Password Manager, or a password manager, it's already
              available on your other signed-in devices.
            </li>
            <li>
              <span class="text-ui-ink font-medium">Cross-device sign-in</span> — on the sign-in
              screen choose the QR / nearby-device option your password manager offers, then approve
              it with your phone.
            </li>
            <li>
              <span class="text-ui-ink font-medium">Recovery code</span> — if you've lost access to
              every passkey, use a saved recovery code from the "Lost your passkey?" link on
              sign-in, then add a fresh passkey here.
            </li>
          </ul>
          <p>Once you're signed in there, use "Add a passkey" above to enrol that device.</p>
        </div>
      </details>
      <Show when={pending()}>
        {(action) => (
          <StepUpDialog
            client={props.stepUpClient}
            onToken={handleStepUp}
            onCancel={cancelStepUp}
            runPasskeyCeremony={props.runPasskeyCeremony}
            passkeyOnly={props.passkeyOnly}
            totpClient={props.totpClient}
            title={action().kind === "delete" ? `Remove ${removing(action())}?` : undefined}
            warning={
              action().kind === "delete"
                ? "You'll need another credential to sign in. Confirm it's you to remove it."
                : undefined
            }
            // Bind the minted token to the exact ceremony. Enrolment mints
            // `passkey_register`; rename and delete share the delete gate and
            // both mint `passkey_delete`. The server rejects a token minted for
            // any other purpose at these endpoints.
            purpose={action().kind === "add" ? "passkey_register" : "passkey_delete"}
          />
        )}
      </Show>
    </div>
  );
}
