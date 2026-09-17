import { describe, expect, it } from "vitest";

import { assertBlockTable, dataCapacity, encodeQr, QrCapacityError } from "../../src/lib/qr";

// The encoder has no scanner in CI, so correctness is pinned by things that
// can be checked without one. Every fixture below was produced by the encoder
// and then verified out of band against macOS CoreImage's `CIDetector`, an
// independent decoder: eighteen symbols round-tripped, one at the maximum
// capacity of each version 1 to 15 plus two real `otpauth://` URIs.
//
// That verification cannot run here — CI has no CoreImage — so what it found
// is frozen instead. Both bugs the encoder actually had would fail these tests
// and neither would have failed a rendering assertion: a reversed
// Reed-Solomon generator polynomial, and format-information bits written
// least-significant-first. Each renders a plausible QR that scans as nothing.

/** The `otpauth://` URI shape `osn/api` builds, at a realistic length. */
const REAL_URI =
  "otpauth://totp/Musubi:alice@example.com?secret=JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP" +
  "&issuer=Musubi&algorithm=SHA1&digits=6&period=30";

const SHORT_URI = "otpauth://totp/Musubi:a@b.co?secret=JBSWY3DPEHPK3PXP&issuer=Musubi";

/** Version 5, 37x37. CoreImage decoded this exact matrix back to `SHORT_URI`. */
const SHORT_GOLDEN = [
  "#######.#...##..#..##......##.#######",
  "#.....#..###..#....#.#.###..#.#.....#",
  "#.###.#..###.#..###..##.#.##..#.###.#",
  "#.###.#.##.#..##..#...#..####.#.###.#",
  "#.###.#.##.####.##.....#.#..#.#.###.#",
  "#.....#.#..####..#.##...#.#.#.#.....#",
  "#######.#.#.#.#.#.#.#.#.#.#.#.#######",
  "........##.##.#....#.#.#.............",
  "#...#.####.###..#..##...#.##..####..#",
  ".#.##....####.#...##.##.##.####.##.#.",
  "####.##...######.###...##.##..#...#..",
  ".###.#.......#####.#####..##..#.#.##.",
  "#####.###.#.....###..####.....##...##",
  "####.#...###.#.#.....#.....#...##...#",
  "#.##.##..#.....#.#..#..##.####..###..",
  "..##.#.#.##..#.#####..##..####..#.##.",
  "#.##.##.#......#..##..#.##..#.#.#.#.#",
  "#.#.#...#...##..##.##..#.####...#.##.",
  "##..####.#.#..#.###.#.##.#.#..#..##..",
  "..#.#..##.#.##...##..#....#.#.#...#.#",
  ".#.##.####...#.##..####.#...###..#.#.",
  "...#...###.####.###....#...###.##..##",
  "#...#.#.....#..#..#.####..###.....#..",
  "######.#..##..#.....##....##.##.#.##.",
  "#..##.#.##...##.#..##..##...###.#####",
  "#.###......##.#..###.###.#.##...#....",
  "...#..##......##...#...##.##...####..",
  "...#....#..#...###.###.##.#.##....###",
  "###.###.######..#...##......#####...#",
  "........###.###.#.#..########...##..#",
  "#######.##...###.#..#..##.#.#.#.#.#..",
  "#.....#...#..#..####..##..#.#...#.#.#",
  "#.###.#.####..#...##..##....#######.#",
  "#.###.#......#..#..###.#.#.#####..#.#",
  "#.###.#...#####.#...#..###...###.....",
  "#.....#..#..###..#...#.......##..###.",
  "#######.#......##..#.##.#..#.##.#####",
];

/** Version 8, 49x49. CoreImage decoded this exact matrix back to `REAL_URI`. */
const REAL_GOLDEN = [
  "#######..#.##....####..#######..#.#..#..#.#######",
  "#.....#....#.##...#...##....#.####.#.####.#.....#",
  "#.###.#.##.##..#....#...#...#...#.#....##.#.###.#",
  "#.###.#.#.#......#...#.#...#...#...###.#..#.###.#",
  "#.###.#.##.###....#########..####..###....#.###.#",
  "#.....#.##...#.##...#.#...#.#..#..#####...#.....#",
  "#######.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#.#######",
  "........#..##.#..#.####...#...###...#.#.#........",
  "#.#####....#...#.#.##.#####..#...#.##.#.#.#####..",
  "#####..###.###...###.#...#.######..#.#.#.###.#.#.",
  "#.#..##.....#.##...#...#..##.##.#...#..#.#.#.#..#",
  ".#.##..###.#..##....##.#...#.#.###..#....####..##",
  "#.#...##......#...##.##.###..#...####.#.#.##...#.",
  "..##...#####..#......#.###...###...#.....###..##.",
  "..#####.##.#.#.....#....##...#..####.##.....#..##",
  "###.#....##.#..##....#..###...##.#.####...####.#.",
  "#.##..#.#..#.#####..#..###.#.##.....##.#...#..##.",
  "#.##.....#.###.#..##.#.#.#....##.#.##....####..#.",
  "#...###.##.##.##...###..##.#.##.....###......#..#",
  "...#...####.#..##..#.......##.#.#..#.#..#.###..#.",
  "##...##........####..#####...###...##..###.#..#.#",
  "..##.#..#.####.##..#.#.##..#.##....#.#.#.###..###",
  "###.######.......#...########..##.#.#.#.#####.###",
  "###.#...##..#..#.#...##...##..#..#.#....#...#..#.",
  "#...#.#.#.##.##..#..###.#.#...##.#..#.#.#.#.#.#.#",
  ".#.##...#..##.###..#..#...#####....###..#...###..",
  "..#########..###....###########..#...#.#######.##",
  ".####..##.....##.#####..##.##.#.###..##.##.#...#.",
  "#.###.###....#####....####.....#....##.##.#.#..#.",
  "...##..######...#.####..##..###.##..##..#..#.....",
  "...##.#..##.#.##.##.#.####.#.....##.#....##..####",
  ".#..##..###.##.....##...####.#....#.#...#....#.#.",
  ".###.###.#.#.#...##.#.#.##..#..#####.####...####.",
  ".###.#.#..#.##...#.#...#######..#.#....##.##.#.#.",
  "#..#####.#.####.####.##.##..#.####.#.####.#.##.##",
  "#.#....#..#.####.#..#....#.###..##.#.##..#.#....#",
  ".#.####.#..#..#...##.###......##..######.##.#####",
  ".##....#.#..##.###.#.#..####.###...###.#####.#.#.",
  ".#...###..#.#.####....####........######.###..#.#",
  ".###.....#.#.##...#.##.....#...#...##....#.#...#.",
  "###...##.######..##.#.#####...##...############..",
  "........#..######....##...##.##....#.#.##...##...",
  "#######...#....#...#..#.#.##.##.##.###..#.#.##.##",
  "#.....#.#......###.#.##...###...#..#.####...##.#.",
  "#.###.#.###..#####.#..#####..###.#####..#######.#",
  "#.###.#.#.#.###.###..#...##..###....##.##.###..#.",
  "#.###.#.#.#.####...#...##.####.#.######..#.#.####",
  "#.....#....#.#..###..#..###...##.#..#....###....#",
  "#######.#..#..####..#......#.##.....#..###....###",
];

