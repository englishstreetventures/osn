import Button from "@cire/ui/button";
import { Notice } from "@shared/ui/ui/notice";
import { Table, Td, Th } from "@shared/ui/ui/table";
import { createUniqueId, For, Show } from "solid-js";
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
  // The dialog opens with focus on Confirm, so a warning that only sits above
  // it is never read to a screen-reader user before one keypress applies the
  // loss. Tying it to the button as its description is what reaches them.
  const clearsId = createUniqueId();
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

      <div class="flex flex-wrap items-center gap-3">
        <Button
          variant="primary"
          type="button"
          onClick={() => props.onConfirm()}
          disabled={props.busy}
          aria-describedby={props.clears ? clearsId : undefined}
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
