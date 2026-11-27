import {
  type DeletionRecordStore,
  instrumentDeletionRecords as instrument,
} from "@shared/db-utils/deletion-records";

import { metricDeletionRecordWrite } from "../metrics";

export { neverBlocking } from "@shared/db-utils/deletion-records";

/**
 * osn-api's deletion-record store (`osn-deletion-records`), each write traced as `osn.deletion_record.write` and counted on
 * `osn.deletion.record.writes`; a failed one is logged with its kind and the
 * error's tag, never an id (`@shared/db-utils/deletion-records`).
 */
export const instrumentDeletionRecords = (store: DeletionRecordStore): DeletionRecordStore =>
  instrument(store, { spanName: "osn.deletion_record.write", count: metricDeletionRecordWrite });
