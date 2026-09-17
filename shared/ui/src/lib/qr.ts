/**
 * Minimal QR Code (ISO/IEC 18004) encoder — byte mode, error-correction
 * level M, versions 1 to 15.
 *
 * It exists because the account-recovery surfaces have to render an
 * `otpauth://` URI as a QR code and nothing in this monorepo could. The scope
 * is deliberately the smallest that serves that one payload: a single
 * error-correction level and a single encoding mode remove most of the
 * specification's data tables, and version 15 at level M holds 412 bytes
 * against an `otpauth://` URI's 110-170.
 *
 * The QR is never the only way through a screen that renders one. The base32
 * secret is displayed as selectable text beside it, which is both the
 * accessible alternative and the fallback when a payload will not fit.
 */

/** Dark modules of an encoded symbol, row-major, excluding the quiet zone. */
export interface QrMatrix {
  /** Modules per side. Always `4 * version + 17`. */
  readonly size: number;
  /** `modules[row][column]` — true is dark. */
  readonly modules: readonly (readonly boolean[])[];
  /** The symbol version, 1 to 15. */
  readonly version: number;
}

/** Raised when a payload will not fit in version 15 at error-correction level M. */
export class QrCapacityError extends Error {
  constructor(byteLength: number) {
    super(`${byteLength} bytes exceeds the 412-byte capacity of a version 15 level-M symbol`);
    this.name = "QrCapacityError";
  }
}

const MIN_VERSION = 1;
const MAX_VERSION = 15;

/**
 * Error-correction level M block structure, versions 1-15.
 *
 * Each row is `[ecCodewordsPerBlock, group1Blocks, group1DataCodewords,
 * group2Blocks, group2DataCodewords]`, indexed by version - 1. A group-2 entry
 * of zero blocks means the version has one group.
 *
 * These are the specification's tables and cannot be derived, so they are
 * cross-checked instead: `assertBlockTable` proves every row against the
 * codeword capacity computed from the symbol's own function-pattern layout.
 */
const EC_BLOCKS_M: readonly (readonly [number, number, number, number, number])[] = [
  [10, 1, 16, 0, 0], // 1
  [16, 1, 28, 0, 0], // 2
  [26, 1, 44, 0, 0], // 3
  [18, 2, 32, 0, 0], // 4
  [24, 2, 43, 0, 0], // 5
  [16, 4, 27, 0, 0], // 6
  [18, 4, 31, 0, 0], // 7
  [22, 2, 38, 2, 39], // 8
  [22, 3, 36, 2, 37], // 9
  [26, 4, 43, 1, 44], // 10
  [30, 1, 50, 4, 51], // 11
  [22, 6, 36, 2, 37], // 12
  [22, 8, 37, 1, 38], // 13
  [24, 4, 40, 5, 41], // 14
  [24, 5, 41, 5, 42], // 15
];

/**
 * Alignment-pattern centre coordinates per version, versions 1-15. Version 1
 * has none. Every pair of coordinates is a centre except where it would
 * collide with a finder pattern.
 */
const ALIGNMENT_CENTRES: readonly (readonly number[])[] = [
  [], // 1
  [6, 18], // 2
  [6, 22], // 3
  [6, 26], // 4
  [6, 30], // 5
  [6, 34], // 6
  [6, 22, 38], // 7
  [6, 24, 42], // 8
  [6, 26, 46], // 9
  [6, 28, 50], // 10
  [6, 30, 54], // 11
  [6, 32, 58], // 12
  [6, 34, 62], // 13
  [6, 26, 46, 66], // 14
  [6, 26, 48, 70], // 15
];

// --- GF(256) arithmetic, primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 ------

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a]! + LOG[b]!]!;
}

/** Generator polynomial for `degree` error-correction codewords. */
function generatorPoly(degree: number): Uint8Array {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    // Multiply by (x - a^i): the shifted copy carries the x term, the scaled
    // copy the constant. `poly[0]` is the highest-degree coefficient.
    for (let j = 0; j < poly.length; j++) {
      next[j] = (next[j]! ^ poly[j]!) as number;
      next[j + 1] = (next[j + 1]! ^ gfMul(poly[j]!, EXP[i]!)) as number;
    }
    poly = next;
  }
  return poly;
}

