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
 * counts; families + invitations have no "update" concept so those cells read 0.
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
      update: 0,
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
    <table class="font-body w-full border-collapse text-[0.88rem]">
      <thead>
        <tr>
          <th class="border-border text-gold border-b px-3 py-2 text-left text-[0.72rem] font-normal tracking-[0.1em] uppercase">
            <span class="sr-only">Record type</span>
          </th>
          <th class="border-border text-gold border-b px-3 py-2 text-right text-[0.72rem] font-normal tracking-[0.1em] uppercase">
            Create
          </th>
          <th class="border-border text-gold border-b px-3 py-2 text-right text-[0.72rem] font-normal tracking-[0.1em] uppercase">
            Update
          </th>
          <th class="border-border text-gold border-b px-3 py-2 text-right text-[0.72rem] font-normal tracking-[0.1em] uppercase">
            Remove
          </th>
        </tr>
      </thead>
      <tbody>
        <For each={rows()}>
          {(r) => (
            <tr>
              <td class="border-border text-text border-b px-3 py-2">{r.label}</td>
              <td class="border-border text-text-muted border-b px-3 py-2 text-right font-mono">
                {r.create}
              </td>
              <td class="border-border text-text-muted border-b px-3 py-2 text-right font-mono">
                {r.update}
              </td>
              <td class="border-border text-text-muted border-b px-3 py-2 text-right font-mono">
                {r.remove}
              </td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
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
      <h3 class="font-display text-gold-dim text-[1.1rem]">Diff preview</h3>
      <PlanCounts plan={props.plan} />

      <Show when={props.warnings.length > 0}>
        <div class="border-gold/30 bg-gold/[0.06] flex flex-col gap-1.5 rounded-sm border p-3">
          <p class="font-body text-gold text-[0.66rem] tracking-[0.18em] uppercase">
            Before you apply
          </p>
          <ul class="text-text-muted flex flex-col gap-1 text-[0.82rem]">
            <For each={props.warnings}>
              {(w) => <li class="before:mr-2 before:content-['•']">{w}</li>}
            </For>
          </ul>
        </div>
      </Show>

      <div class="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => props.onConfirm()}
          disabled={props.busy}
          class="border-gold bg-gold font-body text-bg hover:bg-gold-dim rounded-sm border px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
        >
          {props.busy ? "Applying…" : (props.confirmLabel ?? "Apply changes")}
        </button>
        <button
          type="button"
          onClick={() => props.onCancel()}
          disabled={props.busy}
          class="font-body text-text-muted text-[0.82rem] underline-offset-4 hover:underline disabled:opacity-40"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
