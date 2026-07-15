import { useAuth } from "@osn/client/solid";
import type { JSX } from "solid-js";
import { createSignal, createUniqueId, Show, For } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { downloadBlob, downloadCsv } from "../lib/download";
import { invalidateEvents } from "../lib/events-store";
import { invalidateGuests } from "../lib/guests-store";
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

interface ImportPlan {
  eventCreates: unknown[];
  eventUpdates: unknown[];
  eventRemoves: { id: string; name: string }[];
  familyCreates: { id: string; publicId: string; familyName: string }[];
  familyRemoves: { id: string; familyName: string }[];
  guestCreates: { id: string; firstName: string; lastName: string }[];
  guestUpdates: { id: string; lastName: string }[];
  guestRemoves: { id: string; firstName: string }[];
  eventLinkCreates: unknown[];
  eventLinkRemoves: unknown[];
  warnings: string[];
}

interface PreviewResponse {
  importId: string;
  plan: ImportPlan;
  warnings: string[];
}

interface ApplyResponse {
  summary: {
    importId: string;
    eventsCreated: number;
    eventsUpdated: number;
    eventsRemoved: number;
    familiesCreated: number;
    familiesRemoved: number;
    guestsCreated: number;
    guestsUpdated: number;
    guestsRemoved: number;
    warnings: string[];
  };
}

function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.addEventListener("error", () => reject(reader.error ?? new Error("read failed")));
    reader.readAsText(file);
  });
}

/**
 * Imports are authorised by the caller's OSN access JWT (attached by authFetch)
 * plus ownership of the wedding named in the path — the organiser picks the
 * target wedding upstream and every import call is scoped to it.
 */
