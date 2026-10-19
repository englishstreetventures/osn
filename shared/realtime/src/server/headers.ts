/**
 * Headers `subscribe()` sets on the request it hands the hub. The hub trusts
 * them because only a product Worker can reach it through its binding, and
 * `subscribe()` builds that request fresh instead of forwarding the browser's
 * headers — so a browser cannot set either one.
 */
export const HUB_TOPIC_HEADER = "x-realtime-topic";
export const HUB_SUBJECT_HEADER = "x-realtime-subject";

/**
 * Set by the hub on the 101 it answers when the newcomer's arrival hit a cap:
 * `topic` (the newcomer itself is closed with 1008) or `subject` (the member's
 * least recently seen other socket was). `subscribe()` reads it to count the
 * refusal in the product Worker, where logs and metrics run; the hub has
 * neither. The browser can read it too, and learns only its own outcome.
 */
export const HUB_CAPACITY_HEADER = "x-realtime-capacity";
export type HubCapacity = "topic" | "subject";
