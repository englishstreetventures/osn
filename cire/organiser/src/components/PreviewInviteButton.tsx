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
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/preview-code`),
        { method: "POST" },
      );
      if (res.status === 401) {
        redirectToLogin();
        return;
      }
      if (!res.ok) {
        toast.error("Could not open a preview. Please try again.");
        return;
      }
      const body = (await res.json()) as { publicId: string };
      window.open(
        `${CIRE_WEB_URL}/?code=${encodeURIComponent(body.publicId)}`,
        "_blank",
        "noopener",
      );
    } catch (err) {
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
      class="border-gold font-body text-gold hover:bg-gold hover:text-bg rounded-sm border bg-transparent px-5 py-2.5 text-[0.82rem] tracking-[0.12em] uppercase transition-colors duration-200 disabled:cursor-default disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {loading() ? "Preparing…" : "Preview invite"}
    </button>
  );
}
