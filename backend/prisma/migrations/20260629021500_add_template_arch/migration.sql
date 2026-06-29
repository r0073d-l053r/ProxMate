-- AlterTable: track each template's guest CPU architecture so deploys land on a
-- node of the matching arch (null = legacy/unknown, treated as amd64 on read).
ALTER TABLE "Template" ADD COLUMN "arch" TEXT;
