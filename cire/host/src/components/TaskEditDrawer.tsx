import Button from "@cire/ui/button";
import { Field } from "@shared/ui/ui/field";
import { Modal } from "@shared/ui/ui/modal";
import { Notice } from "@shared/ui/ui/notice";
import { Select } from "@shared/ui/ui/select";
import { createMemo, createUniqueId, For, Show } from "solid-js";

import { TIMEFRAME_BUCKETS } from "../lib/checklist-buckets";
import { type HostSeat, seatName } from "../lib/hosts-store";
import type { TaskRow } from "../lib/tasks-store";
import { ROLE_COPY } from "../lib/wedding-roles";

interface TaskEditDrawerProps {
  /** The task being edited, or `null` while the drawer is shut. */
  task: TaskRow | null;
  /** The wedding's seats, or `null` until they have loaded. */
  seats: HostSeat[] | null;
  /** The seats could not be loaded, so there is nobody to offer. */
  seatsFailed: boolean;
  /** A write is out. The select says so and stays usable: a pick made
   *  meanwhile is written once that write is back. */
  busy: boolean;
  /** Why the last write was refused, shown inside the drawer. */
  error: string | null;
  /** Hand the task to a seat, or to nobody (`null`). Shows at once. */
  onAssign: (task: TaskRow, hostId: string | null) => void;
  onClose: () => void;
}

/**
 * One checklist task's details, in a drawer opened from its row. Each field
 * saves itself the moment it changes, the way a co-host's role select does, so
 * the drawer has nothing to submit: a field added later brings its own write
 * and needs no form around the ones already here.
 *
 * Kept mounted and driven by `task`, so the exit animates; the last task shown
 * stays in it while the drawer slides away.
 */
export default function TaskEditDrawer(props: TaskEditDrawerProps) {
  const titleId = createUniqueId();
  const shown = createMemo<TaskRow | null>((prev) => props.task ?? prev, null);
  const bucketLabel = (key: string) => TIMEFRAME_BUCKETS.find((b) => b.key === key)?.label ?? key;
  // The seat select's value: the holder when they are among the seats offered,
  // otherwise nobody — a seat that has since gone holds nothing on the server.
  const holder = createMemo(() => {
    const id = shown()?.assignedHostId;
    return id && props.seats?.some((s) => s.hostId === id) ? id : "";
  });
  // The options go by seat id, not by seat object: a re-read of the seats
  // then keeps every option still offered, so the selected one stays
  // selected. Replaced, the browser would show the first option instead,
  // whoever holds the task.
  const seatIds = createMemo(() => (props.seats ?? []).map((s) => s.hostId));
  const seatById = createMemo(() => new Map((props.seats ?? []).map((s) => [s.hostId, s])));

  return (
    <Modal
      open={props.task !== null}
      onClose={props.onClose}
      labelledBy={titleId}
      presentation="drawer"
      class="max-w-md"
    >
      <div class="mb-6 flex items-center justify-between">
        <h2 id={titleId} class="font-display text-text text-ui-lg font-light">
          Edit task
        </h2>
        <Button variant="bare" size="icon" type="button" onClick={props.onClose} aria-label="Close">
          ✕
        </Button>
      </div>

      <Show when={shown()}>
        {(task) => (
          <div class="flex flex-col gap-5">
            <div class="flex flex-col gap-1">
              <p class="text-text text-ui-base">{task().title}</p>
              <p class="text-text-muted text-ui-sm">
                {bucketLabel(task().timeframeBucket)}
                <Show when={task().dueAt}> · due {task().dueAt}</Show>
              </p>
            </div>

            <Show when={props.error}>
              <Notice tone="danger" alert>
                {props.error}
              </Notice>
            </Show>
            <Show when={props.seatsFailed}>
              <Notice tone="danger" alert>
                Couldn't load the people on this wedding. Close this and try again.
              </Notice>
            </Show>

            <Field
              label="Assigned to"
              hint="Anyone on this wedding can hold a task, helpers included. An open task nobody holds shows “Needs an owner”."
            >
              {(field) => (
                <Select
                  {...field}
                  value={holder()}
                  // Never disabled for a write: a disabled control drops the
                  // keyboard focus of whoever is arrowing through it.
                  disabled={props.seats === null}
                  aria-busy={props.busy || undefined}
                  onChange={(e) => props.onAssign(task(), e.currentTarget.value || null)}
                >
                  <option value="">Nobody yet</option>
                  <For each={seatIds()}>
                    {(id) => {
                      // An id leaves `seatIds` in the same update as its seat
                      // leaves `seatById`, so the seat is there while its option is.
                      const seat = () => seatById().get(id)!;
                      return (
                        <option value={id}>
                          {seatName(seat())} · {ROLE_COPY[seat().role].label}
                        </option>
                      );
                    }}
                  </For>
                </Select>
              )}
            </Field>

            <div class="flex justify-end">
              <Button variant="outline" type="button" onClick={props.onClose}>
                Done
              </Button>
            </div>
          </div>
        )}
      </Show>
    </Modal>
  );
}
