-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_InviteToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "createdById" TEXT,
    "label" TEXT,
    "email" TEXT,
    "maxCpu" INTEGER NOT NULL,
    "maxRam" INTEGER NOT NULL,
    "maxStorage" INTEGER NOT NULL,
    "require2fa" BOOLEAN NOT NULL DEFAULT false,
    "accessDuration" TEXT,
    "usedById" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InviteToken_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "InviteToken_usedById_fkey" FOREIGN KEY ("usedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_InviteToken" ("accessDuration", "createdAt", "createdById", "email", "expiresAt", "id", "label", "maxCpu", "maxRam", "maxStorage", "require2fa", "token", "usedById") SELECT "accessDuration", "createdAt", "createdById", "email", "expiresAt", "id", "label", "maxCpu", "maxRam", "maxStorage", "require2fa", "token", "usedById" FROM "InviteToken";
DROP TABLE "InviteToken";
ALTER TABLE "new_InviteToken" RENAME TO "InviteToken";
CREATE UNIQUE INDEX "InviteToken_token_key" ON "InviteToken"("token");
CREATE UNIQUE INDEX "InviteToken_usedById_key" ON "InviteToken"("usedById");
CREATE INDEX "InviteToken_token_idx" ON "InviteToken"("token");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