/** Reed-Solomon remainder of `data` for `ecLength` error-correction codewords. */
function reedSolomon(data: Uint8Array, ecLength: number): Uint8Array {
  const gen = generatorPoly(ecLength);
  const remainder = new Uint8Array(ecLength);
  for (const byte of data) {
    const factor = byte ^ remainder[0]!;
    remainder.copyWithin(0, 1);
    remainder[ecLength - 1] = 0;
    for (let i = 0; i < ecLength; i++) {
      remainder[i] = (remainder[i]! ^ gfMul(gen[i + 1]!, factor)) as number;
    }
  }
  return remainder;
}

// --- Function patterns ------------------------------------------------------

const CELL_FREE = 0;
const CELL_LIGHT = 1;
const CELL_DARK = 2;
type Cell = typeof CELL_FREE | typeof CELL_LIGHT | typeof CELL_DARK;

function sizeFor(version: number): number {
  return version * 4 + 17;
}

/** Alignment-pattern centres for a version, minus the three finder collisions. */
function alignmentCentres(version: number): readonly [number, number][] {
  const coords = ALIGNMENT_CENTRES[version - 1]!;
  const last = sizeFor(version) - 7;
  const out: [number, number][] = [];
  for (const row of coords) {
    for (const col of coords) {
      const atFinder =
        (row === 6 && col === 6) || (row === 6 && col === last) || (row === last && col === 6);
      if (!atFinder) out.push([row, col]);
    }
  }
  return out;
}

/**
 * Lay every function pattern into a fresh grid: finders and separators, the
 * two timing lines, the alignment patterns, the dark module, and the reserved
 * format- and version-information areas. Modules left `Free` are exactly the
 * ones the data-and-error-correction bitstream is written into.
 */
function functionPatterns(version: number): Cell[][] {
  const size = sizeFor(version);
  const grid: Cell[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => CELL_FREE),
  );

  const set = (row: number, col: number, dark: boolean) => {
    if (row < 0 || col < 0 || row >= size || col >= size) return;
    grid[row]![col] = dark ? CELL_DARK : CELL_LIGHT;
  };

  // Finder patterns and their separators, at three corners.
  for (const [top, left] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ] as const) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const onRing = r === 0 || r === 6 || c === 0 || c === 6;
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        const inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        set(top + r, left + c, inside && (onRing || inCore));
      }
    }
  }

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // Alignment patterns.
  for (const [row, col] of alignmentCentres(version)) {
    for (let r = -2; r <= 2; r++) {
      for (let c = -2; c <= 2; c++) {
        const ring = Math.max(Math.abs(r), Math.abs(c));
        set(row + r, col + c, ring !== 1);
      }
    }
  }

  // Format-information areas — reserved now, written after masking. The dark
  // module at (4 * version + 9, 8) is part of this reservation and is the one
  // module in it whose value is fixed.
  for (let i = 0; i < 9; i++) {
    if (grid[8]![i] === CELL_FREE) set(8, i, false);
    if (grid[i]![8] === CELL_FREE) set(i, 8, false);
  }
  for (let i = 0; i < 8; i++) {
    set(8, size - 1 - i, false);
    set(size - 1 - i, 8, false);
  }
  set(size - 8, 8, true);

  // Version information, versions 7 and up.
  if (version >= 7) {
    for (let i = 0; i < 18; i++) {
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      set(a, b, false);
      set(b, a, false);
    }
  }

  return grid;
}

/** Codewords a version holds, derived from its own function-pattern layout. */
function totalCodewords(version: number): number {
  const grid = functionPatterns(version);
  let free = 0;
  for (const row of grid) for (const cell of row) if (cell === CELL_FREE) free++;
  return Math.floor(free / 8);
}

// --- Encoding ---------------------------------------------------------------

interface BlockPlan {
  ecPerBlock: number;
  blocks: number[];
  dataCodewords: number;
}

function blockPlan(version: number): BlockPlan {
  const [ec, g1, g1cw, g2, g2cw] = EC_BLOCKS_M[version - 1]!;
  const blocks: number[] = [];
  for (let i = 0; i < g1; i++) blocks.push(g1cw);
  for (let i = 0; i < g2; i++) blocks.push(g2cw);
  return { ecPerBlock: ec, blocks, dataCodewords: g1 * g1cw + g2 * g2cw };
}

/**
 * Prove the hard-coded block table against capacity computed from the
 * symbol layout. Exported so a test can assert every version rather than only
 * the ones a fixture happens to reach: a wrong row here produces a symbol that
 * scanners reject, which no rendering assertion would catch.
 */
