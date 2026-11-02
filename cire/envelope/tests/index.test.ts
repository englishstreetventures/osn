import { describe, expect, it } from "vitest";

import {
  BREAK_STYLES,
  ENVELOPE_BREAK_PARAM,
  ENVELOPES,
  isEnvelopeId,
  pickBreak,
} from "../src/index";

/** A query holding only the given parameters, as `URLSearchParams.get` answers. */
function query(params: Record<string, string> = {}): { get(name: string): string | null } {
  return { get: (name) => params[name] ?? null };
}

/** A random source that hands out `values` in turn, one per draw. */
function fills(...values: number[]): (array: Uint32Array) => Uint32Array {
  let next = 0;
  return (array) => {
    array[0] = values[next++]!;
    return array;
  };
}

describe("envelope catalog", () => {
  it("accepts every catalog id", () => {
    for (const envelope of ENVELOPES) expect(isEnvelopeId(envelope.id)).toBe(true);
  });

  it("rejects ids outside the catalog and values that are not strings", () => {
    const values = ["not-an-envelope", "", "WAX-SEAL", 42, null, undefined, {}];
    expect(values.filter((value) => isEnvelopeId(value))).toEqual([]);
  });
});

describe("pickBreak", () => {
  it("honours a break style named in the query", () => {
    for (const style of BREAK_STYLES) {
      const draw = fills();
      expect(pickBreak(query({ [ENVELOPE_BREAK_PARAM]: style }), draw)).toBe(style);
    }
  });

  it("draws when the query names no style, or one that is not a style", () => {
    const queries = [
      {},
      ...["", "PEEL", "explode", " split"].map((v) => ({ [ENVELOPE_BREAK_PARAM]: v })),
    ];
    expect(queries.map((params) => pickBreak(query(params), fills(1)))).toEqual(
      queries.map(() => "peel"),
    );
  });

  it("reads the style from its own parameter only", () => {
    expect(pickBreak(query({ break: "crumble", envelope: "crumble" }), fills(0))).toBe("split");
  });

  it("draws each of the three styles, and nothing else", () => {
    expect(pickBreak(query(), fills(0))).toBe("split");
    expect(pickBreak(query(), fills(1))).toBe("peel");
    expect(pickBreak(query(), fills(2))).toBe("crumble");
    expect(pickBreak(query(), fills(3))).toBe("split");
    expect(pickBreak(query(), fills(2 ** 32 - 2))).toBe("crumble");
  });
});
