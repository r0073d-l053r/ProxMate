import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Deleting an account that created invites must succeed at the database level:
// a redeemed invite stays as history with no creator, and nothing blocks the delete.

const MIGRATIONS = path.resolve(__dirname, '../prisma/migrations');

function migratedDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  for (const dir of readdirSync(MIGRATIONS).filter((d) => /^\d+_/.test(d)).sort()) {
    db.exec(readFileSync(path.join(MIGRATIONS, dir, 'migration.sql'), 'utf8'));
  }
  db.exec('PRAGMA foreign_keys=ON');
  return db;
}

function addUser(db: DatabaseSync, id: string, role: string) {
  db.prepare(
    `INSERT INTO "User" ("id","email","passwordHash","displayName","role","updatedAt") VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)`,
  ).run(id, `${id}@example.com`, 'x', id, role);
}

describe('InviteToken.createdById', () => {
  it('does not block deleting the admin who created an invite, and keeps the redeemed invite', () => {
    const db = migratedDb();
    addUser(db, 'admin2', 'admin');
    addUser(db, 'tenant', 'user');
    db.prepare(
      `INSERT INTO "InviteToken" ("id","token","createdById","maxCpu","maxRam","maxStorage","usedById","expiresAt") VALUES ('i1','t1','admin2',1,1024,10,'tenant',CURRENT_TIMESTAMP)`,
    ).run();

    expect(() => db.prepare(`DELETE FROM "User" WHERE "id" = 'admin2'`).run()).not.toThrow();
    const row = db.prepare(`SELECT "createdById", "usedById" FROM "InviteToken" WHERE "id" = 'i1'`).get();
    expect({ ...row }).toEqual({ createdById: null, usedById: 'tenant' });
  });
});