export function assertBlockTable(): void {
  for (let v = MIN_VERSION; v <= MAX_VERSION; v++) {
    const { ecPerBlock, blocks, dataCodewords } = blockPlan(v);
    const used = dataCodewords + ecPerBlock * blocks.length;
    const capacity = totalCodewords(v);
    if (used !== capacity) {
      throw new Error(`version ${v}: block table uses ${used} codewords, capacity is ${capacity}`);
    }
  }
}

/** Data codewords a version holds at level M. */
export function dataCapacity(version: number): number {
  return blockPlan(version).dataCodewords;
}

function charCountBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

/** Smallest version whose data capacity holds `byteLength` bytes in byte mode. */
function chooseVersion(byteLength: number): number {
  for (let v = MIN_VERSION; v <= MAX_VERSION; v++) {
    const headerBits = 4 + charCountBits(v);
    if (headerBits + byteLength * 8 <= dataCapacity(v) * 8) return v;
  }
  throw new QrCapacityError(byteLength);
}

class BitWriter {
  readonly bits: number[] = [];
  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >> i) & 1);
  }
}

/** Mode indicator, character count, payload, terminator and pad codewords. */
function dataCodewordsFor(bytes: Uint8Array, version: number): Uint8Array {
  const capacity = dataCapacity(version);
  const writer = new BitWriter();
  writer.push(0b0100, 4);
  writer.push(bytes.length, charCountBits(version));
  for (const byte of bytes) writer.push(byte, 8);

  const capacityBits = capacity * 8;
  const terminator = Math.min(4, capacityBits - writer.bits.length);
  writer.push(0, terminator);
  while (writer.bits.length % 8 !== 0) writer.bits.push(0);

  const out = new Uint8Array(capacity);
  for (let i = 0; i < writer.bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | writer.bits[i + j]!;
    out[i / 8] = byte;
  }
  // Alternating pad codewords fill whatever the payload left.
  for (let i = writer.bits.length / 8, pad = 0; i < capacity; i++, pad++) {
    out[i] = pad % 2 === 0 ? 0xec : 0x11;
  }
  return out;
}

/** Split into blocks, append error correction, then interleave both halves. */
function interleave(data: Uint8Array, version: number): Uint8Array {
  const { ecPerBlock, blocks } = blockPlan(version);
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  let offset = 0;
  for (const length of blocks) {
    const block = data.subarray(offset, offset + length);
    offset += length;
    dataBlocks.push(block);
    ecBlocks.push(reedSolomon(block, ecPerBlock));
  }

  const out: number[] = [];
  const longest = Math.max(...blocks);
  for (let i = 0; i < longest; i++) {
    for (const block of dataBlocks) if (i < block.length) out.push(block[i]!);
  }
  for (let i = 0; i < ecPerBlock; i++) {
    for (const block of ecBlocks) out.push(block[i]!);
  }
  return new Uint8Array(out);
}

/** Write the codeword bitstream into the free modules, boustrophedon. */
function placeData(grid: Cell[][], codewords: Uint8Array, size: number): void {
  let bit = 0;
  const nextBit = (): boolean => {
    const index = bit >> 3;
    // Past the last codeword are the version's remainder bits, always zero.
    const byte = index < codewords.length ? codewords[index]! : 0;
    const value = (byte >> (7 - (bit & 7))) & 1;
    bit++;
    return value === 1;
  };

  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    // Column 6 is the vertical timing pattern; the pairing skips over it.
    const rightCol = right <= 6 ? right - 1 : right;
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (const col of [rightCol, rightCol - 1]) {
        if (grid[row]![col] !== CELL_FREE) continue;
        grid[row]![col] = nextBit() ? CELL_DARK : CELL_LIGHT;
      }
    }
    upward = !upward;
  }
}

