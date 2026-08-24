// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ImportPanel is now scoped to ONE sheet — the module it lives in. The events
 * module's Edit sub gets an events import, the guests module's a guests import,
 * and neither can reach the other's half of the wedding.
 *
 * These cover: the per-kind surface (one input, one template, one guide), the
 * single-sheet request body (the omitted key is what leaves the other half
 * alone), the format guide's open-once-then-collapse behaviour, the
 * mandatory-column marking, and the failure/export paths.
 */

const redirectToLoginMock = vi.hoisted(() => vi.fn());

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../test-support/mocks");
  return rpAuthSolidMock();
});

vi.mock("../lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: (err: unknown) => String(err).includes("AuthExpiredError"),
  redirectToLogin: redirectToLoginMock,
}));

const invalidateEventsMock = vi.hoisted(() => vi.fn());
const invalidateGuestsMock = vi.hoisted(() => vi.fn());
const invalidateHouseholdsMock = vi.hoisted(() => vi.fn());

// Spied, not stubbed wholesale: the apply path's own comment calls dropping ONE
// of the three the thing that "leaves a stale household in an id-authoritative
// draft", i.e. a destructive remove+create on the next editor save. Import and
// the editor now sit one radio click apart inside the same EditWorkspace, over
// the same weddingId-keyed caches, so that no longer needs a navigation to bite.
vi.mock("../lib/events-store", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  invalidateEvents: invalidateEventsMock,
}));
vi.mock("../lib/guests-store", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  invalidateGuests: invalidateGuestsMock,
}));
vi.mock("../lib/households-store", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  invalidateHouseholds: invalidateHouseholdsMock,
}));

import { resetImportHelpSeen } from "../lib/import-help";
import { authFetchMock, resetOrganiserMocks } from "../test-support/mocks";
import ImportPanel from "./ImportPanel";

// Capture the Blobs handed to URL.createObjectURL so we can read their text.
// We patch only the two methods on the real URL constructor (rather than
// replacing the whole global) so happy-dom's anchor-click navigation, which
// calls `new URL(...)`, keeps working — and we point the anchor at a `blob:`
// href that it won't try to navigate to.
const createdBlobs: Blob[] = [];
let revoked: string[] = [];
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;

beforeEach(() => {
  createdBlobs.length = 0;
  revoked = [];
  // The format guide opens itself once per browser, remembered in localStorage —
  // which persists across renders within a file. Each test starts as a fresh
  // organiser unless it says otherwise.
  resetImportHelpSeen();
  URL.createObjectURL = (blob: Blob) => {
    createdBlobs.push(blob);
    return `blob:mock/${createdBlobs.length}`;
  };
  URL.revokeObjectURL = (url: string) => {
    revoked.push(url);
  };
});

afterEach(() => {
  cleanup();
  resetOrganiserMocks();
  redirectToLoginMock.mockReset();
  invalidateEventsMock.mockReset();
  invalidateGuestsMock.mockReset();
  invalidateHouseholdsMock.mockReset();
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
});

async function blobText(blob: Blob): Promise<string> {
  // happy-dom Blob exposes text(); fall back to FileReader otherwise.
  if (typeof blob.text === "function") return blob.text();
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result ?? "")));
    reader.readAsText(blob);
  });
}

function csvFile(name: string, body = "x") {
  return new File([body], name, { type: "text/csv" });
}

/** Pick a file on the panel's one input, by the label's `for` (the control is a
 *  sibling of its label, wired by id rather than wrapped). */
function choose(file: File) {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  fireEvent.change(input);
}

const previewButton = () => screen.getByRole("button", { name: /^preview$/i }) as HTMLButtonElement;

