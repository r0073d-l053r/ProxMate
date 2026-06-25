-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Template" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "os" TEXT,
    "proxmoxVmId" INTEGER NOT NULL,
    "proxmoxNode" TEXT NOT NULL,
    "diskGb" INTEGER NOT NULL DEFAULT 0,
    "notes" TEXT,
    "cloudInit" BOOLEAN NOT NULL DEFAULT false,
    "published" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Template" ("createdAt", "description", "diskGb", "id", "name", "notes", "os", "proxmoxNode", "proxmoxVmId", "published", "updatedAt") SELECT "createdAt", "description", "diskGb", "id", "name", "notes", "os", "proxmoxNode", "proxmoxVmId", "published", "updatedAt" FROM "Template";
DROP TABLE "Template";
ALTER TABLE "new_Template" RENAME TO "Template";
CREATE UNIQUE INDEX "Template_proxmoxVmId_key" ON "Template"("proxmoxVmId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
