import { describe, it, expect } from "bun:test";

import { Effect } from "effect";

import {
  isBlank,
  isFormulaCell,
  isIsoTimestamp,
  isTruthy,
  normaliseName,
  nullableString,
  parseDressCodePalette,
  parseHttpUrl,
} from "./guest-event-validation";
import { parseEventsCsv, parseGuestsCsv } from "./spreadsheet";

// ── Unit: each rule in isolation ──────────────────────────────────────────────

describe("guest-event-validation rules", () => {
  it("isFormulaCell flags = + - @ (trimming leading whitespace first)", () => {
    for (const marker of ["=", "+", "-", "@"]) {
      expect(isFormulaCell(`${marker}SUM(A1)`)).toBe(true);
      expect(isFormulaCell(`   ${marker}SUM(A1)`)).toBe(true); // leading-ws bypass
    }
    expect(isFormulaCell("Ada")).toBe(false);
    expect(isFormulaCell("   ")).toBe(false);
    expect(isFormulaCell("")).toBe(false);
  });

  it("normaliseName folds case + collapses internal whitespace", () => {
    expect(normaliseName("  Wedding   Ceremony ")).toBe("wedding ceremony");
    expect(normaliseName("MEHNDI")).toBe("mehndi");
  });

  it("isIsoTimestamp requires the zero-padded YYYY-MM-DDTHH:MM prefix + a real date", () => {
    expect(isIsoTimestamp("2026-11-14T15:00+11:00")).toBe(true);
    expect(isIsoTimestamp("2026-11-14T15:00:00+11:00")).toBe(true);
    for (const bad of ["1st Nov 2026", "TBD", "18/09/2026 4pm", "2026-13-40T99:99"]) {
      expect(isIsoTimestamp(bad)).toBe(false);
    }
  });

  it("isTruthy accepts the sheet's truthy tokens, case-insensitively", () => {
    for (const t of ["true", "TRUE", "yes", "Yes", "1", "x", "X", " x "]) {
      expect(isTruthy(t)).toBe(true);
    }
    for (const f of ["false", "no", "0", "", "  "]) expect(isTruthy(f)).toBe(false);
  });

  it("nullableString trims to null when blank", () => {
    expect(nullableString("  ")).toBeNull();
    expect(nullableString(" Home ")).toBe("Home");
  });

  it("parseHttpUrl returns the URL, null (blank), or undefined (unsafe scheme)", () => {
    expect(parseHttpUrl("https://x")).toBe("https://x");
    expect(parseHttpUrl("http://x")).toBe("http://x");
    expect(parseHttpUrl("  ")).toBeNull();
    expect(parseHttpUrl("javascript:alert(1)")).toBeUndefined();
    expect(parseHttpUrl("not a url")).toBeUndefined();
  });

  it("parseDressCodePalette parses Name:#rgb pairs and skips malformed ones", () => {
    expect(parseDressCodePalette("Blush:#f4c2c2|Sage:#b2ac88")).toEqual([
      { name: "Blush", color: "#f4c2c2" },
      { name: "Sage", color: "#b2ac88" },
    ]);
    expect(parseDressCodePalette("")).toEqual([]);
    expect(parseDressCodePalette("nocolon|Blue:#00f")).toEqual([{ name: "Blue", color: "#00f" }]);
  });

  it("isBlank is true only for the empty string", () => {
    expect(isBlank("")).toBe(true);
    expect(isBlank("a")).toBe(false);
  });
});

// ── Parser-parity: the sheet path uses EXACTLY these rules ─────────────────────
// The design invariant (§3/§9): both front doors reject/accept identically
// because they share this module. The parser imports the module's functions, so
// these tests assert the parser's decisions equal the module's directly — a
// future drift (a copy of a rule diverging) would fail here.

describe("parser-parity: sheet path ≡ validation module", () => {
  const EVENTS_HEADER =
    "Event Name,Start,End,Timezone,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL";

  it("the parser's ISO-timestamp verdict matches isIsoTimestamp for every candidate", async () => {
    const candidates = [
      "2026-11-14T15:00+11:00",
      "2026-11-14T15:00:00+11:00",
      "1st Nov 2026",
      "TBD",
    ];
    for (const start of candidates) {
      const csv = [EVENTS_HEADER, `Mehndi,${start},,Australia/Sydney,,,,,,`].join("\n");
      const parsedOk = await Effect.runPromise(
        parseEventsCsv(csv).pipe(
          Effect.map(() => true),
          Effect.orElseSucceed(() => false),
        ),
      );
      // The parser accepts iff the shared rule says the Start is a valid ISO ts.
      expect(parsedOk).toBe(isIsoTimestamp(start));
    }
  });

  it("the parser's URL verdict matches parseHttpUrl", async () => {
    for (const url of ["https://ok", "http://ok", "javascript:alert(1)", "nonsense"]) {
      const csv = [
        EVENTS_HEADER,
        `Mehndi,2026-09-18T16:00:00+10:00,,Australia/Sydney,,,,,${url},`,
      ].join("\n");
      const parsedOk = await Effect.runPromise(
        parseEventsCsv(csv).pipe(
          Effect.map(() => true),
          Effect.orElseSucceed(() => false),
        ),
      );
      // Blank is legal (null), a bad scheme (undefined) is rejected.
      expect(parsedOk).toBe(parseHttpUrl(url) !== undefined);
    }
  });

  it("the parser's palette output equals parseDressCodePalette for the same cell", async () => {
    const cell = "Blush:#f4c2c2|Sage:#b2ac88";
    const csv = [
      EVENTS_HEADER,
      `Mehndi,2026-09-18T16:00:00+10:00,,Australia/Sydney,,,,${cell},,`,
    ].join("\n");
    const [event] = await Effect.runPromise(parseEventsCsv(csv));
    expect(event!.dressCodePalette).toEqual(parseDressCodePalette(cell));
  });

  it("the parser's attendance toggles equal isTruthy for the same cells", async () => {
    const events = await Effect.runPromise(
      parseEventsCsv(
        [EVENTS_HEADER, "Mehndi,2026-09-18T16:00:00+10:00,,Australia/Sydney,,,,,,"].join("\n"),
      ),
    );
    const guestsCsv = [
      "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi",
      "1,Testfamily,Ada,Testfamily,yes",
      "1,Testfamily,Bo,Testfamily,no",
    ].join("\n");
    const families = await Effect.runPromise(parseGuestsCsv(guestsCsv, events));
    expect(families[0]!.guests[0]!.eventNames).toEqual(isTruthy("yes") ? ["Mehndi"] : []);
    expect(families[0]!.guests[1]!.eventNames).toEqual(isTruthy("no") ? ["Mehndi"] : []);
  });
});
