-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
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
    "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" DATETIME,
    "maxCpu" INTEGER NOT NULL DEFAULT 0,
    "maxRam" INTEGER NOT NULL DEFAULT 0,
    "maxStorage" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_User" ("createdAt", "displayName", "email", "id", "maxCpu", "maxRam", "maxStorage", "passwordHash", "require2fa", "role", "ssoSubject", "twoFactorEnabled", "twoFactorSecret", "updatedAt") SELECT "createdAt", "displayName", "email", "id", "maxCpu", "maxRam", "maxStorage", "passwordHash", "require2fa", "role", "ssoSubject", "twoFactorEnabled", "twoFactorSecret", "updatedAt" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_ssoSubject_key" ON "User"("ssoSubject");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
