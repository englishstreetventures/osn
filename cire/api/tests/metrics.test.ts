import { describe, expect, it } from "bun:test";

import { bucketCspDisposition, bucketParseReason } from "../src/metrics";

/**
 * `bucketParseReason` is the one branching, attribute-shaping bit of the
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

/**
 * `bucketCspDisposition` turns a browser-supplied CSP report `disposition` into
 * the bounded attribute on `cire.csp.report`. Only the two values the spec
 * defines survive; anything else, or nothing, is `unknown` — never `report`,
 * which would file a block among the report-only lines.
 */
describe("bucketCspDisposition", () => {
  it("keeps the two dispositions the spec defines", () => {
    expect(bucketCspDisposition("enforce")).toBe("enforce");
    expect(bucketCspDisposition("report")).toBe("report");
  });

  it("tolerates case and surrounding whitespace", () => {
    expect(bucketCspDisposition(" Enforce ")).toBe("enforce");
    expect(bucketCspDisposition("REPORT")).toBe("report");
  });

  it("collapses a missing, empty or unrecognised value to unknown", () => {
    expect(bucketCspDisposition(undefined)).toBe("unknown");
    expect(bucketCspDisposition("")).toBe("unknown");
    expect(bucketCspDisposition("block")).toBe("unknown");
    expect(bucketCspDisposition("report-only")).toBe("unknown");
  });
});
