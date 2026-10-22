// Setting a checklist task's time on the day from its row. Frontend code: no
// Effect.
import { apiUrl, isAuthExpired, weddingPath } from "./api";
import {
  beginTaskWrite,
  peekCachedTasks,
  readTaskRow,
  setCachedTasks,
  type TaskRow,
  type TaskWire,
} from "./tasks-store";

/**
 * A task's whole run time, as `PATCH …/tasks/:taskId` takes it in `runTime`
 * (`RunTimePatch` in cire-api's `schemas/tasks.ts`); `null` makes it untimed.
 *  - `fixed`: a date and time (`YYYY-MM-DDTHH:MM`) in `timezone`, unlinked;
 *  - `offset`: linked to `eventId`, `offsetMinutes` from its start (negative
 *    before it, within a day);
 *  - `clock`: linked to `eventId` at a date and time on the event's clock,
 *    which the API turns into an offset from the event's start.
 */
export type RunTimePatch =
  | { kind: "fixed"; at: string; timezone: string }
  | { kind: "offset"; eventId: string; offsetMinutes: number }
  | { kind: "clock"; eventId: string; at: string };

/** Why a run time was not saved. `not_saved`: the API answered without the
 *  task's time, so it is older than run times and ignored the field. */
export type RunTimeRefusal =
  | "not_saved"
  | "event_not_in_wedding"
  | "out_of_range"
  | "signed_out"
  | "failed";

export type RunTimeSaveResult = { ok: true; task: TaskRow } | { ok: false; reason: RunTimeRefusal };

type AuthFetch = (input: string, init?: RequestInit) => Promise<Response>;

/** What a 422's `error` code says went wrong. */
function refusalOf(error: unknown): RunTimeRefusal {
  switch (error) {
    case "event_not_in_wedding":
      return "event_not_in_wedding";
    case "run_time_out_of_range":
      return "out_of_range";
    default:
      return "failed";
  }
}

/**
 * Save a task's run time, as one of the portal's own task writes: no read the
 * server answered from before it lands on the checklist or the run sheet, and
 * both read again once it ends. The answer replaces the cached row. Never
 * throws: a signed-out answer is `signed_out`, for the caller to send the
 * organiser to sign in.
 */
export async function saveTaskRunTime(
  authFetch: AuthFetch,
  weddingId: string,
  taskId: string,
  runTime: RunTimePatch | null,
): Promise<RunTimeSaveResult> {
  const done = beginTaskWrite(weddingId);
  try {
    const res = await authFetch(
      apiUrl(weddingPath(weddingId, `/tasks/${encodeURIComponent(taskId)}`)),
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runTime }),
      },
    );
    if (res.status === 401) return { ok: false, reason: "signed_out" };
    if (!res.ok) {
      if (res.status !== 422) return { ok: false, reason: "failed" };
      const refused = (await res.json().catch(() => ({}))) as { error?: unknown };
      return { ok: false, reason: refusalOf(refused.error) };
    }
    const { task } = (await res.json()) as { task: TaskWire };
    if (!("anchored" in task)) return { ok: false, reason: "not_saved" };
    const saved = readTaskRow(task);
    const rows = peekCachedTasks(weddingId);
    if (rows)
      setCachedTasks(
        weddingId,
        rows.map((t) => (t.id === saved.id ? saved : t)),
      );
    return { ok: true, task: saved };
  } catch (err) {
    return { ok: false, reason: isAuthExpired(err) ? "signed_out" : "failed" };
  } finally {
    done();
  }
}
