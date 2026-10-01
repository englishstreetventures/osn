import Button from "@cire/ui/button";
import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import { Select } from "@shared/ui/ui/select";
import { createSignal, createUniqueId, For, onMount, Show } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin, weddingPath } from "../../lib/api";
import type { OrganiserHouseholdRow } from "../../lib/households-store";
import { buildInviteMessage, copyToClipboard } from "../../lib/invite-message";
import { markHouseholdShared } from "../../lib/mark-shared";

/** Stands where the code goes when no household is chosen. */
const CODE_PLACEHOLDER = "[household code]";

const NOTE_CLASS = "font-body text-text-muted text-ui-xs italic";

interface InviteMessageCopyProps {
  weddingId: string;
  weddingName: string;
  weddingSlug: string;
  /** Owner or editor: a copy also marks the household sent, which a viewer
   *  may not. */
  canEdit: boolean;
  /** The first line as saved — what a copy sends. `null` sends the default. */
  savedLine: string | null;
  /** The first line as typed — what the preview shows. */
  draftLine: string;
}

/** A household whose code gets someone into an invitation: it has a guest, and
 *  its code has not been cut off. */
const canReceive = (row: OrganiserHouseholdRow) => row.guestCount > 0 && row.deactivatedAt === null;

/** A first line as the message will carry it: trimmed, and blank as the default. */
const asSent = (line: string | null) => line?.trim() || null;

/**
 * Copy a household's invite message from beside the line that opens it, so an
 * organiser writing that line need not leave the Invite module to send it.
 * Guests → Households keeps its copy on every row; this one takes a household
 * from a picker.
 *
 * With no household chosen the message carries a placeholder where the code
 * goes, and the button says it copies a template. That is the default, so a
 * first tap never marks a household sent that the organiser did not pick.
 *
 * The preview follows the line being typed; a copy always sends the saved one,
 * and waits while the two would differ — the copy is built on the client, and
 * a message a guest receives has to match what the builder has saved.
 *
 * The households are read fresh each time the builder mounts: the codes change
 * in Invite → Codes and households are cut off in Guests, and a cached list
 * would offer a code that no longer opens anything.
 */
export default function InviteMessageCopy(props: InviteMessageCopyProps) {
  const { authFetch } = useAuth();
  const [households, setHouseholds] = createSignal<OrganiserHouseholdRow[]>([]);
  const [status, setStatus] = createSignal<"loading" | "ready" | "failed">("loading");
  const [chosenId, setChosenId] = createSignal("");
  // Households marked sent from here. The rows stay as read, so marking one
  // relabels its option rather than replacing it — a replaced option would
  // drop the picker's selection.
  const [sentNow, setSentNow] = createSignal<ReadonlySet<string>>(new Set());
  const pickerId = createUniqueId();
  const pickerNoteId = createUniqueId();
  const copyNoteId = createUniqueId();

  onMount(async () => {
    try {
      const res = await authFetch(apiUrl(weddingPath(props.weddingId, "/households")));
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`Could not load households (${res.status})`);
      const rows = (await res.json()) as OrganiserHouseholdRow[];
      setHouseholds(rows.filter(canReceive));
      setStatus("ready");
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setStatus("failed");
    }
  });

  const pickerNote = () =>
    status() === "failed"
      ? "Could not load the households. Refresh to try again."
      : status() === "ready" && households().length === 0
        ? "No households to choose yet."
        : null;
  const chosen = () => households().find((row) => row.familyId === chosenId()) ?? null;
  const isSent = (row: OrganiserHouseholdRow) =>
    row.codeSharedAt !== null || sentNow().has(row.familyId);
  const unsaved = () => asSent(props.draftLine) !== asSent(props.savedLine);
  const message = (line: string | null) =>
    buildInviteMessage(
      props.weddingName,
      chosen()?.publicId ?? CODE_PLACEHOLDER,
      props.weddingSlug,
      line,
    );

  async function copy() {
    if (unsaved()) return;
    const household = chosen();
    if (!(await copyToClipboard(message(props.savedLine)))) {
      toast.error("Couldn't copy automatically. Select the message above and copy it by hand.");
      return;
    }
    if (!household) {
      toast.success("Copied the message with a placeholder for the code");
      return;
    }
    toast.success(`Copied ${household.familyName}'s invite message`);
    if (!props.canEdit) return;
    if (await markHouseholdShared(authFetch, props.weddingId, household.familyId)) {
      setSentNow((prev) => new Set(prev).add(household.familyId));
    }
  }

  return (
    <div class="flex flex-col gap-3">
      <div class="flex flex-col gap-1.5">
        <label for={pickerId} class="font-body text-text-muted text-ui-sm">
          Household
        </label>
        <Select
          id={pickerId}
          value={chosenId()}
          aria-describedby={pickerNote() ? pickerNoteId : undefined}
          onChange={(e) => setChosenId(e.currentTarget.value)}
        >
          <option value="">No household (placeholder code)</option>
          <For each={households()}>
            {(row) => (
              <option value={row.familyId}>
                {`${row.familyName} · ${row.publicId}${isSent(row) ? " · sent" : ""}`}
              </option>
            )}
          </For>
        </Select>
        <Show when={pickerNote()}>
          {(note) => (
            <span id={pickerNoteId} class={NOTE_CLASS}>
              {note()}
            </span>
          )}
        </Show>
      </div>
      {/* `select-all`: one tap selects the whole message, the way to copy it
          by hand when the clipboard refuses. */}
      <p
        data-testid="invite-message-preview"
        class="border-border font-body text-text text-ui-sm rounded-sm border p-3 wrap-break-word whitespace-pre-wrap select-all"
      >
        {message(props.draftLine)}
      </p>
      <div class="flex flex-wrap items-center gap-3">
        {/* `aria-disabled`, never `disabled`: the button keeps its tab stop,
            so the reason it cannot copy stays reachable. */}
        <Button
          variant="quiet"
          size="sm"
          aria-disabled={unsaved() ? "true" : undefined}
          aria-describedby={unsaved() ? copyNoteId : undefined}
          onClick={() => void copy()}
        >
          {chosen() ? "Copy message" : "Copy template"}
        </Button>
        <Show when={unsaved()}>
          <span id={copyNoteId} class={NOTE_CLASS}>
            Save the invite to copy the new first line.
          </span>
        </Show>
      </div>
    </div>
  );
}
