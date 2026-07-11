-- CreateTable
CREATE TABLE "IdeGatewayToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "vmId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "lastUsedAt" DATETIME,
    "expiresAt" DATETIME,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IdeGatewayToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TenantLlmKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "baseUrl" TEXT,
    "keyEnc" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    CONSTRAINT "TenantLlmKey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "IdeGatewayToken_tokenHash_key" ON "IdeGatewayToken"("tokenHash");

-- CreateIndex
CREATE INDEX "IdeGatewayToken_vmId_idx" ON "IdeGatewayToken"("vmId");

-- CreateIndex
CREATE UNIQUE INDEX "IdeGatewayToken_userId_vmId_key" ON "IdeGatewayToken"("userId", "vmId");

-- CreateIndex
CREATE INDEX "TenantLlmKey_userId_idx" ON "TenantLlmKey"("userId");
