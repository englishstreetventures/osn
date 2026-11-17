import Button from "@cire/ui/button";
import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import Download from "lucide-solid/icons/download";
import { createSignal } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin, weddingPath } from "../lib/api";
import { downloadBlob } from "../lib/download";
import { haptic } from "../lib/touch-feedback";

/**
 * The portal's one download button: `Button`'s `outline` at `sm`, the 28px
 * pill of a bar's actions, led by the `download` glyph at 14px with its label
 * beside it, as a `LinkPill` leads with its mark. Every page download takes
 * it, so a host sees one control for one job.
 *
 * `compact` is for a row with no room for the word, the RSVP page's phone
 * search row: the word becomes hidden text and the button the bar's icon
 * button (`bar` at `icon`, a 28px circle, its glyph at 16px), as the reply key
 * beside it is drawn. The word stays the button's name, and `data-tip` hands
 * it to the portal's tooltip.
 *
 * `busy` shows `busyLabel` in place of `label` and marks the button
 * `aria-disabled`, which `Button` holds to swallowing the press. Not
 * `disabled`: that would drop the keyboard focus the press left on it.
 */
export function DownloadButton(props: {
  label: string;
  busyLabel?: string;
  busy?: boolean;
  compact?: boolean;
  class?: string;
  onClick: () => void;
}) {
  const text = () => (props.busy && props.busyLabel ? props.busyLabel : props.label);
  return (
    <Button
      variant={props.compact ? "bar" : "outline"}
      size={props.compact ? "icon" : "sm"}
      class={props.class}
      data-tip={props.compact ? text() : undefined}
      aria-disabled={props.busy ? "true" : undefined}
      onClick={() => props.onClick()}
    >
      <Download
        aria-hidden="true"
        strokeWidth={1.75}
        class={props.compact ? "size-4 shrink-0" : "size-3.5 shrink-0"}
      />
      <span class={props.compact ? "sr-only" : undefined}>{text()}</span>
    </Button>
  );
}

/** The wedding's server-built CSV exports, each owner-only (`weddingOwner()`). */
const EXPORTS = {
  events: {
    label: "Download events CSV",
    busy: "Exporting events…",
    done: "Events export downloaded",
    failed: "Events export failed. Try again.",
  },
  guests: {
    label: "Download guests CSV",
    busy: "Exporting guests…",
    done: "Guest list export downloaded",
    failed: "Guest list export failed. Try again.",
  },
  rsvps: {
    label: "Download RSVPs CSV",
    busy: "Exporting RSVPs…",
    done: "RSVP export downloaded",
    failed: "RSVP export failed. Try again.",
  },
  gifts: {
    label: "Download gifts CSV",
    busy: "Exporting gifts…",
    done: "Gift log downloaded",
    failed: "Gift export failed. Try again.",
  },
} as const;

export type CsvExportKind = keyof typeof EXPORTS;

/**
 * A {@link DownloadButton} that fetches one of the wedding's CSV exports,
 * built and formula-sanitised server-side at `GET …/<kind>.csv`, and saves it
 * as `cire-<kind>-<slug>.csv` (the wedding id where no slug is known, as the
 * API's own `Content-Disposition` names it).
 *
 * The API gates every export with `weddingOwner()`, so a call site draws this
 * for an owner alone. One request at a time: a second click while one runs
 * would spend another call from the owner's export rate limit and save the
 * file twice. The outcome goes to a toast, since a failed download is a thing
 * the owner retries; a lapsed session goes to sign-in instead.
 */
export function CsvExportButton(props: {
  weddingId: string;
  weddingSlug?: string;
  kind: CsvExportKind;
  compact?: boolean;
  class?: string;
}) {
  const { authFetch } = useAuth();
  const [busy, setBusy] = createSignal(false);
  const copy = () => EXPORTS[props.kind];

  function failed() {
    haptic("reject");
    toast.error(copy().failed);
  }

  // No second request while one runs: the button is `aria-disabled` until
  // this settles, and `Button` swallows a press on it.
  async function download() {
    setBusy(true);
    try {
      const res = await authFetch(apiUrl(weddingPath(props.weddingId, `/${props.kind}.csv`)));
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) return failed();
      const blob = await res.blob();
      downloadBlob(`cire-${props.kind}-${props.weddingSlug ?? props.weddingId}.csv`, blob);
      toast.success(copy().done);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      failed();
    } finally {
      setBusy(false);
    }
  }

  return (
    <DownloadButton
      label={copy().label}
      busyLabel={copy().busy}
      busy={busy()}
      compact={props.compact}
      class={props.class}
      onClick={() => void download()}
    />
  );
}
