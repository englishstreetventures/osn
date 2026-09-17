import Button from "@cire/ui/button";
import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import { createSignal } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { CIRE_WEB_URL } from "../lib/osn";

/**
 * "Preview invite" button. Provisions (or fetches) the wedding's host preview
 * code via the member-gated `/preview-code` endpoint — any wedding role,
 * including a read-only `viewer`, may mint one, because seeing the invite as a
 * guest sees it is part of the read experience — then opens the guest
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
      const body = (await res.json()) as { publicId: string; slug: string };
      // Path-routed guest site: the wedding lives at `/<slug>`, so the preview
      // opens the CORRECT wedding (not whatever the bare domain resolves to). The
      // `?code=<host preview code>` rides on the path and auto-claims so the host
      // lands straight on the events view.
      const guestUrl = `${CIRE_WEB_URL}/${encodeURIComponent(body.slug)}?code=${encodeURIComponent(body.publicId)}`;
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

  // Sized to the top bar's action row (h-9, matching the palette trigger)
  // rather than to a page button — it lives in the chrome now, and a 44px
  // control there would set the bar's height instead of fitting inside it.
  //
  // Narrow bars get the glyph alone. This used to be hidden outright below
  // `@2xl/frame`, which left the invite preview with NO entry point on a phone
  // — the palette carries no preview command, so the control simply did not
  // exist there. Collapsing to an icon keeps it reachable at every width, and
  // costs the switcher beside it a few characters of truncation rather than a
  // wrapped bar. The label follows the palette trigger's `⌘K` idiom: it is the
  // same element throughout (`sr-only` → `not-sr-only`, never `hidden`), so the
  // accessible name is always the visible wording and never goes missing on the
  // width where nothing is drawn.
  return (
    // `cta`, which is the outline-at-rest, gold-on-hover shape this button was
    // writing out by hand — the same one `InviteBuilder`'s Preview control
    // already uses. The two sat side by side in the same portal with the same
    // job and two hand-written class lists, and they had drifted: this one
    // rested on `border-gold-dim` and `text-gold` where the variant uses the
    // accent and its contrast-checked ink.
    //
    // The class is for what the variant does not decide: the top bar's own
    // height, and a narrower horizontal padding than `sm` gives, because at the
    // narrow width the button is a single glyph. Plain utilities rather than
    // `base:` ones, so they beat the variant's on the same property instead of
    // tying with it and being resolved by stylesheet order.
    <Button
      variant="cta"
      size="sm"
      type="button"
      onClick={() => void preview()}
      disabled={loading()}
      aria-busy={loading()}
      class="h-9 px-2.5 disabled:cursor-default @2xl/frame:px-3.5"
    >
      <span aria-hidden="true" class="text-ui-sm leading-none @2xl/frame:hidden">
        ◎
      </span>
      <span class="sr-only @2xl/frame:not-sr-only">
        {loading() ? "Preparing…" : "Preview invite"}
      </span>
    </Button>
  );
}
