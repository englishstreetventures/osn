import { useAuth } from "@osn/client/solid";
import type { JSX } from "solid-js";
import { createSignal, Show, For } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { downloadCsv } from "../lib/download";
import {
  EVENT_REQUIRED_HEADERS,
  EVENT_OPTIONAL_HEADERS,
  GUEST_TEMPLATE_FIXED_HEADERS,
  GUEST_TEMPLATE_EXAMPLE_EVENTS,
  buildEventsTemplateCsv,
  buildGuestsTemplateCsv,
} from "../lib/import-templates";

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
  const importUrl = (op: string) =>
    apiUrl(`/api/organiser/weddings/${props.weddingId}/import/${op}`);
  const [eventsFile, setEventsFile] = createSignal<File | null>(null);
  const [guestsFile, setGuestsFile] = createSignal<File | null>(null);
  const [busy, setBusy] = createSignal(false);
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
      // Refresh guest table.
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
      </div>
    </details>
  );
}

function PlanCounts(props: { plan: ImportPlan }) {
  const rows: { label: string; create: number; update: number; remove: number }[] = [
    {
      label: "events",
      create: props.plan.eventCreates.length,
      update: props.plan.eventUpdates.length,
      remove: props.plan.eventRemoves.length,
    },
    {
      label: "families",
      create: props.plan.familyCreates.length,
      update: 0,
      remove: props.plan.familyRemoves.length,
    },
    {
      label: "guests",
      create: props.plan.guestCreates.length,
      update: props.plan.guestUpdates.length,
      remove: props.plan.guestRemoves.length,
    },
    {
      label: "invitations",
      create: props.plan.eventLinkCreates.length,
      update: 0,
      remove: props.plan.eventLinkRemoves.length,
    },
  ];

  return (
    <table class="font-body w-full border-collapse text-[0.88rem]">
      <thead>
        <tr>
          <th class="border-border text-gold border-b px-3 py-2 text-left text-[0.72rem] font-normal tracking-[0.1em] uppercase" />
          <th class="border-border text-gold border-b px-3 py-2 text-right text-[0.72rem] font-normal tracking-[0.1em] uppercase">
            Create
          </th>
          <th class="border-border text-gold border-b px-3 py-2 text-right text-[0.72rem] font-normal tracking-[0.1em] uppercase">
            Update
          </th>
          <th class="border-border text-gold border-b px-3 py-2 text-right text-[0.72rem] font-normal tracking-[0.1em] uppercase">
            Remove
          </th>
        </tr>
      </thead>
      <tbody>
        <For each={rows}>
          {(r) => (
            <tr>
              <td class="border-border text-text border-b px-3 py-2">{r.label}</td>
              <td class="border-border text-text-muted border-b px-3 py-2 text-right font-mono">
                {r.create}
              </td>
              <td class="border-border text-text-muted border-b px-3 py-2 text-right font-mono">
                {r.update}
              </td>
              <td class="border-border text-text-muted border-b px-3 py-2 text-right font-mono">
                {r.remove}
              </td>
            </tr>
          )}
        </For>
      </tbody>
    </table>
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
 * colour of the column chips to "mandatory" vs "optional". Rendered at the top of
 * each "Good to know!" panel so the colour coding on the chips above always has a
 * nearby, explicit explanation.
 */
function KeyLegend() {
  return (
    <div class="flex flex-col gap-1.5">
      <p class="font-body text-gold text-[0.66rem] tracking-[0.18em] uppercase">Key</p>
      <div class="text-text-muted flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[0.78rem]">
        <span class="flex items-center gap-1.5">
          <Col required>Aa</Col> indicates mandatory fields
        </span>
        <span class="flex items-center gap-1.5">
          <Col>Aa</Col> indicates optional fields
        </span>
      </div>
    </div>
  );
}

/**
 * A clearly-styled "Good to know!" aside — a gold-accented panel that collects the
 * per-sheet format rules (the key plus the field-format guidance). Used under both
 * the Events and Guests guidance so the two share one scannable visual language.
 */
function GoodToKnow(props: { children: JSX.Element }) {
  return (
    <div class="border-gold/25 bg-gold/[0.06] flex flex-col gap-3 rounded-sm border p-3.5">
      <p class="font-display text-gold-dim text-[1rem] italic">Good to know!</p>
      {props.children}
    </div>
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
      <p class="font-body text-gold text-[0.66rem] tracking-[0.18em] uppercase">Events sheet</p>
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

      <GoodToKnow>
        <KeyLegend />
        <dl class="flex flex-col gap-2.5 text-[0.78rem]">
          <div class="flex flex-col gap-0.5">
            <dt class="text-text">Timestamps</dt>
            <dd class="text-text-muted">
              Provide timestamps as <span class="text-text font-mono">YYYY-MM-DDTHH:MM:+GMT</span>{" "}
              for <Col required>Start</Col> and <Col required>End</Col>. For example,{" "}
              <span class="text-text font-mono">2026-11-14T15:00:+11:00</span> is 3 pm on 14
              November 2026 in AEST (GMT+11).
            </dd>
          </div>
          <div class="flex flex-col gap-0.5">
            <dt class="text-text">Timezone</dt>
            <dd class="text-text-muted">
              Provide an{" "}
              <a
                href="https://en.wikipedia.org/wiki/List_of_tz_database_time_zones"
                target="_blank"
                rel="noreferrer"
                class="text-gold-dim underline-offset-2 hover:underline"
              >
                IANA
              </a>{" "}
              timezone (e.g. <span class="text-text font-mono">Australia/Sydney</span>).
            </dd>
          </div>
          <div class="flex flex-col gap-0.5">
            <dt class="text-text">URLs</dt>
            <dd class="text-text-muted">
              <Col>Pinterest URL</Col> and <Col>Maps URL</Col> should be full links (e.g.{" "}
              <span class="text-text font-mono">https://www.pinterest.com/...</span>).
            </dd>
          </div>
          <div class="flex flex-col gap-0.5">
            <dt class="text-text">Dress code palette</dt>
            <dd class="text-text-muted">
              <Col>Dress Code Palette</Col> colours should be listed as{" "}
              <span class="text-text font-mono">DisplayName:#RGB</span>, for example{" "}
              <span class="text-text font-mono">Blush:#f4c2c2</span>. Separate multiple swatches
              with <span class="text-text font-mono">|</span>.
            </dd>
          </div>
        </dl>
      </GoodToKnow>
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
      <p class="font-body text-gold text-[0.66rem] tracking-[0.18em] uppercase">Guests sheet</p>
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
      <MiniMatrix />

      <GoodToKnow>
        <KeyLegend />
        <dl class="flex flex-col gap-2.5 text-[0.78rem]">
          <div class="flex flex-col gap-0.5">
            <dt class="text-text">One row per guest</dt>
            <dd class="text-text-muted">
              Give every guest their own row — don't combine a couple onto one line.
            </dd>
          </div>
          <div class="flex flex-col gap-0.5">
            <dt class="text-text">Group a household</dt>
            <dd class="text-text-muted">
              Repeat the same <Col required>Family Name</Col> on each guest's row to group them into
              one household — they claim &amp; RSVP together.
            </dd>
          </div>
          <div class="flex flex-col gap-0.5">
            <dt class="text-text">Event attendance</dt>
            <dd class="text-text-muted">
              Mark an invited guest's event column with <span class="text-text font-mono">yes</span>{" "}
              (or <span class="text-text font-mono">true</span> /{" "}
              <span class="text-text font-mono">1</span> /{" "}
              <span class="text-text font-mono">x</span>). Leave it{" "}
              <span class="text-text">blank</span> when they're not invited.
            </dd>
          </div>
        </dl>
      </GoodToKnow>
    </div>
  );
}

/**
 * "How to structure your two sheets" — a three-step visual guide that mirrors the
 * cire-api parser (`cire/api/src/services/spreadsheet.ts`). The steps follow the
 * natural flow a non-technical couple takes: ① grab the template, ② fill in the
 * details (Events + Guests guidance, each with a mandatory/optional key and a
 * "Good to know!" of format rules), ③ upload, preview, and apply. A native
 * <details>/<summary> (open by default) keeps it keyboard- and screen-reader-
 * accessible with no JS.
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
              Two sheets: events first, then guests. The key below shows which fields are mandatory.
            </p>
            <EventsGuidance />
            <GuestsGuidance />
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
