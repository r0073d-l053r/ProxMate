-- Share roles become preset levels (viewer | operator | manager); capabilities
-- derive from the preset in code (vm-share.service.ts CAPS_BY_ROLE).
-- SQLite can't alter a column default in place → rebuild the table (Prisma-generated).
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_VmShare" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vmId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "VmShare_vmId_fkey" FOREIGN KEY ("vmId") REFERENCES "VirtualMachine" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "VmShare_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_VmShare" ("createdAt", "id", "role", "userId", "vmId") SELECT "createdAt", "id", "role", "userId", "vmId" FROM "VmShare";
DROP TABLE "VmShare";
ALTER TABLE "new_VmShare" RENAME TO "VmShare";
CREATE INDEX "VmShare_userId_idx" ON "VmShare"("userId");
CREATE UNIQUE INDEX "VmShare_vmId_userId_key" ON "VmShare"("vmId", "userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- Migrate existing grants: co-owner → manager, read-only → viewer.
UPDATE "VmShare" SET "role" = 'manager' WHERE "role" = 'co-owner';
UPDATE "VmShare" SET "role" = 'viewer' WHERE "role" = 'read-only';
