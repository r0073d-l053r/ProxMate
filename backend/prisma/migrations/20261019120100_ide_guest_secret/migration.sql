-- CreateTable
CREATE TABLE "IdeGuestSecret" (
    "vmId" TEXT NOT NULL PRIMARY KEY,
    "secretEnc" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