describe("ImportPanel — one sheet per module", () => {
  it("offers only the events sheet in the events module", () => {
    render(() => <ImportPanel weddingId="wed_a" kind="events" />);
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(screen.getByText("events.csv")).toBeTruthy();
    expect(screen.queryByText("guests.csv")).toBeNull();
    expect(screen.getByRole("button", { name: /download events template/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /download guests template/i })).toBeNull();
  });

  it("offers only the guests sheet in the guests module", () => {
    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(1);
    expect(screen.getByText("guests.csv")).toBeTruthy();
    expect(screen.queryByText("events.csv")).toBeNull();
    expect(screen.getByRole("button", { name: /download guests template/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /download events template/i })).toBeNull();
  });

  it("shows only that sheet's guidance — no sheet toggle to get lost in", () => {
    render(() => <ImportPanel weddingId="wed_a" kind="events" />);
    expect(screen.queryByRole("tablist", { name: /choose a sheet/i })).toBeNull();
    const body = document.body.textContent ?? "";
    expect(body).toContain("One row per event.");
    expect(body).not.toContain("One row per guest.");
  });

  it("keeps the events-before-guests ordering note on the guests sheet, where it applies", () => {
    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    // Text spans nested elements (e.g. <strong>events first</strong>), so assert
    // on the flattened body text rather than a single element.
    const body = (document.body.textContent ?? "").toLowerCase();
    expect(body).toContain("events first");
    expect(body).toContain("before the guests sheet");
  });
});

