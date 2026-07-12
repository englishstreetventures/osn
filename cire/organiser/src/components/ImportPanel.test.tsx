// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ImportPanel renders the upload form, the "CSV format" help disclosure, and the
 * two "Download template" controls. These tests cover the new help + template
 * affordances: the instructions render, the disclosure is keyboard-accessible,
 * and clicking a download control produces a Blob whose first line is the exact
 * header row the cire-api parser requires.
 */

const authFetchMock = vi.fn();
const redirectToLoginMock = vi.hoisted(() => vi.fn());

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({ authFetch: authFetchMock }),
}));

vi.mock("../lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: (err: unknown) => String(err).includes("AuthExpiredError"),
  redirectToLogin: redirectToLoginMock,
}));

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
  authFetchMock.mockReset();
  redirectToLoginMock.mockReset();
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

describe("ImportPanel — CSV format help", () => {
  it("renders both upload inputs", () => {
    render(() => <ImportPanel weddingId="wed_a" />);
    expect(screen.getByText(/events\.csv/i)).toBeTruthy();
    expect(screen.getByText(/guests\.csv/i)).toBeTruthy();
  });

  it("explains the events-before-guests ordering", () => {
    render(() => <ImportPanel weddingId="wed_a" />);
    // The instructions mention importing events before guests. Text spans nested
    // elements (e.g. <strong>events first</strong>), so assert on the flattened
    // body text rather than a single element.
    const body = (document.body.textContent ?? "").toLowerCase();
    expect(body).toContain("events first");
    expect(body).toMatch(/events.*before the guests sheet|before the guests/);
  });

  it("documents the truthy invite cell values once the Guests sheet + tips are open", () => {
    render(() => <ImportPanel weddingId="wed_a" />);
    // The truthy-cell tokens live in the Guests sheet's "Formatting tips" aside,
    // which is behind the (initially inactive) Guests tab + a collapsed disclosure.
    // Reveal it the way an organiser would: switch to Guests, then open the tips.
    fireEvent.click(screen.getByRole("tab", { name: /guests sheet/i }));
    const tips = [...document.querySelectorAll("details > summary")].find((s) =>
      /formatting tips/i.test(s.textContent ?? ""),
    );
    expect(tips).toBeTruthy();
    fireEvent.click(tips!);
    const body = document.body.textContent ?? "";
    expect(body).toMatch(/\btrue\b/);
    expect(body).toMatch(/\byes\b/);
  });

  it("toggles step 2 between the Events and Guests sheets (one at a time)", () => {
    render(() => <ImportPanel weddingId="wed_a" />);
    const eventsTab = screen.getByRole("tab", { name: /events sheet/i });
    const guestsTab = screen.getByRole("tab", { name: /guests sheet/i });

    // Events is selected first; its guidance ("One row per event.") is on screen
    // and the Guests guidance ("One row per guest.") is not yet rendered.
    expect(eventsTab.getAttribute("aria-selected")).toBe("true");
    expect(guestsTab.getAttribute("aria-selected")).toBe("false");
    let body = document.body.textContent ?? "";
    expect(body).toContain("One row per event.");
    expect(body).not.toContain("One row per guest.");

    // Switching to Guests swaps the visible guidance — only one sheet shows.
    fireEvent.click(guestsTab);
    expect(guestsTab.getAttribute("aria-selected")).toBe("true");
    expect(eventsTab.getAttribute("aria-selected")).toBe("false");
    body = document.body.textContent ?? "";
    expect(body).toContain("One row per guest.");
    expect(body).not.toContain("One row per event.");
  });

  it("keeps the sheet tablist out of the tab order (tab buttons are the stops)", () => {
    render(() => <ImportPanel weddingId="wed_a" />);
    const tablist = screen.getByRole("tablist", { name: /choose a sheet/i });
    // tabIndex -1: focusable programmatically for the roving-focus pattern,
    // but not a redundant keyboard tab stop alongside the tab buttons.
    expect(tablist.tabIndex).toBe(-1);
  });

  it("renders the mandatory-vs-optional key exactly once (shared, not per sheet)", () => {
    render(() => <ImportPanel weddingId="wed_a" />);
    const keys = [...document.querySelectorAll("*")].filter(
      (el) => el.children.length === 0 && /^Key$/.test((el.textContent ?? "").trim()),
    );
    expect(keys.length).toBe(1);
    // And it survives a sheet switch — it lives above the toggle, not inside a tab.
    fireEvent.click(screen.getByRole("tab", { name: /guests sheet/i }));
    const stillThere = [...document.querySelectorAll("*")].filter(
      (el) => el.children.length === 0 && /^Key$/.test((el.textContent ?? "").trim()),
    );
    expect(stillThere.length).toBe(1);
  });

  it("exposes the format help as a native disclosure (details/summary)", () => {
    render(() => <ImportPanel weddingId="wed_a" />);
    const summary = document.querySelector("details > summary");
    expect(summary).toBeTruthy();
    expect(summary?.textContent ?? "").toMatch(/csv format|how to|format/i);
  });

  it("leads with step 1 = New here? / download the template", () => {
    render(() => <ImportPanel weddingId="wed_a" />);
    // The first numbered step card heads with the "New here?" download prompt
    // (reordered from step 3 → step 1). The first <li> in the steps <ol> is the
    // first step card, led by its numbered badge.
    const firstStep = document.querySelector("ol > li");
    expect(firstStep).toBeTruthy();
    const text = (firstStep?.textContent ?? "").toLowerCase();
    expect(text).toContain("1");
    expect(text).toContain("new here?");
    expect(text).toContain("download");
  });

  it("renders the mandatory-vs-optional key", () => {
    render(() => <ImportPanel weddingId="wed_a" />);
    const body = (document.body.textContent ?? "").toLowerCase();
    expect(body).toContain("indicates mandatory fields");
    expect(body).toContain("indicates optional fields");
  });

  it("links the word IANA to the tz database list, opening in a new tab", () => {
    render(() => <ImportPanel weddingId="wed_a" />);
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
    render(() => <ImportPanel weddingId="wed_a" />);
    const body = document.body.textContent ?? "";
    expect(body).toContain("2026-11-14T15:00+11:00");
    expect(body).toContain("DisplayName:#RGB");
  });
});

