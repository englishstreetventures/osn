import { ORGANISER_EMAIL_ATTESTATION } from "@cire/guest-email";
import Button from "@cire/ui/button";
import { Notice } from "@shared/ui/ui/notice";
import { Table, Td, Th } from "@shared/ui/ui/table";
import { createSignal, createUniqueId, For, Show } from "solid-js";

import EmailAttestationCheck from "./EmailAttestationCheck";
// The SHARED change-preview renderer (guest+event editor §8): "extract
// ImportPanel's plan-rendering into a shared component so both ImportPanel and
// the editor save-flow render the same preview". Both front doors of the
// reconcile pipeline (spreadsheet upload + editor draft-save) return the SAME
// `{plan, warnings}` shape from `changes/preview`, so both show the diff counts
// + the confirm-gated impact warnings identically.
//
// This owns ONLY presentation: the caller runs preview/apply and passes the
// plan in, wires `onConfirm` to its apply call, and controls the busy state.

/** The reconcile plan shape returned by `changes/preview` (a structural subset —
 *  only the array LENGTHS are rendered, so the row payloads stay `unknown`). */
export interface ChangePlan {
  eventCreates: unknown[];
  eventUpdates: unknown[];
  eventRemoves: unknown[];
  familyCreates: unknown[];
  /** Id-matched household renames. Optional so a plan from an older API (or a
   *  test fixture predating the field) still renders — absent reads as 0. */
  familyUpdates?: unknown[];
  familyRemoves: unknown[];
  guestCreates: unknown[];
  guestUpdates: unknown[];
  guestRemoves: unknown[];
  eventLinkCreates: unknown[];
  eventLinkRemoves: unknown[];
  warnings: string[];
  /** The checklist tasks linked to the events this change removes. Absent when
   *  there are none, and from an API older than run times. */
  linkedTasks?: LinkedTaskPreview[];
}

/** A checklist task linked to an event the change removes, and the time it
 *  would keep (on the removed event's clock) if it stays. */
export interface LinkedTaskPreview {
  id: string;
  title: string;
  eventId: string;
  frozenRunAt: string | null;
  frozenTimezone: string | null;
}

/** What the organiser chose to remove with the change, for its apply body. */
export interface ChangeChoice {
  /** The linked tasks to remove with their events; empty keeps them all. */
  removeLinkedTasks: string[];
  /** The organiser attestation's version, once ticked, for a change that sets
   *  guest addresses on the organiser's word. */
  emailAttestation?: string;
}

/** `POST …/changes/apply`'s body (`ApplyBody` in cire-api's
 *  `schemas/import.ts`). */
export interface ApplyChangeBody {
  changeId: string;
  /** The counts the preview showed, for a save that empties a half. */
  confirmClears?: ClearedHalves;
  /** The linked tasks to remove with their events; absent keeps them all. */
  removeLinkedTasks?: string[];
  /** The organiser attestation's version, for a change that sets guest
   *  addresses on the organiser's word. */
  emailAttestation?: string;
}

/** How many rows an editor save removes from each list it leaves EMPTY
 *  (`clears` on the `changes/preview` response; 0 for a list it keeps). */
export interface ClearedHalves {
  events: number;
  households: number;
}

interface ChangePreviewProps {
  plan: ChangePlan;
  /** Set when the change removes every event or every household. Rendered as
   *  its own warning, above the counts, because a whole list going is not the
   *  kind of thing a diff table row says loudly enough. */
  clears?: ClearedHalves | null;
  /** Impact warnings (RSVP loss on delete/un-invite, claim-code loss on
   *  household delete). Confirm-gated — surfaced but non-blocking. */
  warnings: string[];
  /**
   * How many guest addresses the change sets on the organiser's word
   * (`emailAttestations` on the `changes/preview` response). Above zero the
   * preview shows the attestation, and Confirm waits for its tick.
   */
  emailAttestations?: number;
  /** Apply the previewed change, with what the organiser chose. */
  onConfirm: (choice: ChangeChoice) => void;
  /** Dismiss without applying. */
  onCancel: () => void;
  /** Apply in flight — disables the buttons + relabels Confirm. */
  busy?: boolean;
  /** Confirm-button label (defaults to "Apply changes"). */
  confirmLabel?: string;
}

