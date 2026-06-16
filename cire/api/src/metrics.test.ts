import { describe, expect, it } from "bun:test";

import { bucketParseReason } from "./metrics";

/**
 * T-S1: `bucketParseReason` is the one branching, attribute-shaping bit of the
 * metrics wiring — it maps a free-text spreadsheet tagged-error `_tag` onto the
 * bounded `ParseRejectReason` union that becomes a metric attribute. A wrong or
 * missing case would silently mis-bucket (or, without the `default`, widen
 * cardinality) and — because the instrument is a no-op on workerd — never fail
 * loudly. Lock the mapping down.
 */
describe("bucketParseReason", () => {
  it("maps each known spreadsheet error _tag to its bucket", () => {
    expect(bucketParseReason("FormulaInjectionDetected")).toBe("formula_injection");
    expect(bucketParseReason("MissingRequiredColumn")).toBe("missing_column");
    expect(bucketParseReason("UnmatchedEventColumn")).toBe("unmatched_event_column");
    expect(bucketParseReason("MalformedSpreadsheet")).toBe("malformed");
  });

  it("collapses unknown / empty tags to the bounded 'other' bucket", () => {
    expect(bucketParseReason("SomeFutureError")).toBe("other");
    expect(bucketParseReason("")).toBe("other");
  });
});
