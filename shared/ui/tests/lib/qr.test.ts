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