/**
 * The diff-counts table. Each record type shows its create / update / remove
 * counts; a household "update" is an id-matched rename, and invitations have no
 * update concept so that cell reads 0.
 */
export function PlanCounts(props: { plan: ChangePlan }) {
  const rows = (): { label: string; create: number; update: number; remove: number }[] => [
    {
      label: "events",
      create: props.plan.eventCreates.length,
      update: props.plan.eventUpdates.length,
      remove: props.plan.eventRemoves.length,
    },
    {
      label: "households",
      create: props.plan.familyCreates.length,
      update: props.plan.familyUpdates?.length ?? 0,
      remove: props.plan.familyRemoves.length,
    },
    {
      label: "guests",
      create: props.plan.guestCreates.length,
      update: props.plan.guestUpdates.length,
      remove: props.plan.guestRemoves.length,
    },
    {
      label: "invitations",
      create: props.plan.eventLinkCreates.length,
      update: 0,
      remove: props.plan.eventLinkRemoves.length,
    },
  ];

  return (
    <Table label="Diff counts">
      <thead>
        <tr>
          <Th>
            <span class="sr-only">Record type</span>
          </Th>
          <Th align="end">Create</Th>
          <Th align="end">Update</Th>
          <Th align="end">Remove</Th>
        </tr>
      </thead>
      <tbody>
        <For each={rows()}>
          {(r) => (
            <tr>
              <Td>{r.label}</Td>
              <Td numeric tone="muted">
                {r.create}
              </Td>
              <Td numeric tone="muted">
                {r.update}
              </Td>
              <Td numeric tone="muted">
                {r.remove}
              </Td>
            </tr>
          )}
        </For>
      </tbody>
    </Table>
  );
}

/** The name of a removed event, from the plan's `eventRemoves`. */
function removedEventName(plan: ChangePlan, eventId: string): string {
  for (const removed of plan.eventRemoves) {
    if (
      typeof removed === "object" &&
      removed !== null &&
      (removed as { id?: unknown }).id === eventId
    ) {
      const name = (removed as { name?: unknown }).name;
      if (typeof name === "string") return name;
    }
  }
  return "a removed event";
}

/**
 * The checklist tasks linked to the events a change removes, and the one
 * choice it asks: remove them with their events, or keep them. Kept tasks stay
 * on the checklist at the time they had, marked "event removed"; nothing a
 * revert does brings a removed one back or links a kept one again, which is
 * why it is asked here. Unticked — keep — by default. Controlled, so both the
 * shared preview and the spreadsheet import's own can hold the answer.
 */
export function LinkedTasksChoice(props: {
  plan: ChangePlan;
  tasks: LinkedTaskPreview[];
  remove: boolean;
  onChange: (remove: boolean) => void;
  /** The id of the block, for the apply button's description. */
  id?: string;
}) {
  const count = () => props.tasks.length;
  const noun = () => (count() === 1 ? "task" : "tasks");
  return (
    <Notice tone="warn" id={props.id}>
      <div class="flex flex-col gap-2">
        <p>
          {count() === 1
            ? "This checklist task is linked to an event this change removes:"
            : `These ${count()} checklist tasks are linked to an event this change removes:`}
        </p>
        <ul class="list-disc space-y-0.5 pl-5">
          <For each={props.tasks}>
            {(task) => (
              <li>
                <span>{task.title}</span>
                <span class="text-text-muted"> · {removedEventName(props.plan, task.eventId)}</span>
              </li>
            )}
          </For>
        </ul>
        <label class="text-text text-ui-sm flex items-start gap-2">
          <input
            type="checkbox"
            class="mt-0.5"
            checked={props.remove}
            onChange={(e) => props.onChange(e.currentTarget.checked)}
          />
          <span>{`Also remove ${count() === 1 ? "this task" : `these ${count()} ${noun()}`} from the checklist`}</span>
        </label>
        <p class="text-text-muted text-ui-xs">
          Left unticked, they stay on the checklist at the time they had, marked "event removed".
          Reverting this change does not link them again or bring back any you remove.
        </p>
      </div>
    </Notice>
  );
}

