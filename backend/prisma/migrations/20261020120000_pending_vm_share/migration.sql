-- CreateTable
CREATE TABLE "PendingVmShare" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vmId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'viewer',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "PendingVmShare_vmId_fkey" FOREIGN KEY ("vmId") REFERENCES "VirtualMachine" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "PendingVmShare_email_idx" ON "PendingVmShare"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PendingVmShare_vmId_email_key" ON "PendingVmShare"("vmId", "email");