const MASKS: readonly ((row: number, col: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

/** BCH(15,5) format information for level M and a mask, already XOR-masked. */
function formatBits(mask: number): number {
  // Level M is `00`; the five data bits are the level then the mask.
  const data = (0b00 << 3) | mask;
  let value = data << 10;
  for (let i = 4; i >= 0; i--) {
    if ((value >> (10 + i)) & 1) value ^= 0x537 << i;
  }
  return ((data << 10) | value) ^ 0x5412;
}

/** BCH(18,6) version information, versions 7 and up. */
function versionBits(version: number): number {
  let value = version << 12;
  for (let i = 5; i >= 0; i--) {
    if ((value >> (12 + i)) & 1) value ^= 0x1f25 << i;
  }
  return (version << 12) | value;
}

const PENALTY_RUN = [1, 0, 1, 1, 1, 0, 1] as const;

function penaltyRuns(line: readonly boolean[]): number {
  let score = 0;
  let run = 1;
  for (let i = 1; i < line.length; i++) {
    if (line[i] === line[i - 1]) {
      run++;
    } else {
      if (run >= 5) score += run - 2;
      run = 1;
    }
  }
  if (run >= 5) score += run - 2;

  // Rule 3: the finder-like 1:1:3:1:1 sequence with four light modules on
  // either side, scored once per occurrence in each direction.
  for (let i = 0; i + 10 < line.length; i++) {
    const window = line.slice(i, i + 11);
    const core = window.slice(0, 7).map((v) => (v ? 1 : 0));
    const trailing = window.slice(7).every((v) => !v);
    const leadingCore = window.slice(4).map((v) => (v ? 1 : 0));
    const leading = window.slice(0, 4).every((v) => !v);
    if (trailing && core.every((v, j) => v === PENALTY_RUN[j])) score += 40;
    if (leading && leadingCore.every((v, j) => v === PENALTY_RUN[j])) score += 40;
  }
  return score;
}

function penalty(modules: readonly (readonly boolean[])[], size: number): number {
  let score = 0;

  for (let r = 0; r < size; r++) score += penaltyRuns(modules[r]!);
  for (let c = 0; c < size; c++) {
    const column: boolean[] = [];
    for (let r = 0; r < size; r++) column.push(modules[r]![c]!);
    score += penaltyRuns(column);
  }

  // Rule 2: every 2x2 block of one colour.
  for (let r = 0; r + 1 < size; r++) {
    for (let c = 0; c + 1 < size; c++) {
      const v = modules[r]![c]!;
      if (modules[r]![c + 1] === v && modules[r + 1]![c] === v && modules[r + 1]![c + 1] === v) {
        score += 3;
      }
    }
  }

  // Rule 4: deviation of the dark proportion from one half.
  let dark = 0;
  for (const row of modules) for (const cell of row) if (cell) dark++;
  const percent = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(percent - 50) / 5) * 10;

  return score;
}

/**
 * Encode `text` as a QR symbol: byte mode, error-correction level M, the
 * smallest version that fits, and the mask the specification's penalty rules
 * select.
 *
 * @throws {QrCapacityError} when the UTF-8 payload exceeds 412 bytes.
 */
export function encodeQr(text: string): QrMatrix {
  const bytes = new TextEncoder().encode(text);
  const version = chooseVersion(bytes.length);
  const size = sizeFor(version);

  const base = functionPatterns(version);
  placeData(base, interleave(dataCodewordsFor(bytes, version), version), size);

  const isFunction = functionPatterns(version).map((row) => row.map((c) => c !== CELL_FREE));

  let best: boolean[][] | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let mask = 0; mask < 8; mask++) {
    const apply = MASKS[mask]!;
    const candidate = base.map((row, r) =>
      row.map((cell, c) => {
        const dark = cell === CELL_DARK;
        return isFunction[r]![c] ? dark : dark !== apply(r, c);
      }),
    );
    writeFormat(candidate, size, mask);
    if (version >= 7) writeVersion(candidate, size, version);
    const score = penalty(candidate, size);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return { size, version, modules: best! };
}

function writeFormat(modules: boolean[][], size: number, mask: number): void {
  const bits = formatBits(mask);
  // Bit 14 is the first bit of the format sequence, and the two copies below
  // are written in that order, so index from the most significant end.
  const at = (i: number) => ((bits >> (14 - i)) & 1) === 1;
  // Copy one: around the top-left finder, skipping the timing row and column.
  for (let i = 0; i <= 5; i++) modules[8]![i] = at(i);
  modules[8]![7] = at(6);
  modules[8]![8] = at(7);
  modules[7]![8] = at(8);
  for (let i = 9; i <= 14; i++) modules[14 - i]![8] = at(i);
  // Copy two: split between the other two finders.
  for (let i = 0; i <= 7; i++) modules[size - 1 - i]![8] = at(i);
  for (let i = 8; i <= 14; i++) modules[8]![size - 15 + i] = at(i);
  modules[size - 8]![8] = true;
}

function writeVersion(modules: boolean[][], size: number, version: number): void {
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const bit = ((bits >> i) & 1) === 1;
    const a = Math.floor(i / 3);
    const b = (i % 3) + size - 11;
    modules[a]![b] = bit;
    modules[b]![a] = bit;
  }
}
