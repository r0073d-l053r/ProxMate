-- Per-VM tenant alert rules (CPU/memory/disk/down), evaluated on the sampling tick.
CREATE TABLE "AlertRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vmId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "metric" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL DEFAULT 0,
    "sustainedMin" INTEGER NOT NULL DEFAULT 5,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "breachingSince" DATETIME,
    "lastFiredAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "AlertRule_vmId_fkey" FOREIGN KEY ("vmId") REFERENCES "VirtualMachine" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AlertRule_vmId_idx" ON "AlertRule"("vmId");
CREATE INDEX "AlertRule_userId_idx" ON "AlertRule"("userId");
