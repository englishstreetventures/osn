import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { googleCalendarUrl, icsBlob, foldLine, icsObjectUrl } from "./calendar";
import type { EventSummary } from "./types";

const sydneyEvent: EventSummary = {
  id: "9f7a2c14-1b3d-4e5f-8a01-000000000001",
  name: "Mehndi",
  description: "An evening of henna",
  startAt: "2026-09-18T16:00:00+10:00",
  endAt: "2026-09-18T22:00:00+10:00",
  timezone: "Australia/Sydney",
  address: "12 Banksia Lane, Surry Hills NSW 2010",
  dressCodeDescription: null,
  dressCodePalette: null,
  pinterestUrl: null,
  mapsUrl: null,
  sortOrder: 0,
};

const SITE_URL = "https://invite.example.com/abc-123";

async function blobText(b: Blob): Promise<string> {
  // jsdom Blob.text() exists; fall back to FileReader-style if not.
  if (typeof b.text === "function") return b.text();
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.addEventListener("load", () => resolve(String(fr.result)));
    fr.addEventListener("error", () => reject(fr.error));
    fr.readAsText(b);
  });
}

describe("googleCalendarUrl", () => {
  it("produces the expected URL for a Sept 2026 Sydney event", () => {
    const url = googleCalendarUrl(sydneyEvent, SITE_URL);
    expect(url).toBe(
      "https://calendar.google.com/calendar/render?" +
        "action=TEMPLATE" +
        "&text=Mehndi" +
        "&dates=20260918T060000Z%2F20260918T120000Z" +
        "&details=An+evening+of+henna%0A%0AInvite%3A+https%3A%2F%2Finvite.example.com%2Fabc-123" +
        "&location=12+Banksia+Lane%2C+Surry+Hills+NSW+2010" +
        "&ctz=Australia%2FSydney",
    );
  });

  it("URL-encodes commas, ampersands, and reserved characters in the name", () => {
    const url = googleCalendarUrl(
      { ...sydneyEvent, name: "Reception, Cocktail Hour & Dinner" },
      SITE_URL,
    );
    const parsed = new URL(url);
    expect(parsed.searchParams.get("text")).toBe("Reception, Cocktail Hour & Dinner");
    // Ensure the raw query string really did encode the special chars (not literal &).
    expect(parsed.search).toContain("text=Reception%2C+Cocktail+Hour+%26+Dinner");
  });

  it("passes the timezone through as ctz", () => {
    const url = new URL(googleCalendarUrl(sydneyEvent, SITE_URL));
    expect(url.searchParams.get("ctz")).toBe("Australia/Sydney");
  });

  it("emits an empty location when the event has no address", () => {
    const url = new URL(googleCalendarUrl({ ...sydneyEvent, address: null }, SITE_URL));
    expect(url.searchParams.get("location")).toBe("");
  });

  it("includes the invite siteUrl in details", () => {
    const url = new URL(googleCalendarUrl(sydneyEvent, SITE_URL));
    expect(url.searchParams.get("details")).toBe(`An evening of henna\n\nInvite: ${SITE_URL}`);
  });

  it("falls back to a zero-duration entry when endAt is the '' no-stated-end sentinel", () => {
    const url = new URL(googleCalendarUrl({ ...sydneyEvent, endAt: "" }, SITE_URL));
    // end == start — never an Invalid Date / NaN in the dates param.
    expect(url.searchParams.get("dates")).toBe("20260918T060000Z/20260918T060000Z");
  });
});

describe("foldLine", () => {
  it("returns short lines unchanged", () => {
    const s = "DESCRIPTION:hello world";
    expect(foldLine(s)).toBe(s);
  });

  it("folds at 75 octets with CRLF + space continuation", () => {
    const s = "X".repeat(200);
    const folded = foldLine(s);
    const physicals = folded.split("\r\n");
    // First segment is 75 chars, subsequent each start with a space + 74 chars.
    expect(physicals[0].length).toBe(75);
    for (let i = 1; i < physicals.length; i++) {
      expect(physicals[i].startsWith(" ")).toBe(true);
      // Each physical line, including the leading space, must be <= 75 octets.
      expect(new TextEncoder().encode(physicals[i]).length).toBeLessThanOrEqual(75);
    }
    // Reconstruct the original payload.
    const reconstructed =
      physicals[0] +
      physicals
        .slice(1)
        .map((l) => l.slice(1))
        .join("");
    expect(reconstructed).toBe(s);
  });

  it("does not split a multi-byte UTF-8 codepoint across a fold", () => {
    // 🎉 (U+1F389) is a 4-byte UTF-8 sequence. Pad with single-byte chars so a
    // naive byte-cut at offset 75 would land mid-emoji.
    const s = "X".repeat(73) + "🎉".repeat(20);
    const folded = foldLine(s);
    // No U+FFFD replacement char anywhere — would mean a split codepoint.
    expect(folded).not.toContain("�");
    // Round-trip cleanly.
    const physicals = folded.split("\r\n");
    const reconstructed =
      physicals[0] +
      physicals
        .slice(1)
        .map((l) => l.slice(1))
        .join("");
    expect(reconstructed).toBe(s);
  });
});

