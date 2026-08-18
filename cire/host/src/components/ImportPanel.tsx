import { useAuth } from "@shared/rp-auth/solid";
import type { JSX } from "solid-js";
import { createSignal, Show, For, onMount } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { downloadBlob, downloadCsv } from "../lib/download";
import { invalidateEvents } from "../lib/events-store";
import { invalidateGuests } from "../lib/guests-store";
import { haptic } from "../lib/haptics";
import { invalidateHouseholds } from "../lib/households-store";
import { formatImportError } from "../lib/import-errors";
import type { ImportErrorBody } from "../lib/import-errors";
import { hasSeenImportHelp, markImportHelpSeen } from "../lib/import-help";
import {
  EVENT_REQUIRED_HEADERS,
  EVENT_OPTIONAL_HEADERS,
  GUEST_OPTIONAL_HEADERS,
  GUEST_TEMPLATE_FIXED_HEADERS,
  GUEST_TEMPLATE_EXAMPLE_EVENTS,
  buildEventsTemplateCsv,
  buildGuestsTemplateCsv,
} from "../lib/import-templates";
import ChangeHistory from "./ChangeHistory";
import { PlanCounts } from "./ChangePreview";
import SectionIntro from "./SectionIntro";
import Button from "./ui/Button";
import Field from "./ui/Field";
import Notice from "./ui/Notice";

interface ImportPlan {
  eventCreates: unknown[];
  eventUpdates: unknown[];
  eventRemoves: { id: string; name: string }[];
  familyCreates: { id: string; publicId: string; familyName: string }[];
  familyUpdates?: { id: string; familyName: string }[];
  familyRemoves: { id: string; familyName: string }[];
  guestCreates: { id: string; firstName: string; lastName: string }[];
  guestUpdates: { id: string; lastName: string }[];
  guestRemoves: { id: string; firstName: string }[];
  eventLinkCreates: unknown[];
  eventLinkRemoves: unknown[];
  warnings: string[];
}

/**
 * Which half of the wedding an upload is authoritative over. Mirrors the API's
 * `ChangeScope` (`cire/api/src/schemas/import.ts`) minus its `"both"` arm: this
 * panel now lives INSIDE a module, so it only ever uploads that module's sheet
 * and the other half is left untouched by construction.
 */
export type ImportKind = "events" | "guests";

interface PreviewResponse {
  importId: string;
  plan: ImportPlan;
  warnings: string[];
  scope?: ImportKind | "both";
}

interface ApplyResponse {
  summary: {
    importId: string;
    eventsCreated: number;
    eventsUpdated: number;
    eventsRemoved: number;
    familiesCreated: number;
    familiesUpdated?: number;
    familiesRemoved: number;
    guestsCreated: number;
    guestsUpdated: number;
    guestsRemoved: number;
    warnings: string[];
  };
}

/**
 * The per-sheet copy. Everything that differs between the two panels is here, so
 * the panel body itself is kind-agnostic — the events module gets the events
 * sheet and nothing else, the guests module the guests sheet and nothing else.
 *
 * `scopeHint`'s reassurance ("won't be touched") is the load-bearing half: a
 * one-sheet upload is only safe to reach for if it's obvious the other half
 * survives it.
 */
const KIND: Record<
  ImportKind,
  {
    eyebrow: string;
    title: string;
    description: string;
    /** The file name organisers are told to upload, and the label on the input. */
    fileName: string;
    templateFile: string;
    buildTemplate: () => string;
    templateLabel: string;
    exportLabel: string;
    exportHint: string;
    scopeHint: string;
    /** The JSON key the CSV body is posted under. */
    bodyKey: "eventsCsv" | "guestsCsv";
  }
