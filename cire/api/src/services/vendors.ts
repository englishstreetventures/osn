/**
 * Vendor CRM service (platform Phase 1) — wedding-scoped vendor tracking.
 * Organiser-private: every write scopes by `wedding_id` so a cross-tenant id
 * fails `VendorNotInWedding` rather than touching a row.
 *
 * TENANCY: the route gate proves the caller may touch `weddingId`. Every write
 * here ADDITIONALLY scopes by `wedding_id`, so an editor of wedding A can never
 * mutate wedding B's vendor even with a leaked id.
 */
import { vendors } from "@cire/db";
import { and, asc, eq } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";

/** No vendor with this id under this wedding (missing or another wedding's). 404-class. */
export class VendorNotInWedding extends Data.TaggedError("VendorNotInWedding") {}

export interface VendorDto {
  id: string;
  weddingId: string;
  directoryVendorId: string | null;
  name: string;
  category: string;
  status: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  quotedMinor: number | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateVendorInput {
  weddingId: string;
  name: string;
  category: string;
  status?: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  quotedMinor: number | null;
  directoryVendorId?: string | null;
}

export interface UpdateVendorPatch {
  name?: string;
  category?: string;
  status?: string;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  quotedMinor?: number | null;
}

interface VendorRow {
  id: string;
  weddingId: string;
  directoryVendorId: string | null;
  name: string;
  category: string;
  status: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  quotedMinor: number | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

const toDto = (r: VendorRow): VendorDto => ({
  id: r.id,
  weddingId: r.weddingId,
  directoryVendorId: r.directoryVendorId,
  name: r.name,
  category: r.category,
  status: r.status,
  contactName: r.contactName,
  email: r.email,
  phone: r.phone,
  notes: r.notes,
  quotedMinor: r.quotedMinor,
  sortOrder: r.sortOrder,
  createdAt: r.createdAt.getTime(),
  updatedAt: r.updatedAt.getTime(),
});

/** Load the vendor, scoped to the wedding, or fail 404-class. */
function requireVendor(
  weddingId: string,
  vendorId: string,
): Effect.Effect<VendorRow, VendorNotInWedding, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const [row] = yield* dbQuery(() =>
      db
        .select()
        .from(vendors)
        .where(and(eq(vendors.id, vendorId), eq(vendors.weddingId, weddingId)))
        .all(),
    );
    if (!row) return yield* Effect.fail(new VendorNotInWedding());
    return row as VendorRow;
  });
}

export const vendorsService = {
  list(weddingId: string): Effect.Effect<VendorDto[], never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const rows = yield* dbQuery(() =>
        db
          .select()
          .from(vendors)
          .where(eq(vendors.weddingId, weddingId))
          .orderBy(asc(vendors.status), asc(vendors.sortOrder))
          .all(),
      );
      return (rows as VendorRow[]).map(toDto);
    }).pipe(Effect.withSpan("cire.vendors.list"));
  },

  create(input: CreateVendorInput): Effect.Effect<VendorDto, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const status = input.status ?? "researching";
      // Append to end of (wedding, status) group.
      const existing = yield* dbQuery(() =>
        db
          .select({ sortOrder: vendors.sortOrder })
          .from(vendors)
          .where(and(eq(vendors.weddingId, input.weddingId), eq(vendors.status, status)))
          .all(),
      );
      const maxSort = (existing as { sortOrder: number }[]).reduce(
        (m, r) => Math.max(m, r.sortOrder),
        -1,
      );
      const id = `ven_${crypto.randomUUID()}`;
      const now = new Date();
      const row: VendorRow = {
        id,
        weddingId: input.weddingId,
        directoryVendorId: input.directoryVendorId ?? null,
        name: input.name,
        category: input.category,
        status,
        contactName: input.contactName,
        email: input.email,
        phone: input.phone,
        notes: input.notes,
        quotedMinor: input.quotedMinor,
        sortOrder: maxSort + 1,
        createdAt: now,
        updatedAt: now,
      };
      yield* dbQuery(() => db.insert(vendors).values(row).run());
      return toDto(row);
    }).pipe(Effect.withSpan("cire.vendors.create"));
  },

  update(
    weddingId: string,
    vendorId: string,
    patch: UpdateVendorPatch,
  ): Effect.Effect<VendorDto, VendorNotInWedding, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      yield* requireVendor(weddingId, vendorId);

      const set: Partial<VendorRow> = { updatedAt: new Date() };
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.category !== undefined) set.category = patch.category;
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.contactName !== undefined) set.contactName = patch.contactName;
      if (patch.email !== undefined) set.email = patch.email;
      if (patch.phone !== undefined) set.phone = patch.phone;
      if (patch.notes !== undefined) set.notes = patch.notes;
      if (patch.quotedMinor !== undefined) set.quotedMinor = patch.quotedMinor;

      yield* dbQuery(() =>
        db
          .update(vendors)
          .set(set)
          .where(and(eq(vendors.id, vendorId), eq(vendors.weddingId, weddingId)))
          .run(),
      );
      const updated = yield* requireVendor(weddingId, vendorId);
      return toDto(updated);
    }).pipe(Effect.withSpan("cire.vendors.update"));
  },

  remove(weddingId: string, vendorId: string): Effect.Effect<void, VendorNotInWedding, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      yield* requireVendor(weddingId, vendorId);
      yield* dbQuery(() =>
        db
          .delete(vendors)
          .where(and(eq(vendors.id, vendorId), eq(vendors.weddingId, weddingId)))
          .run(),
      );
    }).pipe(Effect.withSpan("cire.vendors.remove"));
  },

  reorder(
    weddingId: string,
    status: string,
    orderedIds: readonly string[],
  ): Effect.Effect<void, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // Each id gets its array index as sort_order, scoped to (wedding, status)
      // so a foreign or wrong-status id is a no-op UPDATE rather than a write.
      yield* dbQuery(() =>
        db.transaction((tx) => {
          orderedIds.forEach((id, index) => {
            tx.update(vendors)
              .set({ sortOrder: index })
              .where(
                and(
                  eq(vendors.id, id),
                  eq(vendors.weddingId, weddingId),
                  eq(vendors.status, status),
                ),
              )
              .run();
          });
        }),
      );
    }).pipe(Effect.withSpan("cire.vendors.reorder"));
  },
};
