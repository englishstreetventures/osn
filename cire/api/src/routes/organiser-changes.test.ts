import { describe, it, expect, beforeAll } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  events,
  families,
  guests,
  weddingEntitlements,
  weddingHosts,
  weddings,
} from "@cire/db";

import { createApp } from "../app";
import { createDb, seedBootstrapWedding } from "../db/setup";
import { createR2Stub } from "../services/r2-imports";
import { appRequest } from "../test-helpers";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

let auth: OsnTestAuth;
let bearer: string;

const CHANGES_BASE = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/changes`;
const IMPORT_BASE = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/import`;

beforeAll(async () => {
  auth = await makeOsnTestAuth();
  bearer = await auth.sign("usr_dev_bootstrap_owner");
});

const EVENTS_CSV = [
  "Event Name,Start,End,Timezone,Location,Address,Dress Code Description,Dress Code Palette,Pinterest URL,Maps URL",
  "Mehndi,2026-09-18T16:00:00+10:00,2026-09-18T22:00:00+10:00,Australia/Sydney,Home,12 Banksia,Bright,,,",
  "Reception,2026-09-20T16:00:00+10:00,2026-09-20T18:00:00+10:00,Australia/Sydney,Garden,,Formal,,,",
].join("\n");

const GUESTS_CSV = [
  "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Reception",
  "1,Testfamily,Ada,Testfamily,yes,yes",
  "2,Sampleton,Bo,Sampleton,no,yes",
].join("\n");

function buildApp() {
  const db = createDb(":memory:");
  seedBootstrapWedding(db);
  const r2 = createR2Stub();
  const app = createApp(db, { r2, osnTestKey: auth.key });
  return { db, r2, app };
}

function ownerPost(app: ReturnType<typeof buildApp>["app"], path: string, body: object) {
  return appRequest(app, path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
}

function ownerGet(app: ReturnType<typeof buildApp>["app"], path: string) {
  return appRequest(app, path, { method: "GET", headers: { Authorization: `Bearer ${bearer}` } });
}

// ── CSV front door through /changes ─────────────────────────────────────────

describe("POST /changes/preview + /apply — spreadsheet (CSV) front door", () => {
  it("previews then applies a CSV change, returning a baseRevision", async () => {
    const { app, db } = buildApp();

    const previewRes = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()) as {
      changeId: string;
      importId: string;
      baseRevision: string;
      plan: { familyCreates: unknown[] };
    };
    expect(preview.changeId).toBe(preview.importId);
    // Fresh wedding — no applied change yet, so the head is genesis.
    expect(preview.baseRevision).toBe("genesis");
    expect(preview.plan.familyCreates).toHaveLength(2);

    const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, { importId: preview.changeId });
    expect(applyRes.status).toBe(200);
    expect(db.select().from(events).all()).toHaveLength(2);
    expect(db.select().from(families).all()).toHaveLength(2);
    expect(db.select().from(guests).all()).toHaveLength(2);
  });
});

// ── DesiredState front door through /changes ────────────────────────────────

describe("POST /changes/preview + /apply — editor (DesiredState JSON) front door", () => {
  const desiredState = {
    events: [
      {
        name: "Mehndi",
        startAt: "2026-09-18T16:00:00+10:00",
        endAt: "",
        timezone: "Australia/Sydney",
        location: null,
        address: null,
        dressCodeDescription: null,
        dressCodePalette: [],
        pinterestUrl: null,
        mapsUrl: null,
        sortOrder: 0,
      },
    ],
    families: [
      {
        publicId: "EDIT-FAM-0001",
        familyName: "Editorhousehold",
        guests: [
          {
            firstName: "Nia",
            lastName: "Editorhousehold",
            nickname: null,
            eventNames: ["Mehndi"],
          },
        ],
      },
    ],
  };

  it("previews then applies an editor DesiredState draft", async () => {
    const { app, db } = buildApp();

    const previewRes = await ownerPost(app, `${CHANGES_BASE}/preview`, { desiredState });
    expect(previewRes.status).toBe(200);
    const preview = (await previewRes.json()) as {
      changeId: string;
      plan: { warnings: unknown[] };
    };

    const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, { importId: preview.changeId });
    expect(applyRes.status).toBe(200);
    expect(db.select().from(events).all()).toHaveLength(1);
    expect(db.select().from(families).all()).toHaveLength(1);
    expect(db.select().from(guests).all()).toHaveLength(1);

    // The change is recorded as an EDITOR save in the history.
    const listRes = await ownerGet(app, `${CHANGES_BASE}/list`);
    const list = (await listRes.json()) as { imports: Array<{ kind: string; status: string }> };
    expect(list.imports[0]!.kind).toBe("editor");
    expect(list.imports[0]!.status).toBe("applied");
  });

  it("editor DesiredState manages everything shown — removes a household not in the draft", async () => {
    const { app, db } = buildApp();

    // First seed two households via a CSV import.
    const seed = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    await ownerPost(app, `${CHANGES_BASE}/apply`, {
      importId: ((await seed.json()) as { changeId: string }).changeId,
    });
    expect(db.select().from(families).all()).toHaveLength(2);

    // Now an editor save that shows only ONE household (the draft is the whole
    // truth) → the other imported household must be removed even though it is
    // source='import' and absent (removeManual is implicit for the editor).
    const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, { desiredState });
    await ownerPost(app, `${CHANGES_BASE}/apply`, {
      importId: ((await preview.json()) as { changeId: string }).changeId,
    });

    const remaining = db.select().from(families).all();
    expect(remaining.map((f) => f.familyName)).toEqual(["Editorhousehold"]);
  });
});

