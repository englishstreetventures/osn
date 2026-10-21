import { useAuth } from "@shared/rp-auth/solid";
import { Notice } from "@shared/ui/ui/notice";
import { createEffect, createSignal, For, on, onMount, Show } from "solid-js";

import { isAuthExpired, redirectToLogin } from "../lib/api";
import { useMembersChanged } from "../lib/members-changed";
import {
  ensureRunSheetLoaded,
  fetchRunSheet,
  rereadRunSheet,
  RunSheetError,
  runSheetAccessor,
} from "../lib/run-sheet-store";
import { useTasksChanged } from "../lib/tasks-changed";
import { type Tier, tierAtLeast } from "../lib/tiers";
import type { WeddingRole } from "../lib/wedding-roles";
import PanelLoading from "./PanelLoading";

/**
 * The run sheet's props, final: the module shell and a helper's seat both
 * mount it with these, and the component tests render it with them.
 */
export interface RunSheetViewProps {
  /** The wedding, fixed for the view's life. */
  weddingId: string;
  /** The wedding's plan tier: below Gold the run sheet is not offered, and no
   *  request is sent. */
  tier: Tier;
  /** The reader's role on the wedding. Not named `role`: on a JSX element
   *  that reads as an ARIA role. */
  callerRole: WeddingRole;
  /** An owner or editor, who sets times on the checklist. */
  canEdit: boolean;
  /** Open the Checklist, where times are set. Absent for a helper. */
  onOpenChecklist?: () => void;
}

/**
 * PLACEHOLDER until the designer's view lands (englishstreetventures/osn#1396,
 * the UI brief in the branch plan): it loads the run sheet through its cache,
 * re-reads on both push signals and lists the rows plainly, so the module and
 * a helper's seat work end to end. The designed view replaces the markup; the
 * props and the data path stay.
 */
export default function RunSheetView(props: RunSheetViewProps) {
  const { authFetch } = useAuth();
  const sheet = runSheetAccessor(props.weddingId);
  const [failure, setFailure] = createSignal<number | null>(null);
  const offered = () => tierAtLeast(props.tier, "gold");

  const fetcher = () => fetchRunSheet(authFetch, props.weddingId);
  const settle = (load: Promise<boolean>) =>
    load.then(
      () => setFailure(null),
      (err: unknown) => {
        if (isAuthExpired(err)) return redirectToLogin();
        setFailure(err instanceof RunSheetError ? err.status : 0);
      },
    );

  onMount(() => {
    if (offered()) void settle(ensureRunSheetLoaded(props.weddingId, fetcher));
  });
  const tasksChanged = useTasksChanged();
  const membersChanged = useMembersChanged();
  createEffect(
    on(
      [tasksChanged, membersChanged],
      () => {
        if (offered()) void settle(rereadRunSheet(props.weddingId, fetcher));
      },
      { defer: true },
    ),
  );

  return (
    <Show
      when={offered() && failure() !== 402}
      fallback={
        <p class="font-body text-text-muted text-ui-sm">
          The run sheet isn't available for this wedding.
        </p>
      }
    >
      <Show
        when={failure() === null}
        fallback={<Notice tone="warn">Couldn't load the run sheet.</Notice>}
      >
        <Show when={sheet()} fallback={<PanelLoading />}>
          {(day) => (
            <ol class="font-body text-text text-ui-sm flex flex-col gap-1">
              <For each={day().items}>
                {(item) => (
                  <li data-run-sheet-item={item.id} data-kind={item.kind}>
                    {item.kind === "event" ? item.name : item.title}
                  </li>
                )}
              </For>
            </ol>
          )}
        </Show>
      </Show>
    </Show>
  );
}
