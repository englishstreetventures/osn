/**
 * Headers `subscribe()` sets on the request it hands the hub. The hub trusts
 * them because only a product Worker can reach it through its binding, and
 * `subscribe()` builds that request fresh instead of forwarding the browser's
 * headers — so a browser cannot set either one.
 */
export const HUB_TOPIC_HEADER = "x-realtime-topic";
export const HUB_SUBJECT_HEADER = "x-realtime-subject";
