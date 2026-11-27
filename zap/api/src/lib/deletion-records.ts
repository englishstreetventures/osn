import {
  type DeletionRecordStore,
  instrumentDeletionRecords as instrument,
} from "@shared/db-utils/deletion-records";

import { metricDeletionRecordWrite } from "../metrics";

/**
 * zap-api's deletion-record store (`zap-deletion-records`), each write traced as `zap.deletion_record.write` and counted on
 * `zap.deletion.record.writes`; a failed one is logged with its kind and the
 * error's tag, never an id (`@shared/db-utils/deletion-records`).
 */
export const instrumentDeletionRecords = (store: DeletionRecordStore): DeletionRecordStore =>
  instrument(store, { spanName: "zap.deletion_record.write", count: metricDeletionRecordWrite });
