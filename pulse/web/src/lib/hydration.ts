import { createSignal, onMount, sharedConfig, type Accessor } from "solid-js";
import { isServer } from "solid-js/web";

/**
 * False on the server and while the browser hydrates, true once mounted; true
 * at once when the browser renders a page itself (a client-side navigation).
 *
 * For output only the browser can get right, such as anything in the reader's
 * time zone. Hydration keeps the server's text and structure rather than
 * rewriting them, so that output must stay out of the server's HTML, and the
 * first render while hydrating must match what the server wrote.
 */
export function createInBrowser(): Accessor<boolean> {
  if (isServer) return () => false;
  if (!sharedConfig.context) return () => true;
  const [mounted, setMounted] = createSignal(false);
  onMount(() => setMounted(true));
  return mounted;
}
