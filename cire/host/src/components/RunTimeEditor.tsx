import type { EventRow } from "../lib/events-store";
import type { TaskRow } from "../lib/tasks-store";

/**
 * The run-time editor's props, final: `ChecklistView` mounts it on each row for
 * an owner or editor, and the component tests render it with them.
 */
export interface RunTimeEditorProps {
  /** The wedding, fixed for the editor's life. */
  weddingId: string;
  /** The task, live: a save keeps the row, so this is read, never captured. */
  task: TaskRow;
  /** The wedding's events, or `null` until they load. */
  events: readonly EventRow[] | null;
  /** A write of this task is out. */
  disabled?: boolean;
}

/**
 * PLACEHOLDER until the designer's popover lands (englishstreetventures/osn#1396,
 * the UI brief in the branch plan). Not mounted anywhere yet; it saves through
 * `saveTaskRunTime` in `lib/run-time-write.ts`.
 */
export default function RunTimeEditor(_props: RunTimeEditorProps) {
  return null;
}
