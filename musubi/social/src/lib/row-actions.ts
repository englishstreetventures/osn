import { createSignal } from "solid-js";

import { scopeMark, type PageRead } from "./page-cache";

/**
 * The row actions of a list read through the page cache (`DESIGN.md` §Empty
 * states and failed loads, §Busy buttons).
 *
 * A list shown again is read again behind its rows, so a row on screen may be
 * gone. An action is busy from its press, waits for any read of its list that
 * is out, and runs only if its row is still there: nobody acts on a row the
 * read removes. One row's action leaves the other rows alone, and a second
 * press of the same one does nothing while it runs.
 */
export function createRowActions() {
  const [running, setRunning] = createSignal<ReadonlySet<string>>(new Set());

  /** Whether the action named `key` (say `accept:bob`) is running. */
  const busy = (key: string) => running().has(key);

  /**
   * Runs `action` for `key` once `list` has no read out and `present` finds
   * its row in it. `action` gets the scope mark taken at the press, for
   * `update`.
   */
  async function run<T>(
    key: string,
    list: PageRead<T>,
    present: (rows: T) => boolean,
    action: (mark: number) => Promise<void>,
  ): Promise<void> {
    if (running().has(key)) return;
    setRunning((keys) => new Set(keys).add(key));
    try {
      const mark = scopeMark();
      const rows = await list.settled();
      if (rows === undefined || !present(rows)) return;
      await action(mark);
    } finally {
      setRunning((keys) => {
        const next = new Set(keys);
        next.delete(key);
        return next;
      });
    }
  }

  return { busy, run };
}
