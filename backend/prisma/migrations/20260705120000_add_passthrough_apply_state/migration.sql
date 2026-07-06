-- AlterTable: passthrough approval now runs in the background (it may stop and
-- offline-migrate the VM to the device's node before attaching). The worker
-- records progress here so the admin UI can poll state / surface failures.
ALTER TABLE "PassthroughRequest" ADD COLUMN "applyState" TEXT;
ALTER TABLE "PassthroughRequest" ADD COLUMN "applyError" TEXT;
ALTER TABLE "PassthroughRequest" ADD COLUMN "targetNode" TEXT;
