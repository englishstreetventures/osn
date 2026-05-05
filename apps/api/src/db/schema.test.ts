import { describe, it, expect } from "bun:test"
import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import { eq } from "drizzle-orm"
import * as schema from "@cire/db"
import { families, guests } from "@cire/db"

const DDL = `
CREATE TABLE families (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  family_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE guests (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
`

function makeDb() {
  const sqlite = new Database(":memory:")
  sqlite.exec("PRAGMA foreign_keys = ON;")
  sqlite.exec(DDL)
  return drizzle(sqlite, { schema })
}

const now = new Date()
const insertFamily = (
  db: ReturnType<typeof makeDb>,
  id: string,
  publicId: string,
  familyName: string,
) =>
  db.insert(families)
    .values({
      id,
      publicId,
      familyName,
      passwordHash: "pbkdf2$sha256$1$AAAA$BBBB",
      createdAt: now,
      updatedAt: now,
    })
    .run()

describe("families schema", () => {
  it("rejects a duplicate public_id", () => {
    const db = makeDb()
    insertFamily(db, "fam-1", "PRADHEEP-JOY-RK97", "Pradheep")
    expect(() => {
      insertFamily(db, "fam-2", "PRADHEEP-JOY-RK97", "Other")
    }).toThrow()
  })

  it("permits the same family_name for different families", () => {
    const db = makeDb()
    insertFamily(db, "fam-1", "PATEL-JOY-RK97", "Patel")
    insertFamily(db, "fam-2", "PATEL-SKY-XR42", "Patel")
    const rows = db.select().from(families).all()
    expect(rows).toHaveLength(2)
  })
})

describe("guests schema", () => {
  it("cascades deletion of a family to its guests", () => {
    const db = makeDb()
    insertFamily(db, "fam-1", "SHARMA-IVY-QM42", "Sharma")
    db.insert(guests)
      .values({
        id: "guest-1",
        familyId: "fam-1",
        firstName: "Priya",
        lastName: "Sharma",
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    expect(db.select().from(guests).all()).toHaveLength(1)

    db.delete(families).where(eq(families.id, "fam-1")).run()
    expect(db.select().from(guests).all()).toHaveLength(0)
  })

  it("rejects a guest whose family_id does not exist (FK enforcement)", () => {
    const db = makeDb()
    expect(() => {
      db.insert(guests)
        .values({
          id: "guest-1",
          familyId: "missing-family",
          firstName: "Orphan",
          lastName: "Guest",
          sortOrder: 0,
          createdAt: now,
          updatedAt: now,
        })
        .run()
    }).toThrow()
  })
})
