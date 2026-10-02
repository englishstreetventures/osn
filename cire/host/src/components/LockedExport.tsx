import Button from "@cire/ui/button";
import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import { createSignal, onMount, Show } from "solid-js";

import { isAuthExpired, redirectToLogin } from "../lib/api";
import { haptic } from "../lib/haptics";
import {
  downloadLockedExport,
  fetchModuleRows,
  type LockedExport as LockedExportSpec,
  LockedExportError,
} from "../lib/locked-exports";
import { ensureModuleRowsLoaded, moduleRowsAccessor } from "../lib/module-rows-store";

/** A refusal that means the session is gone, in either form it arrives in. */
const sessionExpired = (err: unknown): boolean =>
  isAuthExpired(err) || (err instanceof LockedExportError && err.status === 401);

/**
 * The download a locked Budget, Checklist or Registry card offers its owner.
 *
 * The module is shut below Gold, reads included, but the rows the couple
 * entered are theirs, and the API hands them back as CSV at any tier.
 * This asks how many there are (once per wedding — see `module-rows-store.ts`)
 * and offers the file only when there is something in it.
 *
 * If the count cannot be read, the download is offered anyway, without a
 * number: a failed count must not hide the couple's only way back to their
 * rows, and the worst the file can be is a header with nothing under it.
 *
 * Mounted inside the card's content, which exists only while the card is open,
 * so the count is asked for when an owner opens the card and not before.
 */
export default function LockedExport(props: {
  weddingId: string;
  weddingSlug: string;
  spec: LockedExportSpec;
}) {
  const { authFetch } = useAuth();
  const [countFailed, setCountFailed] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  onMount(() => {
    const weddingId = props.weddingId;
    ensureModuleRowsLoaded(weddingId, () => fetchModuleRows(authFetch, weddingId)).catch(
      (err: unknown) => {
        if (sessionExpired(err)) return redirectToLogin();
        setCountFailed(true);
      },
    );
  });

  /** The rows in this module's file, or `null` while unknown. */
  const count = (): number | null =>
    moduleRowsAccessor(props.weddingId)()?.[props.spec.count] ?? null;

  const offered = () => {
    const n = count();
    return n === null ? countFailed() : n > 0;
  };

  const sentence = () => {
    const n = count();
    if (n === null) return "Anything you entered before is still here.";
    const noun = n === 1 ? props.spec.noun.one : props.spec.noun.many;
    return `Your ${n} ${noun} ${n === 1 ? "is" : "are"} still here.`;
  };

  // Reports through toasts, like the other downloads: a failed download is a
  // transient thing the couple retries, not a view that stays broken.
  const download = async () => {
    if (busy()) return;
    setBusy(true);
    try {
      await downloadLockedExport(authFetch, props.weddingId, props.weddingSlug, props.spec);
      toast.success(`${props.spec.label} downloaded`);
    } catch (err) {
      if (sessionExpired(err)) return redirectToLogin();
      haptic("reject");
      toast.error(`${props.spec.label} download failed. Try again.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Show when={offered()}>
      <div class="border-border mt-1 flex flex-col gap-2 border-t pt-3">
        <p class="text-text-muted text-ui-sm leading-snug">{sentence()}</p>
        <Button variant="quiet" size="sm" type="button" disabled={busy()} onClick={download}>
          {busy() ? "Downloading…" : "Download as CSV"}
        </Button>
      </div>
    </Show>
  );
}
