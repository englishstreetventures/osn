// The open wedding's "its seats may have changed" count, shared from the
// Dashboard's push socket with the views that show the seats. Frontend code:
// no Effect.
import { type Accessor, createContext, useContext } from "solid-js";

/**
 * Goes up by one each time the open wedding's socket says its seats may have
 * changed: a `members-changed` signal, or a reconnect, after which a change
 * may have landed unseen. A view that shows the seats reads it and asks again
 * on each change. With no provider, as in a view rendered on its own, it stays
 * at zero and nothing asks again.
 */
export const MembersChangedContext = createContext<Accessor<number>>(() => 0);

export const useMembersChanged = (): Accessor<number> => useContext(MembersChangedContext);
