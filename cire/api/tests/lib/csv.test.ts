import { describe, it, expect } from "bun:test";

import { csvField, sanitiseCsvCell, serialiseCsv, unguardCsvCell } from "../../src/lib/csv";

// Invisible characters, named so the source shows which one each case uses.
const ZWSP = String.fromCodePoint(0x200b);
const ZWJ = String.fromCodePoint(0x200d);
const SOFT_HYPHEN = String.fromCodePoint(0x00ad);
const NBSP = String.fromCodePoint(0x00a0);
const BOM = String.fromCodePoint(0xfeff);
const E_ACUTE = String.fromCodePoint(0x00e9);

describe("sanitiseCsvCell", () => {
  it("neutralises a cell that starts with a formula marker and leaves plain text alone", () => {
    expect(sanitiseCsvCell("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(sanitiseCsvCell("+1")).toBe("'+1");
    expect(sanitiseCsvCell("-1")).toBe("'-1");
    expect(sanitiseCsvCell("@cmd")).toBe("'@cmd");
    expect(sanitiseCsvCell("Ada")).toBe("Ada");
    expect(sanitiseCsvCell("")).toBe("");
  });

  // The `'` goes immediately before the marker, after any leading run a sheet
  // skips. Placed at the very start, a leading line break would leave the
  // marker at the start of the next line, where a `;`-separated reading of
  // the file starts a new row.
  it("puts the guard after leading whitespace and line breaks, right before the marker", () => {
    expect(sanitiseCsvCell("  =EVIL()")).toBe("  '=EVIL()");
    expect(sanitiseCsvCell("\n=1")).toBe("\n'=1");
    expect(sanitiseCsvCell("\r\n@x")).toBe("\r\n'@x");
    expect(sanitiseCsvCell("\t\t+1")).toBe("\t\t'+1");
  });

  // Excel set to `;` as its list separator splits a comma-separated line on
  // `;` and on a line break inside a quoted field whose `"` is not at the
  // start of a segment, so every segment start is a cell start to it.
  it("guards a marker at the start of every ; tab CR or LF segment", () => {
    expect(sanitiseCsvCell("x;=1+1")).toBe("x;'=1+1");
    expect(sanitiseCsvCell("x\n=1+1")).toBe("x\n'=1+1");
    expect(sanitiseCsvCell("x;\t=1+1")).toBe("x;\t'=1+1");
    expect(sanitiseCsvCell("x\n\n-1")).toBe("x\n\n'-1");
    expect(sanitiseCsvCell("x\r\n=1")).toBe("x\r\n'=1");
    expect(sanitiseCsvCell("x\t@a")).toBe("x\t'@a");
    expect(sanitiseCsvCell("a;;=b")).toBe("a;;'=b");
    expect(sanitiseCsvCell("Acme;=HYPERLINK(x)")).toBe("Acme;'=HYPERLINK(x)");
    expect(sanitiseCsvCell("Notes\n=IMAGE(x)")).toBe("Notes\n'=IMAGE(x)");
    expect(sanitiseCsvCell("Black tie\n- no white\n- no denim")).toBe(
      "Black tie\n'- no white\n'- no denim",
    );
    expect(sanitiseCsvCell("=a;+b\n-c")).toBe("'=a;'+b\n'-c");
  });

  it("skips invisible and control characters before the marker", () => {
    expect(sanitiseCsvCell(`${ZWSP}=1`)).toBe(`${ZWSP}'=1`);
    expect(sanitiseCsvCell("\u0000=1")).toBe("\u0000'=1");
    expect(sanitiseCsvCell(`${SOFT_HYPHEN}-1`)).toBe(`${SOFT_HYPHEN}'-1`);
    expect(sanitiseCsvCell(`${NBSP}@x`)).toBe(`${NBSP}'@x`);
    expect(sanitiseCsvCell(`${BOM}+1`)).toBe(`${BOM}'+1`);
    expect(sanitiseCsvCell("\u0085=1")).toBe("\u0085'=1");
    // A format character outside the Basic Multilingual Plane (a tag letter).
    expect(sanitiseCsvCell("\u{E0041}=1")).toBe("\u{E0041}'=1");
    expect(sanitiseCsvCell(`x;${ZWJ}=1`)).toBe(`x;${ZWJ}'=1`);
    expect(sanitiseCsvCell("\u007f=1")).toBe("\u007f'=1");
    expect(sanitiseCsvCell("x;\u2028=1")).toBe("x;\u2028'=1");
    // A `"` that a `;`-separated reading may take as an empty quoted value.
    expect(sanitiseCsvCell('x;"=1')).toBe("x;\"'=1");
  });

  // East Asian builds of Excel can read a full-width marker as a formula start.
  it("guards the full-width markers too", () => {
    expect(sanitiseCsvCell("\uff1d1+1")).toBe("'\uff1d1+1");
    expect(sanitiseCsvCell("x;\uff0bA1")).toBe("x;'\uff0bA1");
    expect(sanitiseCsvCell("\n\uff0d1")).toBe("\n'\uff0d1");
    expect(sanitiseCsvCell("\uff20SUM(A1)")).toBe("'\uff20SUM(A1)");
  });

  // Tab, CR and LF are both segment breaks and skipped characters, so a long
  // run of them must be walked once, not once per break: a guest's note made
  // of line breaks would otherwise cost the whole export its CPU budget.
  it("guards a long run of line breaks and tabs in time linear in its length", () => {
    const run = `\n\t\r${ZWSP}`.repeat(100_000);
    expect(sanitiseCsvCell(`${run}=x`)).toBe(`${run}'=x`);
    expect(unguardCsvCell(`${run}'=x`)).toBe(`${run}=x`);
    expect(sanitiseCsvCell(run)).toBe(run);
  }, 1_000);

  it("adds one more quote to a value that already starts its segment with quotes and a marker", () => {
    expect(sanitiseCsvCell("'=x")).toBe("''=x");
    expect(sanitiseCsvCell("x;''@y")).toBe("x;'''@y");
  });

  it("leaves a marker that does not start a segment alone", () => {
    for (const value of [
      "a-b",
      "a=b",
      "x; y-z",
      "x;a=1",
      "2026-10-08",
      "ada@example.com",
      "O'-Neil",
      "' =x",
      `${E_ACUTE}=1`,
    ]) {
      expect(sanitiseCsvCell(value)).toBe(value);
    }
  });
});

describe("unguardCsvCell", () => {
  const values = [
    "",
    "Ada",
    "=SUM(A1:A2)",
    "+1",
    "-12 Smith Street",
    "@cmd",
    "  =EVIL()",
    "\n=1",
    "\r\n@x",
    "x;=1+1",
    "x\n=1+1",
    "x;\t=1+1",
    "x\n\n-1",
    "a;;=b",
    "Black tie\n- no white\n- no denim",
    "=a;+b\n-c",
    `${ZWSP}=1`,
    "\u{E0041}=1",
    'x;"=1',
    "'=x",
    "''=x",
    "x;''@y",
    "' =x",
    "O'-Neil",
    "it's -fine",
    "a-b",
    "2026-10-08",
    "x;\n;\n=1",
    "\n".repeat(1000),
    `\n${ZWSP}`.repeat(500),
    `${`\n${ZWSP}`.repeat(500)}=x`,
  ];

  it("gives back exactly the value the guard was given", () => {
    for (const value of values) {
      expect(unguardCsvCell(sanitiseCsvCell(value))).toBe(value);
    }
  });

  it("removes one quote before a marker at a segment start, and nothing else", () => {
    expect(unguardCsvCell("'=x")).toBe("=x");
    expect(unguardCsvCell("x;'-y")).toBe("x;-y");
    expect(unguardCsvCell("  '=x")).toBe("  =x");
    expect(unguardCsvCell("''=x")).toBe("'=x");
    expect(unguardCsvCell("x\n\n'-1")).toBe("x\n\n-1");
    expect(unguardCsvCell("O'-Neil")).toBe("O'-Neil");
    expect(unguardCsvCell("'Ada")).toBe("'Ada");
    expect(unguardCsvCell("' =x")).toBe("' =x");
  });
});

describe("csvField (RFC 4180 quoting)", () => {
  it("doubles embedded quotes and wraps the field", () => {
    expect(csvField('a"b')).toBe('"a""b"');
  });

  it("quotes fields containing commas or newlines", () => {
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField("a\nb")).toBe('"a\nb"');
    expect(csvField("a\r\nb")).toBe('"a\r\nb"');
  });

  it("leaves plain values untouched", () => {
    expect(csvField("Catholic Ceremony")).toBe("Catholic Ceremony");
  });

  it("sanitises before quoting, so a formula with a comma gets both guards", () => {
    expect(csvField("=1,2")).toBe('"\'=1,2"');
  });

  it("guards an inner segment and then quotes the line break", () => {
    expect(csvField("Notes\n=IMAGE(x)")).toBe('"Notes\n\'=IMAGE(x)"');
  });

  it("writes the value as given with the guard off", () => {
    expect(csvField("x;=1", false)).toBe("x;=1");
  });
});

describe("serialiseCsv", () => {
  it("joins header + rows with CRLF and no trailing newline", () => {
    expect(
      serialiseCsv(
        ["A", "B"],
        [
          ["1", "2"],
          ["3", "4"],
        ],
      ),
    ).toBe("A,B\r\n1,2\r\n3,4");
  });

  it("returns just the header line for zero rows", () => {
    expect(serialiseCsv(["A", "B"], [])).toBe("A,B");
  });

  it("guards header cells as well as data cells", () => {
    expect(serialiseCsv(["+1 Drinks"], [["x;=1"]])).toBe("'+1 Drinks\r\nx;'=1");
  });
});

// The guard's two promises, checked over generated values rather than a list:
// no segment of a guarded value starts with a bare marker, whatever a reader
// skips first, and the import's inverse gives the value back exactly.
describe("sanitiseCsvCell and unguardCsvCell over generated values", () => {
  const ALPHABET = [
    "a",
    "Z",
    "1",
    " ",
    "'",
    '"',
    "=",
    "+",
    "-",
    "@",
    ";",
    ",",
    "\t",
    "\r",
    "\n",
    "\u0000",
    "\u007f",
    "\u0085",
    "\u00a0",
    "\u00ad",
    "\u200b",
    "\u2028",
    "\ufeff",
    "\u{E0041}",
    "\ud800",
    "\u00e9",
    "\uff1d",
    "\uff0d",
  ];
  // A seeded generator, so a failure names a value that reproduces.
  function random(seed: number) {
    let state = seed;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const SKIPPED = /^[\s\p{Cc}\p{Cf}"]*/u;
  const startsBare = (segment: string) =>
    /^[=+\-@\u{ff1d}\u{ff0b}\u{ff0d}\u{ff20}]/u.test(segment.replace(SKIPPED, ""));

  it("leaves no segment starting with a bare marker, and round-trips", () => {
    const next = random(20261008);
    for (let i = 0; i < 20_000; i++) {
      let value = "";
      const length = Math.floor(next() * 12);
      for (let j = 0; j < length; j++) value += ALPHABET[Math.floor(next() * ALPHABET.length)];
      const guarded = sanitiseCsvCell(value);
      const bare = guarded.split(/[;\t\r\n]/).filter(startsBare);
      if (bare.length > 0 || unguardCsvCell(guarded) !== value) {
        throw new Error(`guard failed for ${JSON.stringify(value)} → ${JSON.stringify(guarded)}`);
      }
    }
  });
});
