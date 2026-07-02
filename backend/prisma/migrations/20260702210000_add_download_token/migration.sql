-- Single-use, expiring tokens for tenant backup downloads (via a mounted share).
CREATE TABLE "DownloadToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "mateStateId" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "DownloadToken_tokenHash_key" ON "DownloadToken"("tokenHash");
CREATE INDEX "DownloadToken_expiresAt_idx" ON "DownloadToken"("expiresAt");
