-- AlterTable: cheap signal that a VM has a PCI/GPU device attached (can't migrate).
ALTER TABLE "VirtualMachine" ADD COLUMN "hasPassthrough" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable: GPU / PCI passthrough requests (mirrors QuotaRequest).
CREATE TABLE "PassthroughRequest" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "vmId" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "mapping" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME,
    "resolvedById" TEXT,
    CONSTRAINT "PassthroughRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "PassthroughRequest_vmId_fkey" FOREIGN KEY ("vmId") REFERENCES "VirtualMachine" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PassthroughRequest_userId_idx" ON "PassthroughRequest"("userId");

-- CreateIndex
CREATE INDEX "PassthroughRequest_vmId_idx" ON "PassthroughRequest"("vmId");

-- CreateIndex
CREATE INDEX "PassthroughRequest_status_idx" ON "PassthroughRequest"("status");
