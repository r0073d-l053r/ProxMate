-- AlterTable
ALTER TABLE "User" ADD COLUMN "ssoSubject" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_ssoSubject_key" ON "User"("ssoSubject");