// ── Optimistic concurrency: 409 on stale baseRevision ───────────────────────

describe("POST /changes/apply — 409 on stale baseRevision", () => {
  it("409s a preview whose baseRevision moved (a concurrent apply landed)", async () => {
    const { app } = buildApp();

    // Preview A at genesis.
    const previewA = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    const idA = ((await previewA.json()) as { changeId: string }).changeId;

    // Preview B ALSO at genesis, then apply B — this advances the head.
    const previewB = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    const idB = ((await previewB.json()) as { changeId: string }).changeId;
    const applyB = await ownerPost(app, `${CHANGES_BASE}/apply`, { importId: idB });
    expect(applyB.status).toBe(200);

    // Applying A now must 409 — the wedding changed under it since preview.
    const applyA = await ownerPost(app, `${CHANGES_BASE}/apply`, { importId: idA });
    expect(applyA.status).toBe(409);
    const body = (await applyA.json()) as { error: string; currentRevision: string };
    expect(body.error).toBe("State changed — re-preview");
    expect(body.currentRevision).toBe(idB);
  });

  it("does NOT 409 when only a second preview (no apply) intervened", async () => {
    const { app } = buildApp();
    const previewA = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    const idA = ((await previewA.json()) as { changeId: string }).changeId;
    // A second preview mutates nothing (status stays 'preview'), so the head is
    // unchanged and A still applies.
    await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    const applyA = await ownerPost(app, `${CHANGES_BASE}/apply`, { importId: idA });
    expect(applyA.status).toBe(200);
  });
});

// ── Revert through /changes ─────────────────────────────────────────────────

describe("POST /changes/revert", () => {
  it("reverts an applied change to its before-image", async () => {
    const { app, db } = buildApp();

    const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    const id = ((await preview.json()) as { changeId: string }).changeId;
    await ownerPost(app, `${CHANGES_BASE}/apply`, { importId: id });
    expect(db.select().from(families).all()).toHaveLength(2);

    const revert = await ownerPost(app, `${CHANGES_BASE}/revert`, { importId: id });
    expect(revert.status).toBe(200);
    // Before-image was the empty pre-import state → revert clears the families.
    expect(db.select().from(families).all()).toHaveLength(0);
  });
});

// ── Provenance default at the route (CSV toggle) ────────────────────────────