describe("icsBlob", () => {
  it("contains all required VCALENDAR/VEVENT markers", async () => {
    const text = await blobText(icsBlob(sydneyEvent, SITE_URL));
    // Unfold continuation lines before asserting on logical content.
    const unfolded = text.replace(/\r\n /g, "");
    expect(unfolded).toContain("BEGIN:VCALENDAR");
    expect(unfolded).toContain("VERSION:2.0");
    expect(unfolded).toContain("PRODID:-//cire//invite//EN");
    expect(unfolded).toContain("CALSCALE:GREGORIAN");
    expect(unfolded).toContain("METHOD:PUBLISH");
    expect(unfolded).toContain("BEGIN:VEVENT");
    expect(unfolded).toContain(`UID:${sydneyEvent.id}@cire.invite`);
    expect(unfolded).toMatch(/DTSTAMP:\d{8}T\d{6}Z/);
    expect(unfolded).toContain("DTSTART;TZID=Australia/Sydney:20260918T160000");
    expect(unfolded).toContain("DTEND;TZID=Australia/Sydney:20260918T220000");
    expect(unfolded).toContain("SUMMARY:Mehndi");
    expect(unfolded).toContain("LOCATION:12 Banksia Lane\\, Surry Hills NSW 2010");
    expect(unfolded).toContain(`DESCRIPTION:An evening of henna\\n\\nInvite: ${SITE_URL}`);
    expect(unfolded).toContain("END:VEVENT");
    expect(unfolded).toContain("END:VCALENDAR");
  });

  it("uses CRLF line endings throughout", async () => {
    const text = await blobText(icsBlob(sydneyEvent, SITE_URL));
    // No bare LF that isn't preceded by CR.
    const bareLfMatches = text.match(/(^|[^\r])\n/g);
    expect(bareLfMatches).toBeNull();
    // And CRLF must actually appear between lines.
    expect(text.includes("\r\n")).toBe(true);
  });

  it("escapes commas, semicolons, backslashes, and newlines in text fields", async () => {
    const tricky: EventSummary = {
      ...sydneyEvent,
      name: "Trial; Run, with \\ slash",
      description: "Line one\nLine two; with, all\\ chars",
      address: "1 Main, Suite 2; Floor \\ 3",
    };
    const text = await blobText(icsBlob(tricky, SITE_URL));
    // Pull each logical line out (unfold continuations first, then split CRLF).
    const unfolded = text.replace(/\r\n /g, "");
    const lines = unfolded.split("\r\n");
    const summary = lines.find((l) => l.startsWith("SUMMARY:"))!;
    const location = lines.find((l) => l.startsWith("LOCATION:"))!;
    const description = lines.find((l) => l.startsWith("DESCRIPTION:"))!;
    expect(summary).toBe("SUMMARY:Trial\\; Run\\, with \\\\ slash");
    expect(location).toBe("LOCATION:1 Main\\, Suite 2\\; Floor \\\\ 3");
    expect(description).toBe(
      "DESCRIPTION:Line one\\nLine two\\; with\\, all\\\\ chars\\n\\nInvite: " + SITE_URL,
    );
  });

  it("folds long DESCRIPTION lines so no physical line exceeds 75 octets", async () => {
    const long: EventSummary = {
      ...sydneyEvent,
      description: "A".repeat(200),
    };
    const text = await blobText(icsBlob(long, SITE_URL));
    const physicals = text.split("\r\n");
    for (const line of physicals) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    // At least one continuation line exists.
    expect(physicals.some((l) => l.startsWith(" "))).toBe(true);
    // Unfolding restores the original text.
    const unfolded = text.replace(/\r\n /g, "");
    expect(unfolded).toContain(`DESCRIPTION:${"A".repeat(200)}`);
  });

  it("emits a stable UID for the same event id", async () => {
    const a = await blobText(icsBlob(sydneyEvent, SITE_URL));
    const b = await blobText(icsBlob(sydneyEvent, SITE_URL));
    const uidA = /UID:([^\r\n]+)/.exec(a)![1];
    const uidB = /UID:([^\r\n]+)/.exec(b)![1];
    expect(uidA).toBe(uidB);
    expect(uidA).toBe(`${sydneyEvent.id}@cire.invite`);
  });

  it("ends with a trailing CRLF", async () => {
    const text = await blobText(icsBlob(sydneyEvent, SITE_URL));
    expect(text.endsWith("\r\n")).toBe(true);
  });

  it("returns a Blob with the correct mime type", () => {
    const blob = icsBlob(sydneyEvent, SITE_URL);
    expect(blob.type).toBe("text/calendar;charset=utf-8");
  });

  it("sets DTEND to DTSTART when endAt is the '' no-stated-end sentinel", async () => {
    const text = await blobText(icsBlob({ ...sydneyEvent, endAt: "" }, SITE_URL));
    const unfolded = text.replace(/\r\n /g, "");
    expect(unfolded).toContain("DTSTART;TZID=Australia/Sydney:20260918T160000");
    expect(unfolded).toContain("DTEND;TZID=Australia/Sydney:20260918T160000");
    expect(unfolded).not.toContain("NaN");
  });
});

describe("icsObjectUrl", () => {
  let originalCreate: typeof URL.createObjectURL | undefined;
  let createSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // jsdom doesn't implement createObjectURL — patch the method on the real
    // URL constructor so `new URL(...)` keeps working elsewhere in the suite.
    originalCreate = URL.createObjectURL;
    createSpy = vi.fn(() => "blob:mock-url");
    URL.createObjectURL = createSpy as unknown as typeof URL.createObjectURL;
  });

  afterEach(() => {
    if (originalCreate === undefined) {
      delete (URL as unknown as { createObjectURL?: unknown }).createObjectURL;
    } else {
      URL.createObjectURL = originalCreate;
    }
  });

  it("wraps the Blob in URL.createObjectURL", () => {
    const url = icsObjectUrl(sydneyEvent, SITE_URL);
    expect(url).toBe("blob:mock-url");
    expect(createSpy).toHaveBeenCalledTimes(1);
  });
});
