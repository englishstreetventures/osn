import { describe, expect, it } from "vitest";

import {
  type DashboardRoute,
  DEFAULT_TAB,
  isDashboardTab,
  LIST_ROUTE,
  parseRoute,
  serializeRoute,
} from "./dashboard-route";

/**
 * The hash-route helper is the contract the dashboard's deep-linking + refresh-
 * persistence rests on: it must parse every shape the app produces (and fall
 * unknown shapes back to the list), and round-trip its own serialisations.
 */
describe("dashboard-route", () => {
  describe("parseRoute", () => {
    it("parses the wedding list", () => {
      expect(parseRoute("#/weddings")).toEqual(LIST_ROUTE);
    });

    it("parses a wedding with the default tab", () => {
      expect(parseRoute("#/weddings/wed_1")).toEqual({
        view: "weddings",
        weddingId: "wed_1",
        tab: DEFAULT_TAB,
      });
    });

    it("parses a wedding + a specific tab", () => {
      expect(parseRoute("#/weddings/wed_1/guests")).toEqual({
        view: "weddings",
        weddingId: "wed_1",
        tab: "guests",
      });
    });

    it("parses every known tab", () => {
      for (const tab of ["events", "guests", "invite", "codes", "hosts"] as const) {
        expect(parseRoute(`#/weddings/wed_1/${tab}`).tab).toBe(tab);
      }
    });

    it("parses the security view", () => {
      expect(parseRoute("#/security")).toEqual({
        view: "security",
        weddingId: null,
        tab: DEFAULT_TAB,
      });
    });

    it("decodes a wedding id with reserved characters", () => {
      expect(parseRoute("#/weddings/wed%2F1/invite")).toEqual({
        view: "weddings",
        weddingId: "wed/1",
        tab: "invite",
      });
    });

    it("falls back to the list for an empty / bare hash", () => {
      expect(parseRoute("")).toEqual(LIST_ROUTE);
      expect(parseRoute("#")).toEqual(LIST_ROUTE);
      expect(parseRoute("#/")).toEqual(LIST_ROUTE);
    });

    it("falls back to the list for an unknown top segment", () => {
      expect(parseRoute("#/nonsense/x/y")).toEqual(LIST_ROUTE);
    });

    it("falls back to the list when a wedding id is missing", () => {
      expect(parseRoute("#/weddings/")).toEqual(LIST_ROUTE);
    });

    it("falls an unknown tab back to the default tab (keeps the wedding)", () => {
      expect(parseRoute("#/weddings/wed_1/bogus")).toEqual({
        view: "weddings",
        weddingId: "wed_1",
        tab: DEFAULT_TAB,
      });
    });

    it("tolerates legacy bare hashes", () => {
      // The legacy top-level `#security` hash still resolves to the security
      // view (the segment matches), so a pre-scheme bookmark keeps working.
      expect(parseRoute("#security")).toEqual({
        view: "security",
        weddingId: null,
        tab: DEFAULT_TAB,
      });
      // A legacy bare tab hash (`#guests`) is not a recognised top segment, so
      // it degrades to the list rather than erroring. (OrganiserApp normalises
      // the canonical `#/…` form on mount.)
      expect(parseRoute("#guests")).toEqual(LIST_ROUTE);
    });
  });

  describe("serializeRoute", () => {
    it("serialises the list", () => {
      expect(serializeRoute(LIST_ROUTE)).toBe("#/weddings");
    });

    it("omits the default tab for a short, canonical wedding link", () => {
      expect(serializeRoute({ view: "weddings", weddingId: "wed_1", tab: DEFAULT_TAB })).toBe(
        "#/weddings/wed_1",
      );
    });

    it("appends a non-default tab", () => {
      expect(serializeRoute({ view: "weddings", weddingId: "wed_1", tab: "codes" })).toBe(
        "#/weddings/wed_1/codes",
      );
    });

    it("serialises security", () => {
      expect(serializeRoute({ view: "security", weddingId: null, tab: DEFAULT_TAB })).toBe(
        "#/security",
      );
    });

    it("encodes a wedding id with reserved characters", () => {
      expect(serializeRoute({ view: "weddings", weddingId: "wed/1", tab: "invite" })).toBe(
        "#/weddings/wed%2F1/invite",
      );
    });
  });

  describe("round-trip", () => {
    const routes: DashboardRoute[] = [
      LIST_ROUTE,
      { view: "weddings", weddingId: "wed_1", tab: "events" },
      { view: "weddings", weddingId: "wed_1", tab: "guests" },
      { view: "weddings", weddingId: "wed_1", tab: "invite" },
      { view: "weddings", weddingId: "wed_1", tab: "codes" },
      { view: "weddings", weddingId: "wed_1", tab: "hosts" },
      { view: "weddings", weddingId: "wed/with spaces", tab: "guests" },
      { view: "security", weddingId: null, tab: DEFAULT_TAB },
    ];

    it("parse(serialize(route)) === route for every producible route", () => {
      for (const route of routes) {
        expect(parseRoute(serializeRoute(route))).toEqual(route);
      }
    });
  });

  describe("isDashboardTab", () => {
    it("accepts the five tabs and rejects everything else", () => {
      for (const tab of ["events", "guests", "invite", "codes", "hosts"]) {
        expect(isDashboardTab(tab)).toBe(true);
      }
      expect(isDashboardTab("weddings")).toBe(false);
      expect(isDashboardTab("")).toBe(false);
      expect(isDashboardTab("EVENTS")).toBe(false);
    });
  });
});
