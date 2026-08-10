import { createSignal } from "solid-js";

/** Shared signal for toggling the create-event form from the Header. */
const [showCreateForm, setShowCreateForm] = createSignal(false);

export { showCreateForm, setShowCreateForm };
