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
import { createSignal, createUniqueId, For, Show } from "solid-js";

import { fieldError, plainError, type FieldError } from "./error-lines";
import { LoadFailed } from "./LoadFailed";
import { describePasskeyError } from "./passkey-errors";
import { RowPlaceholder } from "./RowPlaceholder";
import { ownRead, writeEnd, type SettingsRead, type WriteEnd } from "./settings-read";
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
 * - The list may be one the host remembered, being read again behind it
 *   (`read`). Remove and Save are busy from the press until that read lands,
 *   then act only on a passkey still in it, under its name as it now reads.
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
  /**
   * The list, read by the host (Musubi's page cache), which may draw it from
   * memory and read it again behind it. Read once, when the view mounts.
   * Omitted, the view reads `client.list()` itself.
   */
  read?: SettingsRead<PasskeySummary[]>;
}

function formatTs(ts: number | null): string {
  if (ts === null) return "never";
  return new Date(ts * 1000).toLocaleString();
}

/** The step-up sheet's title: a removal names it; the rest take the sheet's own. */
function stepUpTitle(action: PendingAction): string | undefined {
  return action.kind === "delete" ? `Remove ${action.name}?` : undefined;
}

/** The one line the step-up sheet shows under its title for `action`. */
function stepUpLine(action: PendingAction): string {
  switch (action.kind) {
    case "add":
      return "To add a passkey, confirm it's you.";
    case "rename":
      return `To rename ${action.name}, confirm it's you.`;
    case "delete":
      return "You'll need another credential to sign in. Confirm it's you to remove it.";
  }
}

function friendlyLabel(p: PasskeySummary): string {
  if (p.label && p.label.trim().length > 0) return p.label;
  if (p.backupEligible) return "Synced passkey";
  return "Device passkey";
}

type PendingAction =
  // `name` is the passkey as it is named now, for the sheet's line; `label`
  // the name it is about to take.
  | { kind: "rename"; id: string; label: string; name: string }
  | { kind: "delete"; id: string; name: string }
  | { kind: "add" };

export function PasskeysView(props: PasskeysViewProps) {
  const passkeys = props.read ?? ownRead(async () => (await props.client.list()).passkeys);
  /**
   * The list once a read has landed, kept on screen while it is read again,
   * and nothing before the first read lands, after one fails, or after a
   * write whose effect only the server knows.
   */
  const list = passkeys.value;
  // A refused rename sits under the rename field, tied to it; any other
  // failure sits under the heading.
  const [error, setError] = createSignal<(FieldError & { rename: boolean }) | null>(null);
  const errorId = createUniqueId();
  const renameError = () => (error()?.rename ? error() : null);
  /** Whether the passkey being renamed is on screen, its field and line with it. */
  const renameOnScreen = () => list()?.some((row) => row.id === editingId()) ?? false;
  const [busy, setBusy] = createSignal(false);
  // The action pressed while the list is read again: busy until it lands.
  const [checking, setChecking] = createSignal<string | null>(null);
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
  // And while a press waits for the list to be read again: the press is the
  // one that opens the sheet.
  const locked = () => busy() || pending() !== null || checking() !== null;

  /**
   * Runs `act` with `p` as the list now reads it, once no read of it is out,
   * and nothing when the read has taken it off. The pressed action is busy,
   * and every other one disabled, from the press: when no read is out the
   * wait ends before anything paints.
   */
  async function onFreshRow(
    action: string,
    p: PasskeySummary,
    act: (fresh: PasskeySummary) => void,
  ) {
    if (locked()) return;
    setError(null);
    setChecking(action);
    try {
      const fresh = (await passkeys.settled())?.find((row) => row.id === p.id);
      if (fresh) act(fresh);
    } finally {
      setChecking(null);
    }
  }

  function requestRename(p: PasskeySummary) {
    const label = draftLabel().trim();
    if (label.length === 0) return;
    void onFreshRow(`save:${p.id}`, p, (fresh) =>
      setPending({ kind: "rename", id: fresh.id, label, name: friendlyLabel(fresh) }),
    );
  }

  function requestDelete(p: PasskeySummary) {
    void onFreshRow(`remove:${p.id}`, p, (fresh) =>
      setPending({ kind: "delete", id: fresh.id, name: friendlyLabel(fresh) }),
    );
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
    // Told how the write ended, once it settles; set just before the request
    // that may change the list.
    let finish: ((end: WriteEnd<PasskeySummary[]>) => void) | undefined;
    try {
      if (action.kind === "rename") {
        finish = passkeys.write();
        await props.client.rename({
          id: action.id,
          label: action.label,
          stepUpToken: token.token,
        });
        // The server stores the label trimmed, as it was sent.
        finish({
          outcome: (rows) =>
            rows.map((row) => (row.id === action.id ? { ...row, label: action.label } : row)),
        });
        cancelEdit();
      } else if (action.kind === "delete") {
        finish = passkeys.write();
        await props.client.delete({
          id: action.id,
          stepUpToken: token.token,
        });
        finish({ outcome: (rows) => rows.filter((row) => row.id !== action.id) });
      } else {
        // kind === "add" — guarded by requestAdd(). The step-up and the
        // browser's ceremony change no row; the last call does.
        const profileId = props.profileId!;
        const runRegistration = props.runPasskeyRegistration!;
        const options = await props.client.registerBegin({
          profileId,
          stepUpToken: token.token,
        });
        const attestation = await runRegistration(options);
        finish = passkeys.write();
        await props.client.registerComplete({
          profileId,
          attestation,
        });
        // The new row's fields are the server's.
        finish("unknown");
      }
    } catch (e) {
      finish?.(writeEnd(e));
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
      <Show when={(!error()?.rename || !renameOnScreen()) && error()}>
        {(line) => (
          <Notice tone="danger" size="inline" alert>
            {line().text}
          </Notice>
        )}
      </Show>
      {/* The list's place: one row's placeholder until the first read lands
          (every account has a passkey), the failure, or the list. */}
      <div aria-busy={passkeys.state() === "pending" || undefined}>
        <Show when={passkeys.state() === "pending"}>
          <RowPlaceholder />
        </Show>
        <Show when={passkeys.failure()}>
          {(failure) => (
            <LoadFailed
              lead="Your passkeys didn't load."
              error={failure().error}
              onRetry={passkeys.retry}
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
                              onClick={() => requestRename(p)}
                              busy={checking() === `save:${p.id}`}
                              disabled={
                                checking() !== `save:${p.id}` &&
                                (locked() || draftLabel().trim().length === 0)
                              }
                            >
                              {checking() === `save:${p.id}` ? "Checking…" : "Save"}
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
                            busy={checking() === `remove:${p.id}`}
                            disabled={checking() !== `remove:${p.id}` && locked()}
                            aria-label={`Remove ${friendlyLabel(p)}`}
                          >
                            {checking() === `remove:${p.id}` ? "Checking…" : "Remove"}
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
            title={stepUpTitle(action())}
            // A removal's line says what it costs; the others say why.
            warning={action().kind === "delete" ? stepUpLine(action()) : undefined}
            reason={action().kind === "delete" ? undefined : stepUpLine(action())}
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
