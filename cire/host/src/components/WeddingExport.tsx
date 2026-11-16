import Button, { proseLinkClass } from "@cire/ui/button";
import { cardClass } from "@cire/ui/card";
import Loading from "@cire/ui/loading";
import { useAuth } from "@shared/rp-auth/solid";
import { Notice } from "@shared/ui/ui/notice";
import { createUniqueId, For, Show } from "solid-js";

import { followInApp, type InAppLink } from "../lib/link-click";
import { haptic } from "../lib/touch-feedback";
import {
  type ArchiveFailure,
  formatBytes,
  startWeddingArchive,
  weddingArchiveState,
} from "../lib/wedding-archive";
import SectionIntro from "./SectionIntro";

const PANEL_CLASS = `${cardClass({ padding: "lg" })} gap-6`;
const hintClass = "font-body text-text-muted text-ui-sm leading-ui-snug";

/** What the archive holds, as its own `README.txt` says it. */
const CONTENTS = [
  "The wedding's settings",
  "Every guest, with their household's code and invitations, and every household",
  "The schedule, and every reply to each event",
  "The seating plans in use, and every other seating plan",
  "The gift list, and what guests gave",
  "The budget and its payments, the checklist and the vendor list",
  "The invitation's words, look and questions",
  "The pictures on the invitation, the schedule and the gift list, and the spreadsheets you uploaded",
  "The schedule and guest list in the form Cire imports them, to set the wedding up again",
] as const;

/** What went wrong, and what to do about it. Nothing is retried for the owner:
 *  the button is the retry. */
const FAILURE_COPY = {
  forbidden:
    "Only an owner can download the whole wedding. If your access has changed, reload the page.",
  notFound:
    "Cire can't find this wedding. If it was deleted, restore it from your wedding list, then download it.",
  limit: "Too many downloads for now. Try again later.",
  server: "Cire couldn't put the download together. Try again.",
  network: "Couldn't reach Cire. Check your connection and try again.",
  cut: "The download stopped before it finished, so nothing was saved. Try again.",
} as const satisfies Record<ArchiveFailure, string>;

/** The saved state's name: what an end-to-end flow waits for. */
const READY_NAME = "Wedding downloaded";

/**
 * What anyone but an owner is told in place of the download: only an owner can
 * take it, so ask one. On the dashboard the owners are listed under Co-hosts;
 * a helper's seat cannot open it, and is offered no way there.
 */
export function OwnerOnlyNote(props: { coHosts?: InAppLink }) {
  return (
    <Notice tone="info" size="sm" class="max-w-prose">
      Only an owner can download the whole wedding. Ask one of its owners for a copy
      <Show when={props.coHosts} fallback=".">
        {(link) => (
          <>
            ; you&apos;ll find them under{" "}
            <a href={link().href} class={proseLinkClass()} onClick={followInApp(link())}>
              Co-hosts
            </a>
            .
          </>
        )}
      </Show>
    </Notice>
  );
}

/**
 * Settings → Export: the whole wedding as one ZIP, for an owner, at every tier.
 *
 * The button keeps its name in every state, so it is found the same way to
 * start a download and to take another. While one runs it stays where it is,
 * locked with `aria-disabled` rather than `disabled`, so the focus on it is not
 * dropped; beside it, the bytes come in, for the eye only, or a screen reader
 * would read the count at every chunk. Under it, `Loading`'s line pulses until
 * the first byte and after, as every loader in the portal does. The saved state
 * sits in a live region mounted with the page, since one inserted with its
 * words is read unreliably; a failure is an alert in answer to the press.
 */
export default function WeddingExport(props: {
  weddingId: string;
  weddingSlug: string;
  /** An owner? Anyone else is told to ask one, and offered no download. */
  canManage: boolean;
  /** Where the owners are listed, for anyone else. */
  coHosts?: InAppLink;
}) {
  const { authFetch } = useAuth();
  const contentsId = createUniqueId();
  // Read once: the page belongs to one wedding for its whole life.
  const state = weddingArchiveState(props.weddingId);

  const preparing = () => {
    const s = state();
    return s.phase === "preparing" ? s : undefined;
  };
  const ready = () => {
    const s = state();
    return s.phase === "ready" ? s : undefined;
  };
  const failure = () => {
    const s = state();
    return s.phase === "failed" ? s.reason : undefined;
  };

  // A press while one runs is swallowed by `aria-disabled`, and the store
  // starts nothing while one runs.
  async function start() {
    await startWeddingArchive(authFetch, props.weddingId, props.weddingSlug);
    if (failure()) haptic("reject");
  }

  return (
    <div class={PANEL_CLASS}>
      <SectionIntro
        title="Download the whole wedding"
        description="Everything this wedding holds in Cire, in one ZIP file of spreadsheets and pictures that open without Cire. It works on every plan."
      />

      <Show when={props.canManage} fallback={<OwnerOnlyNote coHosts={props.coHosts} />}>
        <div class="flex flex-col items-start">
          <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button
              variant="primary"
              type="button"
              aria-disabled={preparing() ? "true" : undefined}
              onClick={start}
            >
              Download wedding
            </Button>
            {/* The count, for the eye: a reader hears the state once, below. */}
            <Show when={preparing()?.received}>
              {(received) => (
                <span class={hintClass} aria-hidden="true" data-numeric>
                  {formatBytes(received())} so far
                </span>
              )}
            </Show>
          </div>

          <Show when={preparing()}>
            <div class="mt-3 flex flex-col gap-1">
              <Loading label="Preparing your download…" />
              <p class={hintClass}>With many pictures it can take a minute.</p>
            </div>
          </Show>

          {/* oxlint-disable jsx-a11y/prefer-tag-over-role -- `<output>` is
              form-associated and means the result of a calculation; this is a
              region saying the download was saved (as `@cire/ui`'s `Loading`). */}
          <div
            role="status"
            aria-label={ready() ? READY_NAME : undefined}
            class="flex w-full max-w-prose flex-col items-start"
          >
            <Show when={ready()}>
              {(saved) => (
                <Notice tone="success" size="sm" class="mt-3">
                  Downloaded{" "}
                  <span class="font-ui-mono [overflow-wrap:anywhere]">{saved().fileName}</span> (
                  <span data-numeric>{formatBytes(saved().size)}</span>).
                </Notice>
              )}
            </Show>
          </div>
          {/* oxlint-enable jsx-a11y/prefer-tag-over-role */}

          <Show when={failure()}>
            {(reason) => (
              <Notice tone="danger" size="sm" alert class="mt-3 max-w-prose">
                {FAILURE_COPY[reason()]}
              </Notice>
            )}
          </Show>
        </div>
      </Show>

      <section aria-labelledby={contentsId} class="border-border flex flex-col gap-3 border-t pt-5">
        <h3 id={contentsId} class="font-display text-text text-ui-md leading-ui-tight font-light">
          What&apos;s in it
        </h3>
        <ul class="font-body text-text-muted text-ui-sm leading-ui-normal flex max-w-prose list-disc flex-col gap-1 pl-5">
          <For each={CONTENTS}>{(line) => <li>{line}</li>}</For>
        </ul>
        <p class="font-body text-text-muted text-ui-sm leading-ui-normal max-w-prose">
          A file named <span class="font-ui-mono">manifest.json</span> lists every file and says why
          any were left out. Messages with vendors are not included. It holds your guests&apos;
          details, so keep it somewhere private.
        </p>
      </section>
    </div>
  );
}