/**
 * The shared preview block: the diff-counts table, the confirm-gated impact
 * warnings, and Confirm / Cancel actions. Both ImportPanel and the guests editor
 * render this so the two save flows are visually identical.
 */
export default function ChangePreview(props: ChangePreviewProps) {
  // The dialog opens with focus on Confirm, so a warning that only sits above
  // it is never read to a screen-reader user before one keypress applies the
  // loss. Tying it to the button as its description is what reaches them.
  const clearsId = createUniqueId();
  const linkedId = createUniqueId();
  const linked = () => props.plan.linkedTasks ?? [];
  const [removeLinked, setRemoveLinked] = createSignal(false);
  const describedBy = () =>
    [props.clears ? clearsId : null, linked().length > 0 ? linkedId : null]
      .filter((id) => id !== null)
      .join(" ") || undefined;
  const [attested, setAttested] = createSignal(false);
  const needsAttestation = () => (props.emailAttestations ?? 0) > 0;
  const choice = (): ChangeChoice => {
    const chosen: ChangeChoice = {
      removeLinkedTasks: removeLinked() ? linked().map((task) => task.id) : [],
    };
    if (needsAttestation() && attested()) {
      chosen.emailAttestation = ORGANISER_EMAIL_ATTESTATION.version;
    }
    return chosen;
  };
  return (
    <div class="border-border bg-bg/40 flex flex-col gap-4 rounded-sm border p-4">
      <h3 class="font-display text-gold-dim text-ui-md">Diff preview</h3>
      <Show when={props.clears}>
        {(clears) => (
          <Notice tone="warn" id={clearsId}>
            <Show when={clears().households > 0}>
              <p>
                This removes every household ({clears().households}), with their guests, RSVPs and
                invite codes.
              </p>
            </Show>
            <Show when={clears().events > 0}>
              <p>This removes every event ({clears().events}), with their invitations and RSVPs.</p>
            </Show>
          </Notice>
        )}
      </Show>
      <PlanCounts plan={props.plan} />

      <Show when={linked().length > 0}>
        <LinkedTasksChoice
          id={linkedId}
          plan={props.plan}
          tasks={linked()}
          remove={removeLinked()}
          onChange={setRemoveLinked}
        />
      </Show>

      <Show when={props.warnings.length > 0}>
        <div class="border-gold/30 bg-gold/[0.06] flex flex-col gap-1.5 rounded-sm border p-3">
          <p class="font-body text-gold text-ui-xs tracking-ui-widest uppercase">
            Before you apply
          </p>
          {/* A real list with the platform's own markers, rather than a flex
              column with a `::before` glyph: a flex item is blockified and
              loses its `::marker`, and a bullet that is generated content is
              read out as content by some screen readers. */}
          <ul class="text-text-muted text-ui-sm list-disc space-y-1 pl-5">
            <For each={props.warnings}>{(w) => <li>{w}</li>}</For>
          </ul>
        </div>
      </Show>

      <Show when={needsAttestation()}>
        <EmailAttestationCheck
          count={props.emailAttestations ?? 0}
          checked={attested()}
          onChange={setAttested}
          disabled={props.busy}
        />
      </Show>

      <div class="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          type="button"
          onClick={() => props.onConfirm(choice())}
          disabled={props.busy || (needsAttestation() && !attested())}
          aria-describedby={describedBy()}
        >
          {props.busy ? "Applying…" : (props.confirmLabel ?? "Apply changes")}
        </Button>
        <Button
          variant="subtle"
          type="button"
          onClick={() => props.onCancel()}
          disabled={props.busy}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
