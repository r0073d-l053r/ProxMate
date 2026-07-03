/*
  Warnings:

  - You are about to alter the column `size` on the `MateState` table. The data in that column could be lost. The data in that column will be cast from `Int` to `BigInt`.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_MateState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vmId" TEXT NOT NULL,
    "proxmoxVmId" INTEGER NOT NULL,
    "proxmoxNode" TEXT NOT NULL,
    "storage" TEXT NOT NULL,
    "volid" TEXT NOT NULL,
    "size" BIGINT NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'creating',
    "kind" TEXT NOT NULL DEFAULT 'scheduled',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MateState_vmId_fkey" FOREIGN KEY ("vmId") REFERENCES "VirtualMachine" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_MateState" ("createdAt", "id", "kind", "notes", "proxmoxNode", "proxmoxVmId", "size", "status", "storage", "updatedAt", "vmId", "volid") SELECT "createdAt", "id", "kind", "notes", "proxmoxNode", "proxmoxVmId", "size", "status", "storage", "updatedAt", "vmId", "volid" FROM "MateState";
DROP TABLE "MateState";
ALTER TABLE "new_MateState" RENAME TO "MateState";
CREATE UNIQUE INDEX "MateState_volid_key" ON "MateState"("volid");
CREATE INDEX "MateState_vmId_idx" ON "MateState"("vmId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
