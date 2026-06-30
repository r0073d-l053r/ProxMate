-- CreateTable
CREATE TABLE "QuotaRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "cpu" INTEGER NOT NULL,
    "ram" INTEGER NOT NULL,
    "storage" INTEGER NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "resolvedById" TEXT,
    CONSTRAINT "QuotaRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "QuotaRequest_userId_idx" ON "QuotaRequest"("userId");

-- CreateIndex
CREATE INDEX "QuotaRequest_status_idx" ON "QuotaRequest"("status");
