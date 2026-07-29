-- AlterTable
ALTER TABLE "InviteToken" ADD COLUMN "accessDuration" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN "accessExpiresAt" DATETIME;
ALTER TABLE "User" ADD COLUMN "accessSuspendedAt" DATETIME;
ALTER TABLE "User" ADD COLUMN "accessWarned1For" DATETIME;
ALTER TABLE "User" ADD COLUMN "accessWarned7For" DATETIME;
