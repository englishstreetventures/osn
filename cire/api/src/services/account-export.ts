/**
 * cire's section of a person's account export (`GET /account/export` on
 * osn-api, which calls `routes/internal-account-export.ts` over ARC).
 *
 * It answers one `cire.weddings` record per seat a profile of the account
 * holds: the wedding, the role, when the seat was given and by whom, how many
 * other owners the wedding has, and, for an owner of a live wedding, where in
 * the host portal to download the whole wedding. The wedding's own data —
 * guests and their replies above all — is not the person's: an owner takes it
 * as the wedding's joint controller, from that download, and the export only
 * points there (`wiki/compliance/dsar.md`, "Co-owners in an owner's export").
 *
 * Every seat is answered, a soft-deleted wedding's too, since the seat is
 * still held until the purge. When the wedding is deleted it says so only to
 * someone who owns it or deleted it: cire never tells a co-host that a wedding
 * was deleted (`wiki/cire/cire-development.md`, "Soft-deleted weddings").
 * Other owners are counted and never named; the profile that gave the seat is
 * named, as the source of the person's data.
 */
import { weddingHosts, weddings } from "@cire/db";
import { jsonEachIn } from "@shared/db-utils";
import { asc, eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";

import { DbService, dbQuery, outerColumn } from "../db";
import { restoreUntil } from "../db/live-wedding";

/** Seats one answer lists; past it, a degraded line says the section is not whole. */
export const MAX_EXPORT_SEATS = 500;

/** One seat, in the account export's `cire.weddings` section. */
export interface WeddingSeatRecord {
  readonly weddingId: string;
  readonly name: string;
  /** Which of the account's profiles holds the seat. */
  readonly profileId: string;
  readonly role: string;
  readonly seatAddedAt: string;
  readonly seatAddedBy: string | null;
  /** Owner seats on the wedding held by none of the account's profiles. */
  readonly otherOwners: number;
  /** Set only for an owner of the wedding, or the one who deleted it. */
  readonly deletedAt: string | null;
  readonly restoreUntil: string | null;
  readonly deletedByYou: boolean;
  /** The host-portal page that downloads the whole wedding; an owner's, of a live wedding. */
  readonly download: string | null;
}

export type CireExportLine =
  | { readonly section: "cire.weddings"; readonly record: WeddingSeatRecord }
  | { readonly degraded: "cire"; readonly reason: "too_many_weddings" };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The portal's origin as a link may carry it: `https:`, or `http:` on a
 * loopback host for a local run (osn-api's own rule for app addresses); null
 * otherwise.
 */
function linkOrigin(origin: string): string | null {
  if (!URL.canParse(origin)) return null;
  const url = new URL(origin);
  if (url.protocol === "https:") return url.origin;
  return url.protocol === "http:" && LOOPBACK.has(url.hostname) ? url.origin : null;
}

/**
 * The host-portal page where an owner downloads the whole wedding
 * (`cire/host/src/lib/dashboard-route.ts`, Settings › Download).
 */
export const archivePageOf = (origin: string, weddingId: string): string =>
  `${origin}/#/w/${weddingId}/settings/export`;

export const accountExportService = {
  /**
   * The seats `profileIds` hold, oldest first, as the export's lines: at most
   * {@link MAX_EXPORT_SEATS}, then a degraded line when there were more. One
   * statement; a failed read dies, and the route answers 500.
   */
  weddingSeats(
    profileIds: ReadonlyArray<string>,
    organiserOrigin: string,
  ): Effect.Effect<CireExportLine[], never, DbService> {
    return Effect.gen(function* () {
      if (profileIds.length === 0) return [];
      const db = yield* DbService;
      const rows = yield* dbQuery(() =>
        db
          .select({
            weddingId: weddings.id,
            name: weddings.displayName,
            deletedAt: weddings.deletedAt,
            deletedBy: weddings.deletedByOsnProfileId,
            profileId: weddingHosts.osnProfileId,
            role: weddingHosts.role,
            seatAddedAt: weddingHosts.createdAt,
            seatAddedBy: weddingHosts.addedByOsnProfileId,
            otherOwners: sql<number>`(SELECT count(*) FROM ${weddingHosts} AS other WHERE other.wedding_id = ${outerColumn(weddingHosts.weddingId)} AND other.role = 'owner' AND other.osn_profile_id NOT IN ${jsonEachIn(profileIds)})`,
            ownsIt: sql<number>`EXISTS (SELECT 1 FROM ${weddingHosts} AS mine WHERE mine.wedding_id = ${outerColumn(weddingHosts.weddingId)} AND mine.role = 'owner' AND mine.osn_profile_id IN ${jsonEachIn(profileIds)})`,
          })
          .from(weddingHosts)
          .innerJoin(weddings, eq(weddings.id, weddingHosts.weddingId))
          .where(inArray(weddingHosts.osnProfileId, jsonEachIn(profileIds)))
          .orderBy(asc(weddingHosts.createdAt), asc(weddingHosts.id))
          .limit(MAX_EXPORT_SEATS + 1)
          .all(),
      );
      const origin = linkOrigin(organiserOrigin);
      const lines: CireExportLine[] = rows.slice(0, MAX_EXPORT_SEATS).map((row) => {
        const deletedByYou = row.deletedBy !== null && profileIds.includes(row.deletedBy);
        const told = row.deletedAt !== null && (Boolean(row.ownsIt) || deletedByYou);
        return {
          section: "cire.weddings",
          record: {
            weddingId: row.weddingId,
            name: row.name,
            profileId: row.profileId,
            role: row.role,
            seatAddedAt: row.seatAddedAt.toISOString(),
            seatAddedBy: row.seatAddedBy,
            otherOwners: Number(row.otherOwners),
            deletedAt: told && row.deletedAt ? row.deletedAt.toISOString() : null,
            restoreUntil: told && row.deletedAt ? restoreUntil(row.deletedAt).toISOString() : null,
            deletedByYou,
            download:
              row.role === "owner" && row.deletedAt === null && origin
                ? archivePageOf(origin, row.weddingId)
                : null,
          },
        };
      });
      if (rows.length > MAX_EXPORT_SEATS) {
        lines.push({ degraded: "cire", reason: "too_many_weddings" });
      }
      return lines;
    }).pipe(Effect.withSpan("cire.account_export.seats"));
  },
};
