import { describe, expect, it } from "bun:test";

import { Schema } from "effect";

import {
  ConsumeClaimBody,
  CreateVendorBody,
  ReorderVendorsBody,
  SeedListingBody,
  UpsertListingBody,
  VENDOR_STATUSES,
} from "../../src/schemas/vendors";

// v4 replaces Either with Result: the tags are "Success"/"Failure", not
// "Right"/"Left".
const dec = <A>(s: Schema.Codec<A>, v: unknown) => Schema.decodeUnknownResult(s)(v);

describe("vendor schemas", () => {
  it("accepts a valid CRM vendor and rejects a bad category/status", () => {
    expect(
      dec(CreateVendorBody, { name: "Bloom", category: "florals", status: "researching" })._tag,
    ).toBe("Success");
    expect(
      dec(CreateVendorBody, { name: "Bloom", category: "not_a_cat", status: "researching" })._tag,
    ).toBe("Failure");
    expect(dec(CreateVendorBody, { name: "Bloom", category: "florals", status: "nope" })._tag).toBe(
      "Failure",
    );
    expect(
      dec(CreateVendorBody, { name: "", category: "florals", status: "researching" })._tag,
    ).toBe("Failure");
  });

  it("SeedListingBody requires an email and >=1 category", () => {
    expect(
      dec(SeedListingBody, { name: "Bloom", email: "a@b.co", categories: ["florals"] })._tag,
    ).toBe("Success");
    expect(dec(SeedListingBody, { name: "Bloom", email: "a@b.co", categories: [] })._tag).toBe(
      "Failure",
    );
    expect(dec(SeedListingBody, { name: "Bloom", categories: ["florals"] })._tag).toBe("Failure");
  });

  it("UpsertListingBody accepts multi-category + optional price band", () => {
    expect(
      dec(UpsertListingBody, {
        name: "Bloom",
        categories: ["florals", "decor_styling"],
        priceBand: "$$",
      })._tag,
    ).toBe("Success");
    expect(dec(UpsertListingBody, { name: "Bloom", categories: ["bad"] })._tag).toBe("Failure");
  });

  it("ReorderVendorsBody requires a status + id list", () => {
    expect(dec(ReorderVendorsBody, { status: "booked", orderedIds: ["ven_1"] })._tag).toBe(
      "Success",
    );
    expect(dec(ReorderVendorsBody, { status: "bad", orderedIds: [] })._tag).toBe("Failure");
  });

  it("ConsumeClaimBody requires an orgId", () => {
    expect(dec(ConsumeClaimBody, { orgId: "org_1" })._tag).toBe("Success");
    expect(dec(ConsumeClaimBody, {})._tag).toBe("Failure");
  });

  it("exposes the five statuses in order", () => {
    expect(VENDOR_STATUSES).toEqual(["researching", "contacted", "quoted", "booked", "declined"]);
  });
});