> = {
  events: {
    eyebrow: "Events",
    title: "Import your events from a spreadsheet",
    description:
      "Upload an events sheet and your schedule is updated to match it. Your guest list isn't touched — though guests are dropped from any event this file removes.",
    fileName: "events.csv",
    templateFile: "cire-events-template.csv",
    buildTemplate: buildEventsTemplateCsv,
    templateLabel: "Download events template",
    exportLabel: "Download current events",
    exportHint:
      "Already have events? Download them in the same format — edit the file and upload it straight back.",
    scopeHint:
      "Events only — your schedule will be updated to match this file. Your guest list won't be touched (though guests are dropped from any event this file removes).",
    bodyKey: "eventsCsv",
  },
  guests: {
    eyebrow: "Guests",
    title: "Import your guest list from a spreadsheet",
    description:
      "Upload a guests sheet and your households, guests, and who's invited to what are updated to match it. Your events aren't touched.",
    fileName: "guests.csv",
    templateFile: "cire-guests-template.csv",
    buildTemplate: buildGuestsTemplateCsv,
    templateLabel: "Download guests template",
    exportLabel: "Download current guests",
    exportHint:
      "Already have guests? Download them in the same format — edit the file and upload it straight back. This is the re-importable guest list, not the RSVP report (that lives under RSVPs, and is for reading replies, not re-uploading).",
    scopeHint:
      "Guests only — your guest list and who's invited to what will be updated to match this file. Your events won't be touched.",
    bodyKey: "guestsCsv",
  },
};

/** The API's per-import payload cap (`cire/api/src/routes/organiser-changes.ts`).
 *  Mirrored so the panel can refuse before reading; the server stays the
 *  authority. */
const ONE_MB = 1 * 1024 * 1024;

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    // A deliberate message rather than `reader.error`: that is a `DOMException`,
    // whose `instanceof Error` result varies by engine — so the catch upstream
    // would surface either a cryptic `NotReadableError` or the generic "Preview
    // failed.", neither of which says the FILE was the problem (deleted, moved,
    // or permission revoked between picking and submitting).
    reader.addEventListener("error", () =>
      reject(
        new Error(
          `${file.name} couldn't be read. It may have been moved or deleted since you chose it — pick it again.`,
        ),
      ),
    );
    reader.readAsText(file);
  });
}

/**
 * The spreadsheet half of a module's edit mode: upload ONE sheet — this module's
 * — preview the diff, apply it. The other half of the wedding is left alone
 * because this panel never sends its key at all (an empty string would read as
 * "an empty sheet", i.e. delete everything).
 *
 * Imports are authorised by the caller's OSN access JWT (attached by authFetch)
 * plus ownership of the wedding named in the path — the organiser picks the
 * target wedding upstream and every import call is scoped to it.
 */
