import { createUniqueId, For, Show } from "solid-js";

import { lockedExportFor, type LockedExport as LockedExportSpec } from "../lib/locked-exports";
import { isModuleLocked, MODULE_NAV } from "../lib/module-nav";
import type { Tier } from "../lib/tiers";
import LockedExport, { createModuleRowsProbe } from "./LockedExport";

/** The files this tier's locked modules offer, in nav order. */
function lockedExports(tier: Tier): LockedExportSpec[] {
  const specs: LockedExportSpec[] = [];
  for (const mod of MODULE_NAV) {
    const spec = isModuleLocked(mod.id, tier) ? lockedExportFor(mod.id) : undefined;
    if (spec) specs.push(spec);
  }
  return specs;
}

/**
 * Every locked module's download, listed in Settings for an owner.
 *
 * The same downloads sit on the locked nav cards, one per card, behind a press
 * on a row that otherwise opens an upgrade offer. This list puts every one of
 * them in one place in the page's own tab order, where an owner looking for
 * the wedding's data finds them without opening a locked row.
 *
 * Asks for the row counts only when the tier locks a module that has a file,
 * and shows nothing until one of them has rows (or the count could not be
 * read).
 */
export default function LockedModuleDownloads(props: {
  weddingId: string;
  weddingSlug: string;
  tier: Tier;
}) {
  const specs = () => lockedExports(props.tier);
  return (
    <Show when={specs().length > 0}>
      <Downloads weddingId={props.weddingId} weddingSlug={props.weddingSlug} specs={specs()} />
    </Show>
  );
}

function Downloads(props: { weddingId: string; weddingSlug: string; specs: LockedExportSpec[] }) {
  // Read once: the list belongs to one wedding for its whole life.
  const probe = createModuleRowsProbe(props.weddingId);
  const offered = () => props.specs.filter((spec) => probe.offered(spec));
  const headingId = createUniqueId();

  return (
    <Show when={offered().length > 0}>
      <section aria-labelledby={headingId} class="border-border flex flex-col gap-2 border-t pt-5">
        <h3 id={headingId} class="font-display text-text text-ui-md leading-tight font-light">
          Download what you entered
        </h3>
        <p class="font-body text-text-muted text-ui-sm leading-snug">
          Your plan no longer opens these modules. Nothing you entered in them has been deleted.
        </p>
        <For each={offered()}>
          {(spec) => (
            <LockedExport
              weddingId={props.weddingId}
              weddingSlug={props.weddingSlug}
              spec={spec}
              probe={probe}
            />
          )}
        </For>
      </section>
    </Show>
  );
}
