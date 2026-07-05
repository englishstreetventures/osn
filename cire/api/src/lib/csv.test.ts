import { describe, it, expect } from "bun:test";

import { csvField, sanitiseCsvCell, serialiseCsv } from "./csv";

describe("sanitiseCsvCell", () => {
  it("neutralises formula markers (incl. after leading whitespace) and leaves plain text alone", () => {
    expect(sanitiseCsvCell("=SUM(A1:A2)")).toBe("'=SUM(A1:A2)");
    expect(sanitiseCsvCell("+1")).toBe("'+1");
    expect(sanitiseCsvCell("-1")).toBe("'-1");
    expect(sanitiseCsvCell("@cmd")).toBe("'@cmd");
    expect(sanitiseCsvCell("  =EVIL()")).toBe("'  =EVIL()");
    expect(sanitiseCsvCell("Ada")).toBe("Ada");
    expect(sanitiseCsvCell("")).toBe("");
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
});