describe("POST /changes/preview — provenance default + removeManual toggle", () => {
  async function seedManual(
    app: ReturnType<typeof buildApp>["app"],
    db: ReturnType<typeof buildApp>["db"],
  ) {
    // Import two households, then hand-add a manual one.
    const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    await ownerPost(app, `${CHANGES_BASE}/apply`, {
      importId: ((await preview.json()) as { changeId: string }).changeId,
    });
    const now = new Date();
    db.insert(families)
      .values({
        id: crypto.randomUUID(),
        weddingId: BOOTSTRAP_WEDDING_ID,
        publicId: "MANUAL-ROUTE-0001",
        familyName: "Handadded",
        source: "manual",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  it("default: a CSV re-import leaves the manual household intact", async () => {
    const { app, db } = buildApp();
    await seedManual(app, db);

    const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    const plan = (
      (await preview.json()) as { plan: { familyRemoves: Array<{ familyName: string }> } }
    ).plan;
    expect(plan.familyRemoves.map((f) => f.familyName)).not.toContain("Handadded");
  });

  it("removeManual=true: the CSV re-import removes the manual household", async () => {
    const { app, db } = buildApp();
    await seedManual(app, db);

    const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
      removeManual: true,
    });
    const plan = (
      (await preview.json()) as { plan: { familyRemoves: Array<{ familyName: string }> } }
    ).plan;
    expect(plan.familyRemoves.map((f) => f.familyName)).toContain("Handadded");
  });
});

// ── Alias: /changes and /import serve identically ───────────────────────────

describe("one-release alias — /import/* and /changes/* serve identically", () => {
  it("a CSV preview through /import matches one through /changes (same plan counts)", async () => {
    const { app } = buildApp();

    const viaChanges = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    const viaImport = await ownerPost(app, `${IMPORT_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    expect(viaChanges.status).toBe(200);
    expect(viaImport.status).toBe(200);

    const c = (await viaChanges.json()) as {
      plan: Record<string, unknown[]>;
      baseRevision: string;
    };
    const i = (await viaImport.json()) as { plan: Record<string, unknown[]>; baseRevision: string };
    // Same pipeline → same plan counts + same baseRevision.
    expect(i.baseRevision).toBe(c.baseRevision);
    for (const key of Object.keys(c.plan)) {
      expect((i.plan[key] ?? []).length).toBe((c.plan[key] ?? []).length);
    }
  });

  it("the editor DesiredState front door works through the /import alias too", async () => {
    const { app, db } = buildApp();
    const previewRes = await ownerPost(app, `${IMPORT_BASE}/preview`, {
      desiredState: {
        events: [],
        families: [
          {
            publicId: "ALIAS-FAM-0001",
            familyName: "Aliasedit",
            guests: [{ firstName: "Pat", lastName: "Aliasedit", nickname: null, eventNames: [] }],
          },
        ],
      },
    });
    expect(previewRes.status).toBe(200);
    const id = ((await previewRes.json()) as { changeId: string }).changeId;
    const applyRes = await ownerPost(app, `${IMPORT_BASE}/apply`, { importId: id });
    expect(applyRes.status).toBe(200);
    expect(db.select().from(families).all()).toHaveLength(1);
  });
});

// ── Authz + multi-tenant isolation on /changes ──────────────────────────────

describe("authz — /changes gate", () => {
  it("401 without an OSN JWT", async () => {
    const { app } = buildApp();
    const res = await appRequest(app, `${CHANGES_BASE}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV }),
    });
    expect(res.status).toBe(401);
  });

  it("403 read_only_role for a viewer co-host", async () => {
    const { app, db } = buildApp();
    db.insert(weddingHosts)
      .values({
        id: "whost_changes_viewer",
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId: "usr_changes_viewer",
        addedByOsnProfileId: "usr_dev_bootstrap_owner",
        role: "viewer",
        createdAt: new Date(),
      })
      .run();

    const res = await appRequest(app, `${CHANGES_BASE}/preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${await auth.sign("usr_changes_viewer")}`,
      },
      body: JSON.stringify({ eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "read_only_role" });
  });

  it("lets an editor co-host preview + apply", async () => {
    const { app, db } = buildApp();
    db.insert(weddingHosts)
      .values({
        id: "whost_changes_editor",
        weddingId: BOOTSTRAP_WEDDING_ID,
        osnProfileId: "usr_changes_editor",
        addedByOsnProfileId: "usr_dev_bootstrap_owner",
        role: "editor",
        createdAt: new Date(),
      })
      .run();
    const editorBearer = await auth.sign("usr_changes_editor");
    const previewRes = await appRequest(app, `${CHANGES_BASE}/preview`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${editorBearer}` },
      body: JSON.stringify({ eventsCsv: EVENTS_CSV, guestsCsv: GUESTS_CSV }),
    });
    expect(previewRes.status).toBe(200);
    const id = ((await previewRes.json()) as { changeId: string }).changeId;
    const applyRes = await appRequest(app, `${CHANGES_BASE}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${editorBearer}` },
      body: JSON.stringify({ importId: id }),
    });
    expect(applyRes.status).toBe(200);
  });

  it("multi-tenant: a change previewed on one wedding cannot be applied via another", async () => {
    const { app, db } = buildApp();

    // A second wedding owned by the same caller.
    const OTHER = "wed_other_changes";
    const now = new Date();
    db.insert(weddings)
      .values({
        id: OTHER,
        slug: "other-changes",
        displayName: "Other",
        ownerOsnProfileId: "usr_dev_bootstrap_owner",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const preview = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv: GUESTS_CSV,
    });
    const id = ((await preview.json()) as { changeId: string }).changeId;

    // Apply the bootstrap-wedding change through the OTHER wedding's path → 404.
    const applyOther = await appRequest(app, `/api/organiser/weddings/${OTHER}/changes/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
      body: JSON.stringify({ importId: id }),
    });
    expect(applyOther.status).toBe(404);
  });
});

