-- AlterTable: track cloud-init drives dropped during a passthrough migration so
-- a startup reconciler can restore them if the backend restarts mid-migration
-- (a large disk relocation can take hours, outlasting a deploy).
ALTER TABLE "PassthroughRequest" ADD COLUMN "ciDropped" TEXT;
