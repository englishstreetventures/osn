import Button from "@cire/ui/button";
import { Table, Td, Th } from "@shared/ui/ui/table";
import { For, Show } from "solid-js";
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
}

interface ChangePreviewProps {
  plan: ChangePlan;
  /** Impact warnings (RSVP loss on delete/un-invite, claim-code loss on
   *  household delete). Confirm-gated — surfaced but non-blocking. */
  warnings: string[];
  /** Apply the previewed change. */
  onConfirm: () => void;
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

/**
 * The shared preview block: the diff-counts table, the confirm-gated impact
 * warnings, and Confirm / Cancel actions. Both ImportPanel and the guests editor
 * render this so the two save flows are visually identical.
 */
export default function ChangePreview(props: ChangePreviewProps) {
  return (
    <div class="border-border bg-bg/40 flex flex-col gap-4 rounded-sm border p-4">
      <h3 class="font-display text-gold-dim text-ui-md">Diff preview</h3>
      <PlanCounts plan={props.plan} />

      <Show when={props.warnings.length > 0}>
        <div class="border-gold/30 bg-gold/[0.06] flex flex-col gap-1.5 rounded-sm border p-3">
          <p class="font-body text-gold text-ui-xs tracking-ui-widest uppercase">
            Before you apply
          </p>
          <ul class="text-text-muted text-ui-sm flex flex-col gap-1">
            <For each={props.warnings}>
              {(w) => <li class="before:mr-2 before:content-['•']">{w}</li>}
            </For>
          </ul>
        </div>
      </Show>

      <div class="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          type="button"
          onClick={() => props.onConfirm()}
          disabled={props.busy}
          class="hover:bg-gold-dim transition"
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
