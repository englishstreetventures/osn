// The open wedding's "its tasks may have changed" count, shared from the
// Dashboard's push socket with the views that show tasks. Frontend code: no
// Effect.
import { type Accessor, createContext, useContext } from "solid-js";

/**
 * Goes up by one each time the open wedding's socket says its tasks may have
 * changed: a `tasks-changed` signal, or a reconnect, after which a change may
 * have landed unseen. The Dashboard has already marked the cached tasks stale
 * by then; a mounted view that shows tasks reads it and asks again. With no
 * provider, as in a view rendered on its own, it stays at zero and nothing
 * asks again.
 */
export const TasksChangedContext = createContext<Accessor<number>>(() => 0);

export const useTasksChanged = (): Accessor<number> => useContext(TasksChangedContext);
