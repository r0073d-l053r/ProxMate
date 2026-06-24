-- CreateTable
CREATE TABLE "MateState" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vmId" TEXT NOT NULL,
    "proxmoxVmId" INTEGER NOT NULL,
    "proxmoxNode" TEXT NOT NULL,
    "storage" TEXT NOT NULL,
    "volid" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'creating',
    "kind" TEXT NOT NULL DEFAULT 'scheduled',
    "notes" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MateState_vmId_fkey" FOREIGN KEY ("vmId") REFERENCES "VirtualMachine" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "MateState_volid_key" ON "MateState"("volid");

-- CreateIndex
CREATE INDEX "MateState_vmId_idx" ON "MateState"("vmId");