describe("ImportPanel — download templates", () => {
  it("downloads an events template whose first line is the exact parser header row", async () => {
    render(() => <ImportPanel weddingId="wed_a" />);
    fireEvent.click(screen.getByRole("button", { name: /download events template/i }));

    await waitFor(() => expect(createdBlobs.length).toBeGreaterThan(0));
    const text = await blobText(createdBlobs[0]!);
    expect(text.split("\r\n")[0]).toBe(
      "Event Name,Start,Timezone,End,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL",
    );
    expect(createdBlobs[0]!.type).toContain("text/csv");
  });

  it("downloads a guests template whose first line is the exact parser header row", async () => {
    render(() => <ImportPanel weddingId="wed_a" />);
    fireEvent.click(screen.getByRole("button", { name: /download guests template/i }));

    await waitFor(() => expect(createdBlobs.length).toBeGreaterThan(0));
    const text = await blobText(createdBlobs[0]!);
    expect(text.split("\r\n")[0]).toBe(
      "Family ID,Family Name,Guest First Name,Guest Last Name,Guest Nickname,Ceremony,Reception",
    );
  });

  it("revokes the object URL after triggering the download", async () => {
    render(() => <ImportPanel weddingId="wed_a" />);
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
    render(() => <ImportPanel weddingId="wed_a" />);
    fireEvent.click(screen.getByRole("button", { name: /download current events/i }));

    await waitFor(() => expect(createdBlobs.length).toBeGreaterThan(0));
    expect(authFetchMock).toHaveBeenCalledWith(
      "https://api.test/api/organiser/weddings/wed_a/export/events.csv",
    );
    expect(await blobText(createdBlobs[0]!)).toBe(csv);
  });

  it("hits the guests export URL for the guests button", async () => {
    authFetchMock.mockResolvedValueOnce(new Response("Family ID", { status: 200 }));
    render(() => <ImportPanel weddingId="wed_a" />);
    fireEvent.click(screen.getByRole("button", { name: /download current guests/i }));

    await waitFor(() =>
      expect(authFetchMock).toHaveBeenCalledWith(
        "https://api.test/api/organiser/weddings/wed_a/export/guests.csv",
      ),
    );
  });

  it("redirects to login on a 401 export instead of surfacing an error", async () => {
    authFetchMock.mockResolvedValueOnce(new Response("unauthorised", { status: 401 }));
    render(() => <ImportPanel weddingId="wed_a" />);
    fireEvent.click(screen.getByRole("button", { name: /download current events/i }));

    await waitFor(() => expect(redirectToLoginMock).toHaveBeenCalled());
    expect(createdBlobs).toHaveLength(0);
    expect(screen.queryByText(/export failed/i)).toBeNull();
  });

  it("surfaces a failed export inline instead of downloading", async () => {
    authFetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 }));
    render(() => <ImportPanel weddingId="wed_a" />);
    fireEvent.click(screen.getByRole("button", { name: /download current events/i }));

    await waitFor(() => expect(screen.getByText(/export failed \(500\)/i)).toBeTruthy());
    expect(createdBlobs).toHaveLength(0);
  });
});
