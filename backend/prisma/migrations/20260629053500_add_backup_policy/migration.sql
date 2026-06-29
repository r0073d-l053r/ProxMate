-- AlterTable
ALTER TABLE "VirtualMachine" ADD COLUMN "backupCron" TEXT;
ALTER TABLE "VirtualMachine" ADD COLUMN "backupKeep" INTEGER;
