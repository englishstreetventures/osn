import { describe, expect, it } from "bun:test";

import { createGoogleGeocoder, GEOCODE_URL } from "./geocode";
import type { FetchLike } from "./geocode";

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const GOOGLE_OK = {
  status: "OK",
  results: [
    {
      formatted_address: "Sydney NSW, Australia",
      geometry: { location: { lat: -33.8688, lng: 151.2093 } },
      address_components: [
        { long_name: "Sydney", short_name: "Sydney", types: ["locality", "political"] },
        {
          long_name: "New South Wales",
          short_name: "NSW",
          types: ["administrative_area_level_1", "political"],
        },
        { long_name: "Australia", short_name: "AU", types: ["country", "political"] },
      ],
    },
  ],
};

describe("createGoogleGeocoder", () => {
  it("returns null when no key is configured (key-optional)", () => {
    expect(createGoogleGeocoder(undefined)).toBeNull();
    expect(createGoogleGeocoder("")).toBeNull();
  });

  it("parses a successful geocode into a point", async () => {
    let calledUrl: URL | null = null;
    const fetchImpl: FetchLike = async (input) => {
      calledUrl = new URL(String(input));
      return jsonResponse(GOOGLE_OK);
    };
    const geocoder = createGoogleGeocoder("test-key", fetchImpl);
    const outcome = await geocoder!.geocode("Sydney NSW");

    expect(outcome).toEqual({
      status: "ok",
      point: {
        lat: -33.8688,
        lng: 151.2093,
        locality: "Sydney",
        adminArea: "NSW",
        countryCode: "AU",
        formattedAddress: "Sydney NSW, Australia",
      },
    });
    expect(String(calledUrl)).toStartWith(GEOCODE_URL);
    expect(calledUrl!.searchParams.get("address")).toBe("Sydney NSW");
    expect(calledUrl!.searchParams.get("key")).toBe("test-key");
  });

  it("tolerates missing address components", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({
        status: "OK",
        results: [{ geometry: { location: { lat: 1.5, lng: 2.5 } } }],
      });
    const geocoder = createGoogleGeocoder("test-key", fetchImpl);
    const outcome = await geocoder!.geocode("somewhere");
    expect(outcome).toEqual({
      status: "ok",
      point: {
        lat: 1.5,
        lng: 2.5,
        locality: null,
        adminArea: null,
        countryCode: null,
        formattedAddress: "somewhere",
      },
    });
  });

  it("maps ZERO_RESULTS to not_found", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ status: "ZERO_RESULTS", results: [] });
    const geocoder = createGoogleGeocoder("test-key", fetchImpl);
    expect(await geocoder!.geocode("xyzzy")).toEqual({ status: "not_found" });
  });

  it("fails soft to unavailable on non-OK Google statuses", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({ status: "REQUEST_DENIED" });
    const geocoder = createGoogleGeocoder("test-key", fetchImpl);
    expect(await geocoder!.geocode("Sydney")).toEqual({ status: "unavailable" });
  });

  it("fails soft to unavailable on HTTP errors", async () => {
    const fetchImpl: FetchLike = async () => jsonResponse({}, 500);
    const geocoder = createGoogleGeocoder("test-key", fetchImpl);
    expect(await geocoder!.geocode("Sydney")).toEqual({ status: "unavailable" });
  });

  it("fails soft to unavailable on network errors (never throws)", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("connection reset");
    };
    const geocoder = createGoogleGeocoder("test-key", fetchImpl);
    expect(await geocoder!.geocode("Sydney")).toEqual({ status: "unavailable" });
  });

  it("fails soft to unavailable on a malformed point", async () => {
    const fetchImpl: FetchLike = async () =>
      jsonResponse({ status: "OK", results: [{ geometry: { location: { lat: "nope" } } }] });
    const geocoder = createGoogleGeocoder("test-key", fetchImpl);
    expect(await geocoder!.geocode("Sydney")).toEqual({ status: "unavailable" });
  });
});
