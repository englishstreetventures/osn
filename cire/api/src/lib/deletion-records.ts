import {
  type DeletionRecordStore,
  type ErasureOutcome,
  instrumentDeletionRecords as instrument,
} from "@shared/db-utils/deletion-records";

import { metricDeletionRecordWrite } from "../metrics";
import type { ErasureProgress } from "../services/account-erasure";

export { neverBlocking, settleDeletionRecord } from "@shared/db-utils/deletion-records";

/**
 * cire-api's deletion-record store (`cire-deletion-records`), each write
 * traced as `cire.deletion_record.write` and counted on
 * `cire.deletion.record.writes`; a failed one is logged with its kind and the
 * error's tag, never an id (`@shared/db-utils/deletion-records`).
 */
export const instrumentDeletionRecords = (store: DeletionRecordStore): DeletionRecordStore =>
  instrument(store, { spanName: "cire.deletion_record.write", count: metricDeletionRecordWrite });

/**
 * What one call of the account erasure did, for its record, read from the
 * progress it kept (`services/account-erasure.ts`): the weddings it deleted,
 * every seat of the account it removed (its weddings' batches and its
 * clean-up's), and the batch it had sent when it stopped. A replay deletes
 * only the weddings listed as deleted and takes only the seats listed, however
 * the restored rows stand.
 */
export const erasureOutcome = (progress: ErasureProgress, finished: boolean): ErasureOutcome => {
  const writing = progress.writing;
  return {
    deletedWeddings: progress.owned.filter((o) => o.outcome === "deleted").map((o) => o.weddingId),
    removedSeats: [
      ...progress.owned.flatMap(({ weddingId, seatHolders }) =>
        seatHolders.map((profileId) => ({ weddingId, profileId })),
      ),
      ...progress.lowerSeats,
    ],
    unsettledWeddings: writing !== null && writing !== "clean_up" ? [writing.weddingId] : [],
    cleanUp: progress.cleanedUp ? "done" : writing === "clean_up" ? "unsettled" : "not_run",
    finished,
  };
};