describe("ImportPanel — CSV format help", () => {
  const helpDetails = () =>
    [...document.querySelectorAll("details")].find((d) =>
      /csv format/i.test(d.querySelector("summary")?.textContent ?? ""),
    )!;

  it("exposes the format help as a native disclosure (details/summary)", () => {
    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    expect(helpDetails()).toBeTruthy();
    expect(helpDetails().querySelector("summary")?.textContent ?? "").toMatch(/csv format/i);
  });

  it("opens itself — and glows — the FIRST time an organiser meets it", () => {
    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    expect(helpDetails().open).toBe(true);
    expect(helpDetails().className).toContain("attention-glow");
  });

  it("starts collapsed and quiet on every visit after that", () => {
    // First visit marks the bit on mount…
    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    cleanup();
    // …so the second panel — either sheet, the bit is shared — starts closed.
    render(() => <ImportPanel weddingId="wed_a" kind="events" />);
    expect(helpDetails().open).toBe(false);
    expect(helpDetails().className).not.toContain("attention-glow");
  });

  it("drops the glow as soon as the disclosure is touched", () => {
    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    fireEvent.click(helpDetails().querySelector("summary")!);
    expect(helpDetails().className).not.toContain("attention-glow");
  });

  it("does not mistake its own opening for a touch", () => {
    // Setting `open` fires a `toggle` event, in happy-dom and in browsers alike.
    // A toggle listener would therefore drop the glow in the same tick it was
    // added, and the one cue the guide has would never paint.
    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    fireEvent(helpDetails(), new Event("toggle"));
    expect(helpDetails().className).toContain("attention-glow");
  });

  it("leads with step 1 = New here? / download the template", () => {
    render(() => <ImportPanel weddingId="wed_a" kind="events" />);
    // The first numbered step card heads with the "New here?" download prompt.
    const firstStep = document.querySelector("ol > li");
    expect(firstStep).toBeTruthy();
    const text = (firstStep?.textContent ?? "").toLowerCase();
    expect(text).toContain("1");
    expect(text).toContain("new here?");
    expect(text).toContain("download");
  });

  it("renders the mandatory-vs-optional key", () => {
    render(() => <ImportPanel weddingId="wed_a" kind="events" />);
    const body = (document.body.textContent ?? "").toLowerCase();
    expect(body).toContain("indicates mandatory fields");
    expect(body).toContain("indicates optional fields");
  });

  it("renders the key exactly once", () => {
    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    const keys = [...document.querySelectorAll("*")].filter(
      (el) => el.children.length === 0 && /^Key$/.test((el.textContent ?? "").trim()),
    );
    expect(keys.length).toBe(1);
  });

  it("marks mandatory columns by more than colour, in ink strong enough to read", () => {
    // The chips were `text-gold-dim` — `--gold` at ~30% alpha, and `--gold`
    // itself is metal with no text contract (~2.4:1 in the light ramp). The
    // readable variant is `--gold-ink`, held to 4.5:1 over bg/surface by
    // `styles/tokens.test.ts`. Plus a `*` and an sr-only word, so the
    // distinction survives greyscale, a colour-vision deficiency and a screen
    // reader alike (WCAG 1.4.1).
    render(() => <ImportPanel weddingId="wed_a" kind="events" />);
    const chip = [...document.querySelectorAll("code")].find((c) =>
      (c.textContent ?? "").startsWith("Event Name"),
    )!;
    expect(chip.className).toContain("text-gold-ink");
    expect(chip.className).not.toContain("text-gold-dim");
    expect(chip.textContent).toContain("*");
    expect(chip.querySelector(".sr-only")?.textContent).toMatch(/mandatory/i);

    // An optional column carries neither marker.
    const optional = [...document.querySelectorAll("code")].find(
      (c) => (c.textContent ?? "").trim() === "Location",
    )!;
    expect(optional.textContent).not.toContain("*");
    expect(optional.querySelector(".sr-only")).toBeNull();
  });

  it("documents the truthy invite cell values once the guests tips are open", () => {
    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    const tips = [...document.querySelectorAll("details > summary")].find((s) =>
      /formatting tips/i.test(s.textContent ?? ""),
    );
    expect(tips).toBeTruthy();
    fireEvent.click(tips!);
    const body = document.body.textContent ?? "";
    expect(body).toMatch(/\btrue\b/);
    expect(body).toMatch(/\byes\b/);
  });

  it("links the word IANA to the tz database list, opening in a new tab", () => {
    render(() => <ImportPanel weddingId="wed_a" kind="events" />);
    const link = [...document.querySelectorAll("a")].find(
      (a) => (a.textContent ?? "").trim() === "IANA",
    );
    expect(link).toBeTruthy();
    expect(link?.getAttribute("href")).toBe(
      "https://en.wikipedia.org/wiki/List_of_tz_database_time_zones",
    );
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noreferrer");
  });

  it("documents the events timestamp + dress-code palette formats", () => {
    render(() => <ImportPanel weddingId="wed_a" kind="events" />);
    const body = document.body.textContent ?? "";
    // A LOCAL wall clock — the guidance must show the same shape the template
    // emits and the parser wants, with no offset for an organiser to get wrong.
    expect(body).toContain("2026-11-14T15:00");
    expect(body).not.toContain("2026-11-14T15:00+");
    expect(body).toContain("DisplayName:#RGB");
  });
});

/**
 * The panel must send ONLY its own sheet. Omitting the other key is what tells
 * the API to leave that half of the wedding alone, where an empty string would
 * read as "an empty sheet" and reconcile by deleting everything.
 */
