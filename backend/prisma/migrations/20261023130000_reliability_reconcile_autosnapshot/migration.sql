-- AlterTable
ALTER TABLE "VirtualMachine" ADD COLUMN "opKind" TEXT;
ALTER TABLE "VirtualMachine" ADD COLUMN "opStartedAt" DATETIME;
ALTER TABLE "VirtualMachine" ADD COLUMN "opUpid" TEXT;
ALTER TABLE "VirtualMachine" ADD COLUMN "opSourceId" TEXT;
ALTER TABLE "VirtualMachine" ADD COLUMN "opArchive" TEXT;

-- AlterTable
ALTER TABLE "MateState" ADD COLUMN "upid" TEXT;

-- CreateTable
CREATE TABLE "AutoSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "vmId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "snaptime" INTEGER,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "AutoSnapshot_vmId_fkey" FOREIGN KEY ("vmId") REFERENCES "VirtualMachine" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "AutoSnapshot_vmId_name_key" ON "AutoSnapshot"("vmId", "name");
