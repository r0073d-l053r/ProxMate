-- CreateTable
CREATE TABLE "ResourceSample" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "vmId" TEXT NOT NULL,
    "cpu" REAL NOT NULL,
    "mem" REAL NOT NULL,
    "maxmem" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "ResourceSample_createdAt_idx" ON "ResourceSample"("createdAt");

-- CreateIndex
CREATE INDEX "ResourceSample_userId_idx" ON "ResourceSample"("userId");