export default function ImportPanel(props: { weddingId: string }) {
  const { authFetch } = useAuth();
  // The spreadsheet upload posts through the canonical `changes/*` front door
  // (the CSV body shape `{eventsCsv, guestsCsv}`), same pipeline the editor uses.
  // The legacy `/import/*` alias still serves identically for one release; the
  // portal is now fully on `changes/*` so that alias can be deleted next release
  // (see cire wiki/todo/api.md). The preview response echoes `importId`=changeId,
  // so the existing preview/apply reads below are unchanged.
  const importUrl = (op: string) =>
    apiUrl(`/api/organiser/weddings/${props.weddingId}/changes/${op}`);
  const [eventsFile, setEventsFile] = createSignal<File | null>(null);
  const [guestsFile, setGuestsFile] = createSignal<File | null>(null);
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

    const events = eventsFile();
    const guests = guestsFile();
    if (!events) return setError("Choose an events.csv file.");
    if (!guests) return setError("Choose a guests.csv file.");

    setBusy(true);
    try {
      const [eventsCsv, guestsCsv] = await Promise.all([readFile(events), readFile(guests)]);
      const res = await authFetch(importUrl("preview"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ eventsCsv, guestsCsv }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Preview failed (${res.status})`);
      }
      setPreview((await res.json()) as PreviewResponse);
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
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
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Apply failed (${res.status})`);
      }
      const data = (await res.json()) as ApplyResponse;
      setApplied(data.summary);
      setPreview(null);
      setEventsFile(null);
      setGuestsFile(null);
      // An apply can create/update/remove events, so the cached events list for
      // this wedding is now stale — drop it so the Events tab refetches fresh
      // rows on its next mount (rather than reusing the pre-import cache).
      invalidateEvents(props.weddingId);
      // An apply also changes households/guests, so drop the guest cache too
      // (both are lifted to weddingId-keyed stores now — P-I3). The reload below
      // re-mounts every module fresh; invalidating keeps the caches honest even
      // if the reload is ever removed.
      invalidateGuests(props.weddingId);
      window.location.reload();
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError(err instanceof Error ? err.message : "Apply failed.");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setPreview(null);
    setApplied(null);
    setError(null);
  }

  /**
   * Download the wedding's CURRENT events/guests as a re-importable sheet (the
   * import template schema, built server-side) — the "export current state"
   * half of the round trip: edit the file in any spreadsheet tool, then upload
   * it back through this panel.
   */
  async function downloadCurrent(kind: "events" | "guests") {
    // In-flight guard (P-I3): a double-click must not fire duplicate export
    // fetches — same shape as EventTable's export button.
    if (exporting()) return;
    setExporting(true);
    setError(null);
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/export/${kind}.csv`),
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      downloadBlob(`cire-export-${kind}.csv`, await res.blob());
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError(err instanceof Error ? err.message : "Export failed.");
    } finally {
      setExporting(false);
    }
  }

  return (
    <details open class="border-border bg-surface/30 group/import rounded-sm border open:pb-6">
      <summary class="flex cursor-pointer flex-col gap-1 p-6 select-none [&::-webkit-details-marker]:hidden">
        <span class="flex items-center justify-between gap-3">
          <span class="font-body text-gold text-[0.72rem] tracking-[0.2em] uppercase">
            Spreadsheet Import
          </span>
          <span
            class="font-body text-text-muted group-open/import:text-gold flex items-center gap-1.5 text-[0.72rem] tracking-[0.1em] uppercase transition"
            aria-hidden
          >
            <span class="group-open/import:hidden">Open</span>
            <span class="hidden group-open/import:inline">Close</span>
            <span class="inline-block transition-transform group-open/import:rotate-90">›</span>
          </span>
        </span>
        <span class="font-display text-text text-[1.4rem] font-light italic">
          Upload events &amp; guests CSV
        </span>
        <span class="font-body text-text-muted text-[0.82rem]">
          Import your two sheets as CSV — events first, then guests. Start from a template below, or
          read the format guide if you're building your own.
        </span>
      </summary>

      <div class="flex flex-col gap-6 px-6">
        <div class="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => downloadCsv("cire-events-template.csv", buildEventsTemplateCsv())}
            class="border-gold/40 font-body text-gold hover:border-gold hover:bg-gold/10 rounded-sm border px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition"
          >
            Download events template
          </button>
          <button
            type="button"
            onClick={() => downloadCsv("cire-guests-template.csv", buildGuestsTemplateCsv())}
            class="border-gold/40 font-body text-gold hover:border-gold hover:bg-gold/10 rounded-sm border px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition"
          >
            Download guests template
          </button>
        </div>

        {/* Round-trip export: the current data in the same format the import
            reads, so it can be tweaked in a spreadsheet tool and re-uploaded. */}
        <div class="flex flex-wrap items-center gap-3">
          <span class="font-body text-text-muted text-[0.82rem]">
            Already imported? Download your current data in the same format — edit it and upload it
            straight back. This is the re-importable guest list, not the RSVP report (that lives on
            the Guests tab, and is for reading replies, not re-uploading).
          </span>
          <button
            type="button"
            onClick={() => void downloadCurrent("events")}
            disabled={exporting()}
            class="border-border font-body text-text-muted hover:border-gold hover:text-gold rounded-sm border px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
          >
            Download current events
          </button>
          <button
            type="button"
            onClick={() => void downloadCurrent("guests")}
            disabled={exporting()}
            class="border-border font-body text-text-muted hover:border-gold hover:text-gold rounded-sm border px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
          >
            Download current guests
          </button>
        </div>

        <CsvFormatHelp />

        <form class="flex flex-col gap-4" onSubmit={handlePreview}>
          <div class="grid grid-cols-1 gap-4 md:grid-cols-2">
            <label class="flex flex-col gap-1.5">
              <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
                events.csv
              </span>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => setEventsFile(e.currentTarget.files?.[0] ?? null)}
                class="font-body text-text file:border-border file:bg-bg file:font-body file:text-text hover:file:border-gold text-[0.82rem] file:mr-3 file:rounded-sm file:border file:px-3 file:py-1.5 file:text-[0.82rem]"
              />
              <Show when={eventsFile()}>
                <span class="text-text-muted font-mono text-[0.72rem]">{eventsFile()?.name}</span>
              </Show>
            </label>

            <label class="flex flex-col gap-1.5">
              <span class="font-body text-text-muted text-[0.72rem] tracking-[0.1em] uppercase">
                guests.csv
              </span>
              <input
                type="file"
                accept=".csv,text/csv"
                onChange={(e) => setGuestsFile(e.currentTarget.files?.[0] ?? null)}
                class="font-body text-text file:border-border file:bg-bg file:font-body file:text-text hover:file:border-gold text-[0.82rem] file:mr-3 file:rounded-sm file:border file:px-3 file:py-1.5 file:text-[0.82rem]"
              />
              <Show when={guestsFile()}>
                <span class="text-text-muted font-mono text-[0.72rem]">{guestsFile()?.name}</span>
              </Show>
            </label>
          </div>

          <div class="flex flex-wrap items-center gap-3">
            <button
              type="submit"
              disabled={busy()}
              class="border-gold bg-gold/10 font-body text-gold hover:bg-gold/20 rounded-sm border px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
            >
              {busy() ? "Working…" : "Preview"}
            </button>
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
          <p class="border-error/20 bg-error/5 text-error rounded-sm border p-4 text-[0.88rem]">
            {error()}
          </p>
        </Show>

        <Show when={preview()}>
          {(p) => (
            <div class="border-border bg-bg/40 flex flex-col gap-4 rounded-sm border p-4">
              <h3 class="font-display text-gold-dim text-[1.1rem] italic">Diff preview</h3>
              <PlanCounts plan={p().plan} />
              <Show when={p().plan.warnings.length > 0}>
                <ul class="text-text-muted flex flex-col gap-1 text-[0.82rem]">
                  <For each={p().plan.warnings}>
                    {(w) => <li class="before:mr-2 before:content-['•']">{w}</li>}
                  </For>
                </ul>
              </Show>
              <button
                type="button"
                onClick={handleApply}
                disabled={busy()}
                class="border-gold bg-gold font-body text-bg hover:bg-gold-dim self-start rounded-sm border px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition disabled:opacity-40"
              >
                {busy() ? "Applying…" : "Apply import"}
              </button>
            </div>
          )}
        </Show>

        <Show when={applied()}>
          {(s) => (
            <div class="border-gold/30 bg-gold/5 text-text flex flex-col gap-2 rounded-sm border p-4 text-[0.88rem]">
              <p class="font-display text-gold-dim text-[1.1rem] italic">Applied</p>
              <p class="text-text-muted font-mono text-[0.72rem]">{s().importId}</p>
              <p>
                events: +{s().eventsCreated} / ~{s().eventsUpdated} / -{s().eventsRemoved} ·
                families: +{s().familiesCreated} / -{s().familiesRemoved} · guests: +
                {s().guestsCreated} / ~{s().guestsUpdated} / -{s().guestsRemoved}
              </p>
            </div>
          )}
        </Show>

        <ChangeHistory weddingId={props.weddingId} />
      </div>
    </details>
  );
}

/**
 * A column-name chip. `required` (mandatory) columns read in gold; optional ones
 * stay muted, so the two kinds are visually distinct in the step cards. The
 * gold-vs-muted distinction is spelled out, labelled, in the per-sheet "Good to
 * know!" key ({@link KeyLegend}) and mirrors the cire-api parser's required-column
 * lists (`REQUIRED_EVENT_COLUMNS` / `REQUIRED_GUEST_COLUMNS`).
 */
function Col(props: { children: string; required?: boolean }) {
  return (
    <code
      class="bg-bg/60 rounded-[2px] px-1 py-0.5 font-mono text-[0.74rem]"
      classList={{
        "text-gold-dim": props.required === true,
        "text-text-muted": props.required !== true,
      }}
    >
      {props.children}
    </code>
  );
}

/**
 * The mandatory-vs-optional key — a small labelled legend tying the gold/muted
 * colour of the column chips to "mandatory" vs "optional". Rendered **once** at
 * the top of step 2 (above the sheet toggle) so both sheets share one explanation
 * instead of repeating it per sheet.
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
      <summary class="font-display text-gold-dim flex cursor-pointer list-none items-center gap-2 p-3 text-[0.95rem] italic select-none focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 [&::-webkit-details-marker]:hidden">
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
          <tr class="bg-bg/50 text-gold-dim">
            <th class="px-2 py-1 text-left font-normal">Name</th>
            <th class="px-2 py-1 text-center font-normal">Ceremony</th>
            <th class="px-2 py-1 text-center font-normal">Reception</th>
          </tr>
        </thead>
        <tbody class="text-text-muted">
          <tr class="border-border/50 border-t">
            <td class="text-text px-2 py-1">Linh</td>
            <td class="text-gold px-2 py-1 text-center">yes</td>
            <td class="text-gold px-2 py-1 text-center">yes</td>
          </tr>
          <tr class="border-border/50 border-t">
            <td class="text-text px-2 py-1">Minh</td>
            <td class="text-gold px-2 py-1 text-center">yes</td>
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
        <h3 class="font-display text-text text-[1.05rem] italic">{props.title}</h3>
      </div>
      {props.children}
    </li>
  );
}

/**
 * The Events-sheet guidance: the required/optional column chips followed by the
 * "Good to know!" key + format rules. Every rule mirrors the cire-api parser
 * (`cire/api/src/services/spreadsheet.ts`): the ISO-8601-with-offset Start/End
 * format, the IANA Timezone, the http(s) Pinterest/Maps URLs, and the
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
              <span class="text-text font-mono">YYYY-MM-DDTHH:MM+GMT</span> — e.g.{" "}
              <span class="text-text font-mono">2026-11-14T15:00+11:00</span> is 3 pm on 14 Nov 2026
              in AEST (GMT+11). Leave <Col>End</Col> blank for an open-ended event — the invite
              shows just the start time.
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
                class="text-gold-dim underline-offset-2 hover:underline"
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
 * event convention (with a {@link MiniMatrix} worked example), and a "Good to
 * know!" with the guests-specific rules. Mirrors the parser: required columns are
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
 * The Events / Guests toggle inside step 2 — an ARIA tablist so only one sheet's
 * guidance is on screen at a time (Events first). Tabs are keyboard-navigable
 * (←/→/Home/End move + select, matching the WAI-ARIA automatic-activation tabs
 * pattern), `aria-selected` tracks the active sheet, and `aria-controls` /
 * `aria-labelledby` wire each tab to its panel. The gold underline + focus-visible
 * ring keep it on-brand and accessible.
 */
function SheetTabs() {
  const sheets = ["Events", "Guests"] as const;
  const [active, setActive] = createSignal(0);
  const baseId = createUniqueId();
  const tabId = (i: number) => `${baseId}-tab-${i}`;
  const panelId = (i: number) => `${baseId}-panel-${i}`;

  function onKeyDown(e: KeyboardEvent) {
    const last = sheets.length - 1;
    let next: number | null = null;
    if (e.key === "ArrowRight") next = active() === last ? 0 : active() + 1;
    else if (e.key === "ArrowLeft") next = active() === 0 ? last : active() - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    document.getElementById(tabId(next))?.focus();
  }

  return (
    <div class="flex flex-col gap-3">
      {/* tabIndex={-1}: the tablist is not a tab stop itself — the tab buttons
          inside are the focusable stops; keydown arrives here by bubbling. */}
      <div
        role="tablist"
        aria-label="Choose a sheet"
        class="border-border/60 flex gap-1 border-b"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <For each={sheets}>
          {(name, i) => {
            const selected = () => active() === i();
            return (
              <button
                type="button"
                role="tab"
                id={tabId(i())}
                aria-selected={selected()}
                aria-controls={panelId(i())}
                tabIndex={selected() ? 0 : -1}
                onClick={() => setActive(i())}
                class="font-body -mb-px border-b-2 px-3 py-1.5 text-[0.72rem] tracking-[0.18em] uppercase transition focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2"
                classList={{
                  "border-gold text-gold": selected(),
                  "text-text-muted hover:text-text border-transparent": !selected(),
                }}
              >
                {name} sheet
              </button>
            );
          }}
        </For>
      </div>

      <div role="tabpanel" id={panelId(0)} aria-labelledby={tabId(0)} hidden={active() !== 0}>
        <Show when={active() === 0}>
          <EventsGuidance />
        </Show>
      </div>
      <div role="tabpanel" id={panelId(1)} aria-labelledby={tabId(1)} hidden={active() !== 1}>
        <Show when={active() === 1}>
          <GuestsGuidance />
        </Show>
      </div>
    </div>
  );
}

/**
 * "How to structure your two sheets" — a three-step visual guide that mirrors the
 * cire-api parser (`cire/api/src/services/spreadsheet.ts`). The steps follow the
 * natural flow a non-technical couple takes: ① grab the template, ② fill in the
 * details, ③ upload, preview, and apply. Step 2 stays light: the shared
 * mandatory/optional key once, then an Events / Guests {@link SheetTabs} toggle so
 * only one sheet's guidance shows at a time, with the deep field rules tucked
 * behind a "Formatting tips" disclosure. A native <details>/<summary> (open by
 * default) keeps the whole guide keyboard- and screen-reader-accessible.
 */
function CsvFormatHelp() {
  return (
    <details open class="border-border bg-bg/30 group rounded-sm border">
      <summary class="font-body text-text hover:text-gold flex cursor-pointer items-center gap-2 px-4 py-3 text-[0.88rem] transition select-none">
        <span class="text-gold inline-block transition-transform group-open:rotate-90" aria-hidden>
          ›
        </span>
        How to structure your two sheets — CSV format
      </summary>

      <div class="border-border/60 flex flex-col gap-5 border-t px-4 py-5">
        <ol class="grid grid-cols-1 gap-4 md:grid-cols-3">
          <StepCard n={1} title="New here?">
            <p class="text-text-muted text-[0.8rem]">
              Download a starter template above — it has the correct headers and example rows, so
              you can fill in your details and re-upload.
            </p>
            <p class="text-text-muted text-[0.76rem]">
              In the guests template, rename the <Col>{GUEST_TEMPLATE_EXAMPLE_EVENTS[0]}</Col> /{" "}
              <Col>{GUEST_TEMPLATE_EXAMPLE_EVENTS[1]}</Col> columns to your real event names.
            </p>
          </StepCard>

          <StepCard n={2} title="Fill in your details">
            <p class="text-text-muted text-[0.8rem]">
              Switch between your two sheets below — the key shows which fields are mandatory.
            </p>
            <KeyLegend />
            <SheetTabs />
          </StepCard>

          <StepCard n={3} title="Upload & preview">
            <p class="text-text-muted text-[0.8rem]">
              Upload <strong class="text-text">events first</strong>, then guests — each guest's
              event columns are matched to events that already exist, so the events sheet has to go
              in before the guests sheet.
            </p>
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