describe("ImportPanel — single-sheet uploads", () => {
  function previewBody(): Record<string, unknown> {
    return JSON.parse(String(authFetchMock.mock.calls[0]![1].body)) as Record<string, unknown>;
  }

  const previewResponse = (scope: string) =>
    new Response(
      JSON.stringify({
        changeId: "chg_1",
        scope,
        warnings: [],
        plan: {
          eventCreates: [],
          eventUpdates: [],
          eventRemoves: [],
          familyCreates: [],
          familyRemoves: [],
          guestCreates: [],
          guestUpdates: [],
          guestRemoves: [],
          eventLinkCreates: [],
          eventLinkRemoves: [],
          warnings: [],
        },
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );

  it("posts only eventsCsv from the events module", async () => {
    authFetchMock.mockResolvedValueOnce(previewResponse("events"));
    render(() => <ImportPanel weddingId="wed_a" kind="events" />);
    choose(csvFile("events.csv", "Event Name,Start,Timezone\r\n"));
    fireEvent.click(previewButton());

    await waitFor(() => expect(authFetchMock).toHaveBeenCalled());
    const body = previewBody();
    expect(body).toHaveProperty("eventsCsv");
    // Absent, NOT "" — an empty guests sheet would mean "remove every household".
    expect(body).not.toHaveProperty("guestsCsv");
  });

  it("posts only guestsCsv from the guests module", async () => {
    authFetchMock.mockResolvedValueOnce(previewResponse("guests"));
    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    choose(csvFile("guests.csv", "Family ID,Family Name\r\n"));
    fireEvent.click(previewButton());

    await waitFor(() => expect(authFetchMock).toHaveBeenCalled());
    const body = previewBody();
    expect(body).toHaveProperty("guestsCsv");
    expect(body).not.toHaveProperty("eventsCsv");
  });

  it("keeps Preview disabled until a sheet is chosen", () => {
    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    expect(previewButton().disabled).toBe(true);
    choose(csvFile("guests.csv"));
    expect(previewButton().disabled).toBe(false);
  });

  it("names the half this upload leaves alone", () => {
    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    choose(csvFile("guests.csv"));
    expect(document.body.textContent ?? "").toMatch(/events won't be touched/i);
  });

  it("names the other half in the events module too", () => {
    render(() => <ImportPanel weddingId="wed_a" kind="events" />);
    choose(csvFile("events.csv"));
    expect(document.body.textContent ?? "").toMatch(/guest list won't be touched/i);
  });

  it("Remove clears the chosen sheet and any preview computed from it", async () => {
    authFetchMock.mockResolvedValueOnce(previewResponse("guests"));
    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    choose(csvFile("guests.csv"));
    fireEvent.click(previewButton());
    await waitFor(() => expect(screen.getByText(/diff preview/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /remove guests\.csv/i }));
    // The stale plan is dropped, so Apply can't commit a diff for a file that is
    // no longer selected, and Preview goes back to disabled.
    expect(screen.queryByText(/diff preview/i)).toBeNull();
    expect(previewButton().disabled).toBe(true);
  });

  it("drops a standing preview when a DIFFERENT file is picked (S-M1)", async () => {
    // The bug this pins: preview file A, then re-pick file B on the same input.
    // The diff and its "Apply import" button stayed on screen holding A's
    // changeId, so Apply committed A — a bulk reconcile of one half of the
    // wedding — while the control named B. `clearFile` documented the invariant
    // and held it for Remove only; re-selection is the commoner gesture.
    authFetchMock.mockResolvedValueOnce(previewResponse("guests"));
    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    choose(csvFile("guests-old.csv"));
    fireEvent.click(previewButton());
    await waitFor(() => expect(screen.getByText(/diff preview/i)).toBeTruthy());

    choose(csvFile("guests-new.csv"));
    expect(screen.queryByText(/diff preview/i)).toBeNull();
    expect(screen.queryByRole("button", { name: /apply import/i })).toBeNull();
    // Still armed for the NEW file — dropping the plan must not disable Preview.
    expect(previewButton().disabled).toBe(false);
  });

  it("refuses an oversized file before reading or uploading it (S-L1)", () => {
    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    const tooBig = csvFile("huge.csv");
    // A real 1MB+ File would make the suite allocate it; the panel reads `.size`.
    Object.defineProperty(tooBig, "size", { value: 2 * 1024 * 1024 });
    choose(tooBig);
    fireEvent.click(previewButton());

    expect(screen.getByText(/limit is 1 MB per import/i)).toBeTruthy();
    // The point of the guard: nothing was read and nothing was sent.
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("fails before the network when the file can't be read (T-S3)", async () => {
    // `reader.error` is a DOMException, whose `instanceof Error` result varies by
    // engine — so without a deliberate message this surfaces either a cryptic
    // `NotReadableError` or a bare "Preview failed.". What must never happen is
    // posting an empty body, because an empty sheet means "delete everything".
    const RealFileReader = globalThis.FileReader;
    class FailingReader extends RealFileReader {
      override readAsText() {
        setTimeout(() => this.dispatchEvent(new Event("error")), 0);
      }
    }
    vi.stubGlobal("FileReader", FailingReader);
    try {
      render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
      choose(csvFile("guests.csv"));
      fireEvent.click(previewButton());

      await waitFor(() => expect(screen.getByText(/couldn't be read/i)).toBeTruthy());
      expect(authFetchMock).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("errors when no sheet is chosen", () => {
    render(() => <ImportPanel weddingId="wed_a" kind="events" />);
    // The submit button is disabled with nothing chosen, so submit the form
    // directly — the guard has to hold even if the disabled state is bypassed.
    fireEvent.submit(document.querySelector("form")!);
    expect(screen.getByText(/choose an? events\.csv file/i)).toBeTruthy();
    expect(authFetchMock).not.toHaveBeenCalled();
  });
});

describe("ImportPanel — surfacing import failures", () => {
  it("renders the row, column, sheet and fix hint from a 422 — not the bare error", async () => {
    authFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: "Malformed spreadsheet",
          reason: "Start must be an ISO-8601 timestamp",
          row: 4,
          column: 2,
          sheet: "events",
        }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(() => <ImportPanel weddingId="wed_a" kind="events" />);
    choose(csvFile("events_export.csv", "Event Name,Start,Timezone\r\n"));
    fireEvent.click(previewButton());

    await waitFor(() => expect(document.body.textContent).toMatch(/row 4/i));
    const body = document.body.textContent ?? "";
    expect(body).toContain("column 2");
    expect(body).toContain("events sheet");
    expect(body).toContain("2026-11-14T15:00");
    expect(body).not.toContain("2026-11-14T15:00+");
    // The old behaviour: the top-level error string and nothing else.
    expect(body).not.toMatch(/^Malformed spreadsheet$/m);
  });

  it("formats an APPLY failure too, not just a preview failure", async () => {
    // handleApply routes through the same formatter; only the preview call was
    // ever exercised, so the apply-only statuses (402 capacity, 409 re-preview)
    // had no test rendering their wording.
    authFetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            changeId: "chg_1",
            scope: "guests",
            warnings: [],
            plan: {
              eventCreates: [],
              eventUpdates: [],
              eventRemoves: [],
              familyCreates: [],
              familyRemoves: [],
              guestCreates: [],
              guestUpdates: [],
              guestRemoves: [],
              eventLinkCreates: [],
              eventLinkRemoves: [],
              warnings: [],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "payment_required", limit: 100, current: 98 }), {
          status: 402,
          headers: { "Content-Type": "application/json" },
        }),
      );

    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    choose(csvFile("guests.csv"));
    fireEvent.click(previewButton());
    await waitFor(() => expect(screen.getByText(/diff preview/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /apply import/i }));
    await waitFor(() => expect(document.body.textContent).toMatch(/limit of 100 guests/i));
    expect(document.body.textContent).not.toMatch(/payment_required/);
  });

  it("renders the families-updated count in the applied summary (and 0 when absent)", async () => {
    // `familiesUpdated` is new on ImportSummary (household renames); an apply
    // response from an older API omits it, and the line must fall back to ~0
    // rather than render "undefined".
    authFetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            changeId: "chg_1",
            scope: "guests",
            warnings: [],
            plan: {
              eventCreates: [],
              eventUpdates: [],
              eventRemoves: [],
              familyCreates: [],
              familyUpdates: [{}],
              familyRemoves: [],
              guestCreates: [],
              guestUpdates: [],
              guestRemoves: [],
              eventLinkCreates: [],
              eventLinkRemoves: [],
              warnings: [],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            summary: {
              importId: "chg_1",
              eventsCreated: 0,
              eventsUpdated: 0,
              eventsRemoved: 0,
              familiesCreated: 2,
              familiesUpdated: 1,
              familiesRemoved: 0,
              guestsCreated: 3,
              guestsUpdated: 0,
              guestsRemoved: 0,
              warnings: [],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    choose(csvFile("guests.csv"));
    fireEvent.click(previewButton());
    await waitFor(() => expect(screen.getByText(/diff preview/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /apply import/i }));
    await waitFor(() => expect(document.body.textContent).toMatch(/applied/i));
    expect(document.body.textContent).toContain("families: +2 / ~1 / -0");
    expect(document.body.textContent).not.toContain("undefined");

    // T-S2 — all THREE caches, not two. The source comment names the failure:
    // "a stale household in an id-authoritative draft is a destructive
    // remove+create", and the editor is now one radio click away over the very
    // same weddingId-keyed stores.
    expect(invalidateEventsMock).toHaveBeenCalledWith("wed_a");
    expect(invalidateGuestsMock).toHaveBeenCalledWith("wed_a");
    expect(invalidateHouseholdsMock).toHaveBeenCalledWith("wed_a");
  });

  it("falls back to ~0 families updated when an older API omits the field", async () => {
    authFetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            changeId: "chg_1",
            scope: "guests",
            warnings: [],
            plan: {
              eventCreates: [],
              eventUpdates: [],
              eventRemoves: [],
              familyCreates: [],
              familyRemoves: [],
              guestCreates: [],
              guestUpdates: [],
              guestRemoves: [],
              eventLinkCreates: [],
              eventLinkRemoves: [],
              warnings: [],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            summary: {
              importId: "chg_1",
              eventsCreated: 0,
              eventsUpdated: 0,
              eventsRemoved: 0,
              familiesCreated: 1,
              familiesRemoved: 0,
              guestsCreated: 0,
              guestsUpdated: 0,
              guestsRemoved: 0,
              warnings: [],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    choose(csvFile("guests.csv"));
    fireEvent.click(previewButton());
    await waitFor(() => expect(screen.getByText(/diff preview/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /apply import/i }));
    await waitFor(() => expect(document.body.textContent).toMatch(/applied/i));
    expect(document.body.textContent).toContain("families: +1 / ~0 / -0");
  });

  it("bounces an expired token on PREVIEW to login rather than rendering it (T-S1)", async () => {
    // Access JWTs live 5 minutes, and this is the portal's longest-dwell surface:
    // pick a file, read the guide, preview, re-read the diff, apply. These two
    // calls are the likeliest in the portal to meet an expired token, and the
    // failure mode is a raw error string in a Notice with the panel looking
    // broken rather than a redirect.
    authFetchMock.mockRejectedValueOnce(new Error("AuthExpiredError"));
    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    choose(csvFile("guests.csv"));
    fireEvent.click(previewButton());

    await waitFor(() => expect(redirectToLoginMock).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("bounces an expired token on APPLY too (T-S1)", async () => {
    authFetchMock
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            changeId: "chg_1",
            scope: "guests",
            warnings: [],
            plan: {
              eventCreates: [],
              eventUpdates: [],
              eventRemoves: [],
              familyCreates: [],
              familyRemoves: [],
              guestCreates: [],
              guestUpdates: [],
              guestRemoves: [],
              eventLinkCreates: [],
              eventLinkRemoves: [],
              warnings: [],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockRejectedValueOnce(new Error("AuthExpiredError"));

    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    choose(csvFile("guests.csv"));
    fireEvent.click(previewButton());
    await waitFor(() => expect(screen.getByText(/diff preview/i)).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /apply import/i }));
    await waitFor(() => expect(redirectToLoginMock).toHaveBeenCalled());
  });

  it("names the offending column on a 422 missing-column failure", async () => {
    authFetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: "Missing required column", column: "Timezone", sheet: "events" }),
        { status: 422, headers: { "Content-Type": "application/json" } },
      ),
    );
    render(() => <ImportPanel weddingId="wed_a" kind="events" />);
    choose(csvFile("events.csv"));
    fireEvent.click(previewButton());

    await waitFor(() => expect(document.body.textContent).toMatch(/"Timezone" column/i));
  });
});

describe("ImportPanel — download templates", () => {
  it("downloads an events template whose first line is the exact parser header row", async () => {
    render(() => <ImportPanel weddingId="wed_a" kind="events" />);
    fireEvent.click(screen.getByRole("button", { name: /download events template/i }));

    await waitFor(() => expect(createdBlobs.length).toBeGreaterThan(0));
    const text = await blobText(createdBlobs[0]!);
    expect(text.split("\r\n")[0]).toBe(
      "Event Name,Start,Timezone,End,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL",
    );
    expect(createdBlobs[0]!.type).toContain("text/csv");
  });

  it("downloads a guests template whose first line is the exact parser header row", async () => {
    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    fireEvent.click(screen.getByRole("button", { name: /download guests template/i }));

    await waitFor(() => expect(createdBlobs.length).toBeGreaterThan(0));
    const text = await blobText(createdBlobs[0]!);
    expect(text.split("\r\n")[0]).toBe(
      "Family ID,Family Name,Guest First Name,Guest Last Name,Guest Nickname,Ceremony,Reception",
    );
  });

  it("revokes the object URL after triggering the download", async () => {
    render(() => <ImportPanel weddingId="wed_a" kind="events" />);
    fireEvent.click(screen.getByRole("button", { name: /download events template/i }));
    await waitFor(() => expect(revoked.length).toBeGreaterThan(0));
  });
});

describe("ImportPanel — download current data (round-trip export)", () => {
  it("fetches the server export and downloads its bytes", async () => {
    const csv = "Event Name,Start,Timezone\r\nCeremony,2026-11-14T15:00:00+11:00,Australia/Sydney";
    authFetchMock.mockResolvedValueOnce(
      new Response(csv, { status: 200, headers: { "Content-Type": "text/csv" } }),
    );
    render(() => <ImportPanel weddingId="wed_a" kind="events" />);
    fireEvent.click(screen.getByRole("button", { name: /download current events/i }));

    await waitFor(() => expect(createdBlobs.length).toBeGreaterThan(0));
    expect(authFetchMock).toHaveBeenCalledWith(
      "https://api.test/api/organiser/weddings/wed_a/export/events.csv",
    );
    expect(await blobText(createdBlobs[0]!)).toBe(csv);
  });

  it("hits the guests export URL from the guests module", async () => {
    authFetchMock.mockResolvedValueOnce(new Response("Family ID", { status: 200 }));
    render(() => <ImportPanel weddingId="wed_a" kind="guests" />);
    fireEvent.click(screen.getByRole("button", { name: /download current guests/i }));

    await waitFor(() =>
      expect(authFetchMock).toHaveBeenCalledWith(
        "https://api.test/api/organiser/weddings/wed_a/export/guests.csv",
      ),
    );
  });

  it("redirects to login on a 401 export instead of surfacing an error", async () => {
    authFetchMock.mockResolvedValueOnce(new Response("unauthorised", { status: 401 }));
    render(() => <ImportPanel weddingId="wed_a" kind="events" />);
    fireEvent.click(screen.getByRole("button", { name: /download current events/i }));

    await waitFor(() => expect(redirectToLoginMock).toHaveBeenCalled());
    expect(createdBlobs).toHaveLength(0);
    expect(screen.queryByText(/export failed/i)).toBeNull();
  });

  it("surfaces a failed export inline instead of downloading", async () => {
    authFetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    render(() => <ImportPanel weddingId="wed_a" kind="events" />);
    fireEvent.click(screen.getByRole("button", { name: /download current events/i }));

    await waitFor(() => expect(screen.getByText(/export failed \(500\)/i)).toBeTruthy());
    expect(createdBlobs).toHaveLength(0);
  });
});