// ── Capacity enforcement: 402 on breach ─────────────────────────────────────

describe("POST /changes/apply — 402 on capacity breach", () => {
  /**
   * Build a CSV with N guests in a single family, using EVENTS_CSV events.
   * Each guest is invited to no events (all 'no') to keep the CSV simple.
   */
  function buildLargeGuestsCsv(n: number): string {
    const header = "Family ID,Family Name,Guest First Name,Guest Last Name,Mehndi,Reception";
    const rows = Array.from({ length: n }, (_, i) => `1,Bigfamily,Guest${i},Bigfamily,no,no`);
    return [header, ...rows].join("\n");
  }

  it("applying a change that would exceed the cap returns 402 with payment_required body and persists no guests", async () => {
    const { app, db } = buildApp();

    // Preview + apply 101 guests (cap is 100, no capacity entitlement).
    const guestsCsv = buildLargeGuestsCsv(101);

    const previewRes = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv,
    });
    expect(previewRes.status).toBe(200);
    const { changeId } = (await previewRes.json()) as { changeId: string };

    const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, { importId: changeId });
    expect(applyRes.status).toBe(402);
    const body = (await applyRes.json()) as Record<string, unknown>;
    expect(body.error).toBe("payment_required");
    expect(body.entitlement).toBe("capacity");
    expect(body.limit).toBe(100);
    expect(typeof body.current).toBe("number");

    // Atomic: no guests were persisted.
    expect(db.select().from(guests).all()).toHaveLength(0);
    expect(db.select().from(families).all()).toHaveLength(0);
  });

  it("applying a change within cap succeeds; upgraded wedding (capacity_500) admits up to 500", async () => {
    const { app, db } = buildApp();

    // Grant capacity_500 to the bootstrap wedding.
    db.insert(weddingEntitlements)
      .values({
        weddingId: BOOTSTRAP_WEDDING_ID,
        entitlement: "capacity_500",
        source: "comp",
        grantedAt: new Date(),
        grantedBy: "usr_admin",
      })
      .run();

    // 101 guests < 500 → should succeed.
    const guestsCsv = buildLargeGuestsCsv(101);
    const previewRes = await ownerPost(app, `${CHANGES_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv,
    });
    const { changeId } = (await previewRes.json()) as { changeId: string };

    const applyRes = await ownerPost(app, `${CHANGES_BASE}/apply`, { importId: changeId });
    expect(applyRes.status).toBe(200);
    expect(db.select().from(guests).all()).toHaveLength(101);
  });

  it("the /import alias also returns 402 on capacity breach — full contract + atomicity", async () => {
    const { app, db } = buildApp();

    const guestsCsv = buildLargeGuestsCsv(101);

    const previewRes = await ownerPost(app, `${IMPORT_BASE}/preview`, {
      eventsCsv: EVENTS_CSV,
      guestsCsv,
    });
    expect(previewRes.status).toBe(200);
    const { importId } = (await previewRes.json()) as { importId: string };

    const applyRes = await ownerPost(app, `${IMPORT_BASE}/apply`, { importId });
    expect(applyRes.status).toBe(402);
    const body = (await applyRes.json()) as Record<string, unknown>;
    // Full 402 body contract — must match /changes/apply exactly.
    expect(body.error).toBe("payment_required");
    expect(body.entitlement).toBe("capacity");
    expect(body.limit).toBe(100);
    expect(typeof body.current).toBe("number");

    // Atomic: neither guests nor families persisted via the /import alias.
    expect(db.select().from(guests).all()).toHaveLength(0);
    expect(db.select().from(families).all()).toHaveLength(0);
  });
});