export default function ImportPanel(props: { weddingId: string; kind: ImportKind }) {
  const { authFetch } = useAuth();
  const copy = () => KIND[props.kind];
  // The spreadsheet upload posts through the canonical `changes/*` front door
  // (the CSV body shape `{eventsCsv, guestsCsv}`), same pipeline the editor uses.
  // The legacy `/import/*` alias still serves identically for one release; the
  // portal is now fully on `changes/*` so that alias can be deleted next release
  // (tracked as an open issue in `xchromo/osn`). The preview response echoes
  // `importId`=changeId,
  // so the existing preview/apply reads below are unchanged.
  const importUrl = (op: string) =>
    apiUrl(`/api/organiser/weddings/${props.weddingId}/changes/${op}`);
  const [file, setFile] = createSignal<File | null>(null);
  // A ref so "Remove" can clear the native input's own selection — otherwise the
  // filename stays in the control while our signal says nothing is chosen, and
  // re-picking the same file wouldn't even fire `change`.
  let fileInput: HTMLInputElement | undefined;
  const [busy, setBusy] = createSignal(false);
  const [exporting, setExporting] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [preview, setPreview] = createSignal<PreviewResponse | null>(null);
  const [applied, setApplied] = createSignal<ApplyResponse["summary"] | null>(null);

  async function handlePreview(e: Event) {
    e.preventDefault();
    setError(null);
    setApplied(null);
    setPreview(null);

    const chosen = file();
    if (!chosen) {
      haptic("reject");
      return setError(`Choose a ${copy().fileName} file.`);
    }
    // Refuse an oversized file HERE rather than after reading it (S-L1). The
    // server is still the authority (it 413s on Content-Length, then again on
    // the parsed bytes) — but reaching that answer costs the tab a full read of
    // the file into a JS string plus a `JSON.stringify` of the same bytes again,
    // and then an upload of the result. A `.csv` that is really a database dump
    // or a renamed video stalls the organiser's own browser for all of it. Same
    // wording the 413 would produce, so the limit reads identically wherever it
    // is hit.
    if (chosen.size > ONE_MB) {
      haptic("reject");
      return setError(formatImportError(413, {}));
    }

    setBusy(true);
    try {
      // Send ONLY this module's sheet: the omitted key tells the API this change
      // isn't authoritative over the other half, so it's left untouched. An empty
      // string would instead read as "an empty sheet" — i.e. delete everything —
      // which is exactly the mistake the key omission avoids.
      const csv = await readFile(chosen);
      const res = await authFetch(importUrl("preview"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [copy().bodyKey]: csv }),
      });
      if (!res.ok) {
        // The API locates the bad cell for us (reason + row + column + which
        // sheet); spend all of it, instead of showing the bare `error` string.
        const body = (await res.json().catch(() => ({}))) as ImportErrorBody;
        throw new Error(formatImportError(res.status, body));
      }
      setPreview((await res.json()) as PreviewResponse);
      haptic("commit");
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      haptic("reject");
      setError(err instanceof Error ? err.message : "Preview failed.");
    } finally {
      setBusy(false);
    }
  }

  async function handleApply() {
    const p = preview();
    if (!p) return;
    setError(null);
    setBusy(true);
    try {
      const res = await authFetch(importUrl("apply"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ importId: p.importId }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as ImportErrorBody;
        throw new Error(formatImportError(res.status, body));
      }
      const data = (await res.json()) as ApplyResponse;
      // Fires before the reload below — the tap is the confirmation the write
      // landed, and the page is about to go away and take the toast with it.
      haptic("commit");
      setApplied(data.summary);
      setPreview(null);
      // Deliberately NOT `clearFile()` — that path also drops the applied
      // summary (a summary from a previous upload isn't about a newly chosen
      // file), which is exactly the thing just set on the line above. Reset the
      // control by hand instead.
      setFile(null);
      if (fileInput) fileInput.value = "";
      // An apply can create/update/remove events, so the cached events list for
      // this wedding is now stale — drop it so the Events tab refetches fresh
      // rows on its next mount (rather than reusing the pre-import cache).
      invalidateEvents(props.weddingId);
      // An apply also changes households/guests, so drop the guest cache too
      // (both are lifted to weddingId-keyed stores now — P-I3). The reload below
      // re-mounts every module fresh; invalidating keeps the caches honest even
      // if the reload is ever removed.
      invalidateGuests(props.weddingId);
      // Households are the third of one consistency unit — invalidating two of the
      // three is what leaves a stale household in the editor draft, and a stale
      // household in an id-authoritative draft is a destructive remove+create.
      invalidateHouseholds(props.weddingId);
      window.location.reload();
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      haptic("reject");
      setError(err instanceof Error ? err.message : "Apply failed.");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    haptic("dismiss");
    setPreview(null);
    setApplied(null);
    setError(null);
  }

  /**
   * Point the panel at a different sheet — or at none.
   *
   * The `setPreview(null)` is the load-bearing line, and it belongs to EVERY
   * change of selection, not just to Remove (S-M1). A standing preview holds the
   * `importId` of the plan the server computed for the OLD bytes, and Apply
   * commits that id — so a panel that keeps the diff on screen while the control
   * names a different file is offering to apply the wrong sheet, with a
   * plausible-looking diff above the button. The plan can reconcile away a whole
   * half of the wedding, so "picked the wrong file, re-picked the right one" must
   * not be a way to write the wrong one.
   */
  function selectFile(next: File | null) {
    setFile(next);
    setPreview(null);
    // The applied summary describes the PREVIOUS upload, so it isn't about this
    // file either. (The apply path sets it and resets the control by hand, so it
    // deliberately doesn't come through here.)
    setApplied(null);
    if (next === null && fileInput) fileInput.value = "";
  }

  /** Drop the chosen sheet — both our signal and the native input's selection. */
  function clearFile() {
    haptic("dismiss");
    selectFile(null);
  }

  /**
   * Download the wedding's CURRENT rows as a re-importable sheet (the import
   * template schema, built server-side) — the "export current state" half of the
   * round trip: edit the file in any spreadsheet tool, then upload it back
   * through this panel.
   */
  async function downloadCurrent() {
    // In-flight guard (P-I3): a double-click must not fire duplicate export
    // fetches — same shape as EventTable's export button.
    if (exporting()) return;
    setExporting(true);
    setError(null);
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/export/${props.kind}.csv`),
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      downloadBlob(`cire-export-${props.kind}.csv`, await res.blob());
      haptic("commit");
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      haptic("reject");
      setError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <div class="flex flex-col gap-6">
      <SectionIntro
        eyebrow={copy().eyebrow}
        title={copy().title}
        description={copy().description}
      />

      <div class="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          onClick={() => downloadCsv(copy().templateFile, copy().buildTemplate())}
        >
          {copy().templateLabel}
        </Button>
        {/* Round-trip export: the current data in the same format the import
            reads, so it can be tweaked in a spreadsheet tool and re-uploaded. */}
        <Button variant="quiet" onClick={() => void downloadCurrent()} disabled={exporting()}>
          {copy().exportLabel}
        </Button>
      </div>
      <p class="font-body text-text-muted max-w-prose text-[0.82rem]">{copy().exportHint}</p>

      <CsvFormatHelp kind={props.kind} />

      <form class="flex flex-col gap-4" onSubmit={handlePreview}>
        {/* The chosen-file chip sits OUTSIDE the <label>, not inside it: a
            control nested in a label inherits the label's text as its
            accessible name ("events.csv events.csv" instead of "Remove"), and a
            click on it would also re-open the file picker the label points at. */}
        <div class="flex flex-col gap-1.5">
          {/* `Field` for the label wiring only — the control keeps its own
              `file:` styling rather than taking `Input`'s box, because the part
              a host clicks is the pseudo-element button, not the field. */}
          <Field label={copy().fileName}>
            {(field) => (
              <input
                {...field}
                type="file"
                accept=".csv,text/csv"
                ref={fileInput}
                onChange={(e) => selectFile(e.currentTarget.files?.[0] ?? null)}
                class="font-body text-text file:border-border file:bg-bg file:font-body file:text-text hover:file:border-gold text-[0.82rem] file:mr-3 file:rounded-sm file:border file:px-3 file:py-1.5 file:text-[0.82rem]"
              />
            )}
          </Field>
          <Show when={file()}>
            <span class="flex items-center gap-2">
              <span class="text-text-muted font-mono text-[0.72rem]">{file()?.name}</span>
              <button
                type="button"
                onClick={clearFile}
                class="font-body text-text-muted hover:text-gold text-[0.72rem] underline-offset-4 hover:underline"
              >
                Remove {copy().fileName}
              </button>
            </span>
          </Show>
        </div>

        {/* Say out loud which half the chosen file will touch — the whole point
            of a one-sheet upload is that the other half is safe, and an organiser
            shouldn't have to infer that from zero counts in the diff. */}
        <Show when={file()}>
          <p
            aria-live="polite"
            class="border-border bg-bg/40 text-text-muted rounded-sm border p-3 text-[0.82rem]"
          >
            {copy().scopeHint}
          </p>
        </Show>

        <div class="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="outline" disabled={busy() || file() === null}>
            {busy() ? "Working…" : "Preview"}
          </Button>
          <Show when={preview() || applied() || error()}>
            <button
              type="button"
              onClick={reset}
              disabled={busy()}
              class="font-body text-text-muted text-[0.82rem] underline-offset-4 hover:underline disabled:opacity-40"
            >
              Reset
            </button>
          </Show>
        </div>
      </form>

      <Show when={error()}>
        <Notice tone="error" alert>
          {error()}
        </Notice>
      </Show>

      <Show when={preview()}>
        {(p) => (
          <div class="border-border bg-bg/40 flex flex-col gap-4 rounded-sm border p-4">
            <h3 class="font-display text-gold-ink text-[1.1rem]">Diff preview</h3>
            {/* The reassurance under a destructive confirm is read off the
                SERVER's echoed scope, not off what this panel believes it sent
                (S-L2). Today they cannot disagree — one key goes out, and the API
                derives scope from which keys are present — but "your events won't
                be touched" is the sentence an organiser trusts before applying a
                plan that can reconcile away a whole half of the wedding, and a
                sentence like that should not be a client-side guess. If the
                echoed scope is ever anything but this module's, say so loudly
                rather than reassuring about a half this change does manage. */}
            <Show
              when={p().scope !== undefined && p().scope !== props.kind}
              fallback={<p class="text-text-muted text-[0.82rem]">{copy().scopeHint}</p>}
            >
              <Notice tone="error" alert>
                This change covers more than your {copy().eyebrow.toLowerCase()} — the server
                reports a scope of “{p().scope}”. Check the counts below before applying; nothing is
                saved until you do.
              </Notice>
            </Show>
            <PlanCounts plan={p().plan} />
            <Show when={p().plan.warnings.length > 0}>
              <ul class="text-text-muted flex flex-col gap-1 text-[0.82rem]">
                <For each={p().plan.warnings}>
                  {(w) => <li class="before:mr-2 before:content-['•']">{w}</li>}
                </For>
              </ul>
            </Show>
            <Button variant="primary" class="self-start" onClick={handleApply} disabled={busy()}>
              {busy() ? "Applying…" : "Apply import"}
            </Button>
          </div>
        )}
      </Show>

      <Show when={applied()}>
        {(s) => (
          <div class="border-gold/30 bg-gold/5 text-text flex flex-col gap-2 rounded-sm border p-4 text-[0.88rem]">
            <p class="font-display text-gold-ink text-[1.1rem]">Applied</p>
            <p class="text-text-muted font-mono text-[0.72rem]">{s().importId}</p>
            <p>
              events: +{s().eventsCreated} / ~{s().eventsUpdated} / -{s().eventsRemoved} · families:
              +{s().familiesCreated} / ~{s().familiesUpdated ?? 0} / -{s().familiesRemoved} ·
              guests: +{s().guestsCreated} / ~{s().guestsUpdated} / -{s().guestsRemoved}
            </p>
          </div>
        )}
      </Show>

      <ChangeHistory weddingId={props.weddingId} />
    </div>
  );
}

/**
 * A column-name chip. `required` (mandatory) columns read in `gold-ink` on a
 * gold-tinted, gold-bordered ground; optional ones stay muted on the plain page
 * ground. Two things this deliberately does NOT do:
 *
 * - Reach for `--gold` or `--gold-dim`. Both are *metal* — ornament, rules, the
 *   `gilt-rule` — and neither carries a text-contrast contract: `--gold-dim` is
 *   `--gold` at ~30% alpha (barely there on `bg`), and `--gold` itself measures
 *   ~2.4:1 in the light ramp. `--gold-ink` is the readable variant, held to
 *   4.5:1 over `bg` and `surface` in every ramp by `styles/tokens.test.ts`. The
 *   mandatory chips were the least readable text in the panel while being the
 *   one thing an organiser must not misread.
 * - Rely on colour alone (WCAG 1.4.1). The required chips carry a trailing `*`
 *   and an `sr-only` "(mandatory)", so the distinction survives greyscale, a
 *   colour-vision deficiency, and a screen reader alike. {@link KeyLegend} shows
 *   the same marked-up chip so the key and the chips are the same object.
 */
function Col(props: { children: string; required?: boolean }) {
  return (
    <code
      class="rounded-[2px] border px-1.5 py-0.5 font-mono text-[0.74rem]"
      classList={{
        "text-gold-ink bg-gold/12 border-gold/45": props.required === true,
        "text-text-muted bg-bg/60 border-border": props.required !== true,
      }}
    >
      {props.children}
      <Show when={props.required === true}>
        <span aria-hidden="true">*</span>
        <span class="sr-only"> (mandatory)</span>
      </Show>
    </code>
  );
}

/**
 * The mandatory-vs-optional key — a small labelled legend tying the look of the
 * column chips to "mandatory" vs "optional". Rendered **once** at the top of
 * step 2, above the sheet's column list.
 */
function KeyLegend() {
  return (
    <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[0.78rem]">
      <span class="font-body text-gold text-[0.66rem] tracking-[0.18em] uppercase">Key</span>
      <span class="text-text-muted flex items-center gap-1.5">
        <Col required>Aa</Col> indicates mandatory fields
      </span>
      <span class="text-text-muted flex items-center gap-1.5">
        <Col>Aa</Col> indicates optional fields
      </span>
    </div>
  );
}

/**
 * A collapsible "Formatting tips" aside — the deep, per-field guidance (timestamp
 * shape, IANA timezone, palette syntax, attendance tokens) lives behind a native
 * <details>/<summary> so the default sheet view stays short and scannable and the
 * nitty-gritty is one click away. Gold-accented to match the rest of the panel,
 * keyboard- and screen-reader-accessible with no JS.
 */
function FormattingTips(props: { children: JSX.Element }) {
  return (
    <details class="border-gold/25 bg-gold/[0.06] group/tips rounded-sm border">
      <summary class="font-display text-gold-ink flex cursor-pointer list-none items-center gap-2 p-3 text-[0.95rem] select-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden">
        <span
          class="text-gold inline-block not-italic transition-transform group-open/tips:rotate-90"
          aria-hidden
        >
          ›
        </span>
        Formatting tips
      </summary>
      <div class="flex flex-col gap-3 px-3.5 pt-1 pb-3.5">{props.children}</div>
    </details>
  );
}

/** The numbered circle that leads each step card. */
function StepBadge(props: { n: number }) {
  return (
    <span class="border-gold/50 text-gold flex h-6 w-6 shrink-0 items-center justify-center rounded-full border font-mono text-[0.78rem]">
      {props.n}
    </span>
  );
}

/**
 * A 2-row illustration of the per-event invite columns — the part organisers
 * trip on. Two guests in one family with `yes` cells under named event columns
 * and a blank ("—") for a guest not invited to that event.
 */
function MiniMatrix() {
  return (
    <div class="border-border/70 overflow-hidden rounded-[3px] border">
      <table class="w-full border-collapse font-mono text-[0.7rem]">
        <thead>
          <tr class="bg-bg/50 text-gold-ink">
            <th class="px-2 py-1 text-left font-normal">Name</th>
            <th class="px-2 py-1 text-center font-normal">Ceremony</th>
            <th class="px-2 py-1 text-center font-normal">Reception</th>
          </tr>
        </thead>
        <tbody class="text-text-muted">
          <tr class="border-border/50 border-t">
            <td class="text-text px-2 py-1">Linh</td>
            <td class="text-gold-ink px-2 py-1 text-center">yes</td>
            <td class="text-gold-ink px-2 py-1 text-center">yes</td>
          </tr>
          <tr class="border-border/50 border-t">
            <td class="text-text px-2 py-1">Minh</td>
            <td class="text-gold-ink px-2 py-1 text-center">yes</td>
            <td class="px-2 py-1 text-center">—</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

/** A step card: numbered badge + serif title, then the step body. */
function StepCard(props: { n: number; title: string; children: JSX.Element }) {
  return (
    <li class="border-border bg-surface/30 flex flex-col gap-3 rounded-sm border p-4">
      <div class="flex items-center gap-2.5">
        <StepBadge n={props.n} />
        <h3 class="font-display text-text text-[1.05rem]">{props.title}</h3>
      </div>
      {props.children}
    </li>
  );
}

/**
 * The Events-sheet guidance: the required/optional column chips followed by the
 * format rules. Every rule mirrors the cire-api parser
 * (`cire/api/src/services/spreadsheet.ts`): the local wall-clock Start/End
 * format, the IANA Timezone that says which clock they're on, the http(s)
 * Pinterest/Maps URLs, and the
 * `Name:#hex|Name:#hex` dress-code palette the parser splits on `|`.
 */
function EventsGuidance() {
  return (
    <div class="flex flex-col gap-3">
      <p class="text-text-muted text-[0.8rem]">One row per event.</p>
      <ul class="flex flex-wrap gap-1.5">
        <For each={EVENT_REQUIRED_HEADERS}>
          {(h) => (
            <li>
              <Col required>{h}</Col>
            </li>
          )}
        </For>
        <For each={EVENT_OPTIONAL_HEADERS}>
          {(h) => (
            <li>
              <Col>{h}</Col>
            </li>
          )}
        </For>
      </ul>

      <FormattingTips>
        <dl class="flex flex-col gap-2.5 text-[0.78rem]">
          <div class="flex flex-col gap-0.5">
            <dt class="text-text">Timestamps</dt>
            <dd class="text-text-muted">
              <Col required>Start</Col> and <Col>End</Col> as{" "}
              <span class="text-text font-mono">YYYY-MM-DDTHH:MM</span> — e.g.{" "}
              <span class="text-text font-mono">2026-11-14T15:00</span> is 3 pm on 14 Nov 2026. Give
              the LOCAL time; the <Col required>Timezone</Col> column says which clock it's on, so
              there's no UTC offset to work out. Leave <Col>End</Col> blank for an open-ended event
              — the invite shows just the start time.
            </dd>
          </div>
          <div class="flex flex-col gap-0.5">
            <dt class="text-text">Venue</dt>
            <dd class="text-text-muted">
              The invite's "Where" and its map link come from <Col>Address</Col>. A{" "}
              <Col>Location</Col> venue name fills in when <Col>Address</Col> is blank.
            </dd>
          </div>
          <div class="flex flex-col gap-0.5">
            <dt class="text-text">Timezone</dt>
            <dd class="text-text-muted">
              An{" "}
              <a
                href="https://en.wikipedia.org/wiki/List_of_tz_database_time_zones"
                target="_blank"
                rel="noreferrer"
                class="text-gold-ink underline-offset-2 hover:underline"
              >
                IANA
              </a>{" "}
              name, e.g. <span class="text-text font-mono">Australia/Sydney</span>.
            </dd>
          </div>
          <div class="flex flex-col gap-0.5">
            <dt class="text-text">URLs</dt>
            <dd class="text-text-muted">
              <Col>Pinterest URL</Col> and <Col>Maps URL</Col> as full links (e.g.{" "}
              <span class="text-text font-mono">https://www.pinterest.com/...</span>).
            </dd>
          </div>
          <div class="flex flex-col gap-0.5">
            <dt class="text-text">Dress code palette</dt>
            <dd class="text-text-muted">
              <Col>Dress Code Palette</Col> as{" "}
              <span class="text-text font-mono">DisplayName:#RGB</span>, e.g.{" "}
              <span class="text-text font-mono">Blush:#f4c2c2</span>. Separate swatches with{" "}
              <span class="text-text font-mono">|</span>.
            </dd>
          </div>
        </dl>
      </FormattingTips>
    </div>
  );
}

/**
 * The Guests-sheet guidance: the four fixed required columns, the one-column-per-
 * event convention (with a {@link MiniMatrix} worked example), and the
 * guests-specific rules. Mirrors the parser: required columns are
 * `REQUIRED_GUEST_COLUMNS`, households group by repeating the same Family Name,
 * and an event cell is truthy on `yes`/`true`/`1`/`x` (blank ⇒ not invited).
 */
function GuestsGuidance() {
  return (
    <div class="flex flex-col gap-3">
      <p class="text-text-muted text-[0.8rem]">One row per guest.</p>
      <ul class="flex flex-wrap gap-1.5">
        <For each={GUEST_TEMPLATE_FIXED_HEADERS}>
          {(h) => (
            <li>
              <Col required>{h}</Col>
            </li>
          )}
        </For>
      </ul>
      <p class="text-text-muted text-[0.78rem]">
        Then <strong class="text-text">one column per event</strong>, named exactly after an event.
      </p>
      <p class="text-text-muted text-[0.78rem]">Optional:</p>
      <ul class="flex flex-wrap gap-1.5">
        <For each={GUEST_OPTIONAL_HEADERS}>
          {(h) => (
            <li>
              <Col>{h}</Col>
            </li>
          )}
        </For>
      </ul>
      <MiniMatrix />

      <FormattingTips>
        <dl class="flex flex-col gap-2.5 text-[0.78rem]">
          <div class="flex flex-col gap-0.5">
            <dt class="text-text">One row per guest</dt>
            <dd class="text-text-muted">Don't combine a couple onto one line.</dd>
          </div>
          <div class="flex flex-col gap-0.5">
            <dt class="text-text">Group a household</dt>
            <dd class="text-text-muted">
              Repeat the same <Col required>Family Name</Col> to group guests — they claim &amp;
              RSVP together.
            </dd>
          </div>
          <div class="flex flex-col gap-0.5">
            <dt class="text-text">Event attendance</dt>
            <dd class="text-text-muted">
              Mark an invited guest's event column <span class="text-text font-mono">yes</span> (or{" "}
              <span class="text-text font-mono">true</span> /{" "}
              <span class="text-text font-mono">1</span> /{" "}
              <span class="text-text font-mono">x</span>); leave it{" "}
              <span class="text-text">blank</span> if not invited.
            </dd>
          </div>
          <div class="flex flex-col gap-0.5">
            <dt class="text-text">Guest Nickname (optional)</dt>
            <dd class="text-text-muted">
              When a code has just <strong class="text-text">one</strong> guest, their invite greets
              them by name (&ldquo;Dear Chi&rdquo;). Set a <Col>Guest Nickname</Col> to greet them
              by that instead of their first name. Ignored for multi-guest households (they're
              greeted as a family).
            </dd>
          </div>
        </dl>
      </FormattingTips>
    </div>
  );
}

/**
 * "How to structure your sheet" — a three-step visual guide that mirrors the
 * cire-api parser (`cire/api/src/services/spreadsheet.ts`). The steps follow the
 * natural flow a non-technical couple takes: ① grab the template, ② fill in the
 * details, ③ upload, preview, and apply. A native <details>/<summary> keeps the
 * whole guide keyboard- and screen-reader-accessible.
 *
 * **It opens itself exactly once.** The first time an organiser meets an import
 * panel the guide is expanded and glowing, because a first upload without it is
 * a 422; from the second time on it starts collapsed, because by then it sits
 * between the organiser and the file picker. The bit is stored in `localStorage`
 * (see `lib/import-help.ts`) and marked on mount, so the "first time" survives a
 * reload rather than re-firing on every visit. The glow is dropped the moment
 * the disclosure is touched — it is an invitation to read, not an ornament.
 */
function CsvFormatHelp(props: { kind: ImportKind }) {
  // Read ONCE, at construction: `open` on a <details> is an initial state, not a
  // binding, and re-reading it after the mount marks the bit would slam the guide
  // shut under an organiser who had just opened it.
  const firstTime = !hasSeenImportHelp();
  const [touched, setTouched] = createSignal(false);

  onMount(() => {
    if (firstTime) markImportHelpSeen();
  });

  return (
    <details
      open={firstTime}
      class="border-border bg-bg/30 group rounded-sm border"
      classList={{ "attention-glow": firstTime && !touched() }}
    >
      {/* The summary's own click — NOT the details' `toggle` — is what counts as
          "touched". Setting `open` programmatically fires `toggle` too, so a
          toggle listener would call the guide touched at the very moment it
          opened itself and the glow would never paint. A click covers the
          keyboard path as well: Enter/Space on a focused summary IS a click. */}
      <summary
        onClick={() => setTouched(true)}
        class="font-body text-text hover:text-gold flex cursor-pointer items-center gap-2 px-4 py-3 text-[0.88rem] transition select-none"
      >
        <span class="text-gold inline-block transition-transform group-open:rotate-90" aria-hidden>
          ›
        </span>
        How to structure your sheet — CSV format
      </summary>

      <div class="border-border/60 flex flex-col gap-5 border-t px-4 py-5">
        <ol class="auto-grid items-start [--auto-grid-min:17rem]">
          <StepCard n={1} title="New here?">
            <p class="text-text-muted text-[0.8rem]">
              Download the starter template above — it has the correct headers and example rows, so
              you can fill in your details and re-upload.
            </p>
            <Show when={props.kind === "guests"}>
              <p class="text-text-muted text-[0.76rem]">
                In the guests template, rename the <Col>{GUEST_TEMPLATE_EXAMPLE_EVENTS[0]}</Col> /{" "}
                <Col>{GUEST_TEMPLATE_EXAMPLE_EVENTS[1]}</Col> columns to your real event names.
              </p>
            </Show>
          </StepCard>

          <StepCard n={2} title="Fill in your details">
            <p class="text-text-muted text-[0.8rem]">The key shows which fields are mandatory.</p>
            <KeyLegend />
            <Show when={props.kind === "events"} fallback={<GuestsGuidance />}>
              <EventsGuidance />
            </Show>
          </StepCard>

          <StepCard n={3} title="Upload & preview">
            <Show
              when={props.kind === "events"}
              fallback={
                <p class="text-text-muted text-[0.8rem]">
                  This sheet is authoritative for your guest list — households, guests, and who's
                  invited to what are reconciled to match it. Your events aren't touched.
                </p>
              }
            >
              <p class="text-text-muted text-[0.8rem]">
                This sheet is authoritative for your schedule — events are reconciled to match it.
                Your guest list isn't touched.
              </p>
            </Show>
            <Show when={props.kind === "guests"}>
              <p class="text-text-muted text-[0.76rem]">
                Adding a new event that guests need inviting to? Do{" "}
                <strong class="text-text">events first</strong>, then guests — each guest's event
                columns are matched to events that already exist, so the events sheet has to go in
                before the guests sheet.
              </p>
            </Show>
            <p class="text-text-muted text-[0.76rem]">
              <span class="text-text">Preview</span> shows a diff of what will change; nothing is
              saved until you <span class="text-text">Apply</span>.
            </p>
          </StepCard>
        </ol>
      </div>
    </details>
  );
}
