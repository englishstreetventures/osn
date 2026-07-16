import { describe, expect, it } from "vitest";

import {
  type DashboardRoute,
  DEFAULT_MODULE,
  defaultSub,
  isModule,
  isSubOf,
  LIST_ROUTE,
  MODULES,
  parseRoute,
  serializeRoute,
} from "./dashboard-route";

/**
 * The hash-route helper is the contract the dashboard's deep-linking + refresh-
 * persistence rests on. Post-IA (PR 3) the shape is `#/w/:id/:module/:sub`: it
 * must parse every shape the app produces (falling unknown shapes back to the
 * list), round-trip its own serialisations, and keep pre-IA `#/weddings/:id/:tab`
 * bookmarks working for one release via the legacy-tab alias.
 */
describe("dashboard-route", () => {
  describe("parseRoute", () => {
    it("parses the wedding list", () => {
      expect(parseRoute("#/weddings")).toEqual(LIST_ROUTE);
    });

    it("parses a wedding with the default module + sub", () => {
      expect(parseRoute("#/w/wed_1")).toEqual({
        view: "weddings",
        weddingId: "wed_1",
        module: DEFAULT_MODULE,
        sub: defaultSub(DEFAULT_MODULE),
      });
    });

    it("parses a wedding + a specific module (default sub)", () => {
      expect(parseRoute("#/w/wed_1/guests")).toEqual({
        view: "weddings",
        weddingId: "wed_1",
        module: "guests",
        sub: defaultSub("guests"),
      });
    });

    it("parses a wedding + module + sub", () => {
      expect(parseRoute("#/w/wed_1/guests/rsvps")).toEqual({
        view: "weddings",
        weddingId: "wed_1",
        module: "guests",
        sub: "rsvps",
      });
    });

    it("parses every known module to its default sub", () => {
      // Driven by MODULES itself so a newly added module is covered automatically
      // instead of silently falling back to the default.
      for (const module of MODULES) {
        const r = parseRoute(`#/w/wed_1/${module}`);
        expect(r.module).toBe(module);
        expect(r.sub).toBe(defaultSub(module));
      }
    });

    it("parses the security view", () => {
      expect(parseRoute("#/security")).toEqual({
        view: "security",
        weddingId: null,
        module: DEFAULT_MODULE,
        sub: defaultSub(DEFAULT_MODULE),
      });
    });

    it("decodes a wedding id with reserved characters", () => {
      expect(parseRoute("#/w/wed%2F1/invite")).toEqual({
        view: "weddings",
        weddingId: "wed/1",
        module: "invite",
        sub: defaultSub("invite"),
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
      expect(parseRoute("#/w/")).toEqual(LIST_ROUTE);
      expect(parseRoute("#/w")).toEqual(LIST_ROUTE);
    });

    it("falls an unknown module back to the default module (keeps the wedding)", () => {
      expect(parseRoute("#/w/wed_1/bogus")).toEqual({
        view: "weddings",
        weddingId: "wed_1",
        module: DEFAULT_MODULE,
        sub: defaultSub(DEFAULT_MODULE),
      });
    });

    it("falls an unknown sub back to the module's default sub (keeps the module)", () => {
      expect(parseRoute("#/w/wed_1/invite/bogus")).toEqual({
        view: "weddings",
        weddingId: "wed_1",
        module: "invite",
        sub: defaultSub("invite"),
      });
    });

    describe("legacy pre-IA aliases (kept for one release)", () => {
      // The flat `#/weddings/:id/:tab` bookmarks must still open to the right
      // module/sub so an organiser's saved link doesn't break silently.
      const cases: Array<[string, { module: string; sub: string }]> = [
        ["events", { module: "schedule", sub: "list" }],
        ["guests", { module: "guests", sub: "list" }],
        ["rsvps", { module: "guests", sub: "rsvps" }],
        ["invite", { module: "invite", sub: "design" }],
        ["codes", { module: "invite", sub: "codes" }],
        ["hosts", { module: "settings", sub: "hosts" }],
        ["settings", { module: "settings", sub: "wedding" }],
      ];
      for (const [tab, expected] of cases) {
        it(`aliases #/weddings/wed_1/${tab} → ${expected.module}/${expected.sub}`, () => {
          expect(parseRoute(`#/weddings/wed_1/${tab}`)).toEqual({
            view: "weddings",
            weddingId: "wed_1",
            module: expected.module,
            sub: expected.sub,
          });
        });
      }

      it("lands a bare #/weddings/:id on the default module", () => {
        expect(parseRoute("#/weddings/wed_1")).toEqual({
          view: "weddings",
          weddingId: "wed_1",
          module: DEFAULT_MODULE,
          sub: defaultSub(DEFAULT_MODULE),
        });
      });

      it("still resolves the legacy bare #security hash", () => {
        expect(parseRoute("#security")).toEqual({
          view: "security",
          weddingId: null,
          module: DEFAULT_MODULE,
          sub: defaultSub(DEFAULT_MODULE),
        });
      });
    });
  });

  describe("serializeRoute", () => {
    it("serialises the list", () => {
      expect(serializeRoute(LIST_ROUTE)).toBe("#/weddings");
    });

    it("omits the default module + sub for a short, canonical wedding link", () => {
      expect(
        serializeRoute({
          view: "weddings",
          weddingId: "wed_1",
          module: DEFAULT_MODULE,
          sub: defaultSub(DEFAULT_MODULE),
        }),
      ).toBe("#/w/wed_1");
    });

    it("appends a non-default module on its default sub", () => {
      expect(
        serializeRoute({ view: "weddings", weddingId: "wed_1", module: "guests", sub: "list" }),
      ).toBe("#/w/wed_1/guests");
    });

    it("appends module + sub for a non-default sub", () => {
      expect(
        serializeRoute({ view: "weddings", weddingId: "wed_1", module: "guests", sub: "rsvps" }),
      ).toBe("#/w/wed_1/guests/rsvps");
    });

    it("serialises security", () => {
      expect(
        serializeRoute({
          view: "security",
          weddingId: null,
          module: DEFAULT_MODULE,
          sub: defaultSub(DEFAULT_MODULE),
        }),
      ).toBe("#/security");
    });

    it("encodes a wedding id with reserved characters", () => {
      expect(
        serializeRoute({ view: "weddings", weddingId: "wed/1", module: "invite", sub: "design" }),
      ).toBe("#/w/wed%2F1/invite");
    });
  });

  describe("round-trip", () => {
    const routes: DashboardRoute[] = [
      LIST_ROUTE,
      { view: "weddings", weddingId: "wed_1", module: "overview", sub: "index" },
      { view: "weddings", weddingId: "wed_1", module: "schedule", sub: "list" },
      { view: "weddings", weddingId: "wed_1", module: "schedule", sub: "edit" },
      { view: "weddings", weddingId: "wed_1", module: "guests", sub: "list" },
      { view: "weddings", weddingId: "wed_1", module: "guests", sub: "rsvps" },
      { view: "weddings", weddingId: "wed_1", module: "invite", sub: "design" },
      { view: "weddings", weddingId: "wed_1", module: "invite", sub: "codes" },
      { view: "weddings", weddingId: "wed_1", module: "settings", sub: "wedding" },
      { view: "weddings", weddingId: "wed_1", module: "settings", sub: "hosts" },
      { view: "weddings", weddingId: "wed/with spaces", module: "guests", sub: "rsvps" },
      {
        view: "security",
        weddingId: null,
        module: DEFAULT_MODULE,
        sub: defaultSub(DEFAULT_MODULE),
      },
    ];

    it("parse(serialize(route)) === route for every producible route", () => {
      for (const route of routes) {
        expect(parseRoute(serializeRoute(route))).toEqual(route);
      }
    });
  });

  describe("isModule / isSubOf", () => {
    it("accepts the known modules and rejects everything else", () => {
      for (const module of MODULES) expect(isModule(module)).toBe(true);
      expect(isModule("weddings")).toBe(false);
      expect(isModule("")).toBe(false);
      expect(isModule("OVERVIEW")).toBe(false);
    });

    it("validates a sub against its module", () => {
      expect(isSubOf("guests", "list")).toBe(true);
      expect(isSubOf("guests", "rsvps")).toBe(true);
      expect(isSubOf("guests", "codes")).toBe(false);
      expect(isSubOf("invite", "codes")).toBe(true);
      expect(isSubOf("overview", "index")).toBe(true);
    });
  });
});

describe("checklist module route", () => {
  it("checklist is a known module", () => {
    expect(isModule("checklist")).toBe(true);
    expect(MODULES).toContain("checklist");
  });

  it("parses #/w/<id>/checklist to the checklist module", () => {
    const r = parseRoute("#/w/wed_1/checklist");
    expect(r.view).toBe("weddings");
    expect(r.weddingId).toBe("wed_1");
    expect(r.module).toBe("checklist");
  });

  it("serializes a checklist route back to the canonical hash", () => {
    expect(
      serializeRoute({ view: "weddings", weddingId: "wed_1", module: "checklist", sub: "index" }),
    ).toBe("#/w/wed_1/checklist");
  });
});
