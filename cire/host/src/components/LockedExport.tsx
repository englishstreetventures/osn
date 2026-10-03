import Button from "@cire/ui/button";
import { useAuth } from "@shared/rp-auth/solid";
import { toast } from "@shared/toast";
import { createSignal, createUniqueId, onMount, Show } from "solid-js";

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

/** What a locked module's download needs to know about its rows. */
export interface ModuleRowsProbe {
  /** Rows in the module's file, or `null` while unknown. */
  count: (spec: LockedExportSpec) => number | null;
  /** Offer the file: it has rows, or its rows could not be counted. */
  offered: (spec: LockedExportSpec) => boolean;
}

/**
 * Ask how many rows the wedding's locked-module files hold, once per wedding
 * (see `module-rows-store.ts`). Call it in a component's setup: it reads the
 * auth context and asks on mount.
 *
 * If the count cannot be read, every file is offered anyway, without a number:
 * a failed count must not hide the couple's only way back to their rows, and
 * the worst a file can be is a header with nothing under it.
 */
export function createModuleRowsProbe(weddingId: string): ModuleRowsProbe {
  const { authFetch } = useAuth();
  const [failed, setFailed] = createSignal(false);

  onMount(() => {
    ensureModuleRowsLoaded(weddingId, () => fetchModuleRows(authFetch, weddingId)).catch(
      (err: unknown) => {
        if (sessionExpired(err)) return redirectToLogin();
        setFailed(true);
      },
    );
  });

  const count = (spec: LockedExportSpec): number | null =>
    moduleRowsAccessor(weddingId)()?.[spec.count] ?? null;

  return {
    count,
    offered: (spec) => {
      const n = count(spec);
      return n === null ? failed() : n > 0;
    },
  };
}

/**
 * The download for one locked module: a sentence saying what is kept, and a
 * button that saves the file. Shown on the module's locked nav card and in
 * Settings (`LockedModuleDownloads`), which is the one a keyboard reaches.
 *
 * The module is shut below its tier, reads included, but the rows the couple
 * entered are theirs, and the API hands them back as CSV at any tier. Renders
 * nothing until the count says there is something to take.
 */
export default function LockedExport(props: {
  weddingId: string;
  weddingSlug: string;
  spec: LockedExportSpec;
  /** A probe the caller already holds, so a list of downloads asks once. */
  probe?: ModuleRowsProbe;
}) {
  const { authFetch } = useAuth();
  // Read once: a download belongs to one wedding for its whole life.
  const probe = props.probe ?? createModuleRowsProbe(props.weddingId);
  const [busy, setBusy] = createSignal(false);
  const sentenceId = createUniqueId();

  const sentence = () => {
    const n = probe.count(props.spec);
    if (n === null) return `Anything in ${props.spec.place} is still here.`;
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
    <Show when={probe.offered(props.spec)}>
      <div class="border-border mt-1 flex flex-col gap-2 border-t pt-3">
        <p id={sentenceId} class="text-text-muted text-ui-sm leading-snug">
          {sentence()}
        </p>
        {/* Described by the sentence, so a screen reader hears which file
            the button saves where several sit together. */}
        <Button
          variant="quiet"
          size="sm"
          type="button"
          disabled={busy()}
          aria-describedby={sentenceId}
          onClick={download}
        >
          {busy() ? "Downloading…" : "Download as CSV"}
        </Button>
      </div>
    </Show>
  );
}
