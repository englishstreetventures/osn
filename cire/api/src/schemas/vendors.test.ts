import { describe, expect, it } from "bun:test";

import { Schema } from "effect";

import {
  ConsumeClaimBody,
  CreateVendorBody,
  ReorderVendorsBody,
  SeedListingBody,
  UpsertListingBody,
  VENDOR_STATUSES,
} from "./vendors";

const dec = <A>(s: Schema.Schema<A>, v: unknown) => Schema.decodeUnknownEither(s)(v);

describe("vendor schemas", () => {
  it("accepts a valid CRM vendor and rejects a bad category/status", () => {
    expect(
      dec(CreateVendorBody, { name: "Bloom", category: "florals", status: "researching" })._tag,
    ).toBe("Right");
    expect(
      dec(CreateVendorBody, { name: "Bloom", category: "not_a_cat", status: "researching" })._tag,
    ).toBe("Left");
    expect(dec(CreateVendorBody, { name: "Bloom", category: "florals", status: "nope" })._tag).toBe(
      "Left",
    );
    expect(
      dec(CreateVendorBody, { name: "", category: "florals", status: "researching" })._tag,
    ).toBe("Left");
  });

  it("SeedListingBody requires an email and >=1 category", () => {
    expect(
      dec(SeedListingBody, { name: "Bloom", email: "a@b.co", categories: ["florals"] })._tag,
    ).toBe("Right");
    expect(dec(SeedListingBody, { name: "Bloom", email: "a@b.co", categories: [] })._tag).toBe(
      "Left",
    );
    expect(dec(SeedListingBody, { name: "Bloom", categories: ["florals"] })._tag).toBe("Left");
  });

  it("UpsertListingBody accepts multi-category + optional price band", () => {
    expect(
      dec(UpsertListingBody, {
        name: "Bloom",
        categories: ["florals", "decor_styling"],
        priceBand: "$$",
      })._tag,
    ).toBe("Right");
    expect(dec(UpsertListingBody, { name: "Bloom", categories: ["bad"] })._tag).toBe("Left");
  });

  it("ReorderVendorsBody requires a status + id list", () => {
    expect(dec(ReorderVendorsBody, { status: "booked", orderedIds: ["ven_1"] })._tag).toBe("Right");
    expect(dec(ReorderVendorsBody, { status: "bad", orderedIds: [] })._tag).toBe("Left");
  });

  it("ConsumeClaimBody requires an orgId", () => {
    expect(dec(ConsumeClaimBody, { orgId: "org_1" })._tag).toBe("Right");
    expect(dec(ConsumeClaimBody, {})._tag).toBe("Left");
  });

  it("exposes the five statuses in order", () => {
    expect(VENDOR_STATUSES).toEqual(["researching", "contacted", "quoted", "booked", "declined"]);
  });
});