function render(text: string): string[] {
  return encodeQr(text).modules.map((row) => row.map((dark) => (dark ? "#" : ".")).join(""));
}

describe("encodeQr", () => {
  it("reproduces the CoreImage-verified matrix for a real otpauth URI", () => {
    expect(render(REAL_URI)).toEqual(REAL_GOLDEN);
  });

  it("reproduces the CoreImage-verified matrix for a short otpauth URI", () => {
    expect(render(SHORT_URI)).toEqual(SHORT_GOLDEN);
  });

  it("picks the smallest version that fits and sizes the symbol from it", () => {
    expect(encodeQr(SHORT_URI).version).toBe(5);
    expect(encodeQr(REAL_URI).version).toBe(8);
    for (const text of [SHORT_URI, REAL_URI]) {
      const m = encodeQr(text);
      expect(m.size).toBe(m.version * 4 + 17);
      expect(m.modules).toHaveLength(m.size);
      for (const row of m.modules) expect(row).toHaveLength(m.size);
    }
  });

  it("lays a finder pattern in three corners and not the fourth", () => {
    const m = encodeQr(REAL_URI);
    const finderAt = (top: number, left: number) =>
      [0, 1, 2, 3, 4, 5, 6].every((r) =>
        [0, 1, 2, 3, 4, 5, 6].every((c) => {
          const onRing = r === 0 || r === 6 || c === 0 || c === 6;
          const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
          return m.modules[top + r]![left + c] === (onRing || inCore);
        }),
      );
    expect(finderAt(0, 0)).toBe(true);
    expect(finderAt(0, m.size - 7)).toBe(true);
    expect(finderAt(m.size - 7, 0)).toBe(true);
    // A fourth finder would make the symbol's orientation ambiguous.
    expect(finderAt(m.size - 7, m.size - 7)).toBe(false);
  });

  it("alternates both timing patterns and sets the dark module", () => {
    const m = encodeQr(REAL_URI);
    for (let i = 8; i < m.size - 8; i++) {
      expect(m.modules[6]![i]).toBe(i % 2 === 0);
      expect(m.modules[i]![6]).toBe(i % 2 === 0);
    }
    // Always dark, at (4 * version + 9, 8). Its absence is a decoder's first
    // sign that it is not looking at a QR symbol.
    expect(m.modules[4 * m.version + 9]![8]).toBe(true);
  });

  it("changes the symbol when the payload changes by one character", () => {
    expect(render(REAL_URI)).not.toEqual(render(REAL_URI.replace("period=30", "period=60")));
  });

  it("encodes UTF-8 rather than truncating to Latin-1", () => {
    // Two-byte characters cost two bytes of capacity, so the same character
    // count reaches a larger version than an ASCII payload would.
    expect(encodeQr("é".repeat(20)).version).toBeGreaterThan(encodeQr("e".repeat(20)).version);
  });

  it("refuses a payload past the largest version it supports", () => {
    expect(() => encodeQr("a".repeat(412))).not.toThrow();
    expect(() => encodeQr("a".repeat(413))).toThrow(QrCapacityError);
  });
});

describe("the specification tables the encoder cannot derive", () => {
  it("agrees with the codeword capacity of every version it supports", () => {
    // The block table is copied from the specification and a wrong row produces
    // a symbol no scanner reads. This proves all fifteen rows against capacity
    // computed from each symbol's own function-pattern layout, which is derived
    // rather than copied — so the two cannot be wrong in the same way.
    expect(() => assertBlockTable()).not.toThrow();
  });

  it("holds the documented data capacity at the ends of its range", () => {
    expect(dataCapacity(1)).toBe(16);
    expect(dataCapacity(15)).toBe(415);
  });
});
