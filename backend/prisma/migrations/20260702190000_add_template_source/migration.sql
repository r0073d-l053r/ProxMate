-- Cloud-image provenance so the Template Store can rebuild a fresh, patched template.
ALTER TABLE "Template" ADD COLUMN "sourceUrl" TEXT;
ALTER TABLE "Template" ADD COLUMN "refreshedAt" DATETIME;
