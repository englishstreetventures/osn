import { Layer } from "effect"
import { DbService } from "./index"
import { createDb, seedDb } from "./setup"

export const TestDbLayer = Layer.sync(DbService, () => {
  const db = createDb(":memory:")
  seedDb(db)
  return db
})
