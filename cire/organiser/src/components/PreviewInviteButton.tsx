import { useAuth } from "@osn/client/solid";
import { createSignal } from "solid-js";
import { toast } from "solid-toast";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { CIRE_WEB_URL } from "../lib/osn";

/**
 * "Preview invite" button. Provisions (or fetches) the wedding's host preview
 * code via the owner-gated `/preview-code` endpoint, then opens the guest
 * invite in a new tab with `?code=<publicId>` so the organiser sees every
 * event exactly as a guest would. The host code is preview-only — the API
 * blocks it from submitting RSVPs.
 */
export default function PreviewInviteButton(props: { weddingId: string }) {
  const { authFetch } = useAuth();
  const [loading, setLoading] = createSignal(false);

  async function preview() {
    if (loading()) return;
    setLoading(true);

    // Open the tab *synchronously*, inside the click gesture, before any await.
    // Mobile browsers only honour window.open while the user activation is
    // live; opening it after the awaited fetch (as we used to) loses the gesture
    // and the popup gets blocked. We open it blank now and navigate it once the
    // host code comes back.
    //
    // We deliberately do NOT pass "noopener" in the features arg: per the HTML
    // spec that makes window.open return null, so we'd lose the handle we need
    // to navigate the tab. Instead we null `win.opener` immediately — same
    // security posture as rel="noopener" (the new tab can't reach back into the
    // organiser via window.opener) while keeping a usable reference.
    const win = window.open("", "_blank");
    if (win) win.opener = null;

    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/preview-code`),
        { method: "POST" },
      );
      if (res.status === 401) {
        win?.close();
        redirectToLogin();
        return;
      }
      if (!res.ok) {
        win?.close();
        toast.error("Could not open a preview. Please try again.");
        return;
      }
      const body = (await res.json()) as { publicId: string };
      const guestUrl = `${CIRE_WEB_URL}/?code=${encodeURIComponent(body.publicId)}`;
      if (win) {
        win.location.href = guestUrl;
      } else {
        // Popup blocked / unavailable — fall back to a same-tab navigation so
        // the organiser still reaches the preview instead of a dead button.
        window.location.assign(guestUrl);
      }
    } catch (err) {
      win?.close();
      if (isAuthExpired(err)) {
        redirectToLogin();
        return;
      }
      toast.error("Could not open a preview. Is the API running?");
    } finally {
      setLoading(false);
    }
  }

  return (
    <button
      type="button"
      onClick={() => void preview()}
      disabled={loading()}
      aria-busy={loading()}
      class="border-gold font-body text-gold hover:bg-gold hover:text-bg min-h-11 rounded-sm border bg-transparent px-5 py-2.5 text-[0.82rem] tracking-[0.12em] uppercase transition-colors duration-200 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {loading() ? "Preparing…" : "Preview invite"}
    </button>
  );
}
