-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_InviteToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "token" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "label" TEXT,
    "maxCpu" INTEGER NOT NULL,
    "maxRam" INTEGER NOT NULL,
    "maxStorage" INTEGER NOT NULL,
    "require2fa" BOOLEAN NOT NULL DEFAULT false,
    "usedById" TEXT,
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "InviteToken_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "InviteToken_usedById_fkey" FOREIGN KEY ("usedById") REFERENCES "User" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_InviteToken" ("createdAt", "createdById", "expiresAt", "id", "label", "maxCpu", "maxRam", "maxStorage", "token", "usedById") SELECT "createdAt", "createdById", "expiresAt", "id", "label", "maxCpu", "maxRam", "maxStorage", "token", "usedById" FROM "InviteToken";
DROP TABLE "InviteToken";
ALTER TABLE "new_InviteToken" RENAME TO "InviteToken";
CREATE UNIQUE INDEX "InviteToken_token_key" ON "InviteToken"("token");
CREATE UNIQUE INDEX "InviteToken_usedById_key" ON "InviteToken"("usedById");
CREATE INDEX "InviteToken_token_idx" ON "InviteToken"("token");
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'user',
    "ssoSubject" TEXT,
    "twoFactorEnabled" BOOLEAN NOT NULL DEFAULT false,
    "twoFactorSecret" TEXT,
    "require2fa" BOOLEAN NOT NULL DEFAULT false,
    "maxCpu" INTEGER NOT NULL DEFAULT 0,
    "maxRam" INTEGER NOT NULL DEFAULT 0,
    "maxStorage" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_User" ("createdAt", "displayName", "email", "id", "maxCpu", "maxRam", "maxStorage", "passwordHash", "role", "ssoSubject", "twoFactorEnabled", "twoFactorSecret", "updatedAt") SELECT "createdAt", "displayName", "email", "id", "maxCpu", "maxRam", "maxStorage", "passwordHash", "role", "ssoSubject", "twoFactorEnabled", "twoFactorSecret", "updatedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_ssoSubject_key" ON "User"("ssoSubject");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

