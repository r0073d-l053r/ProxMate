-- AlterTable
ALTER TABLE "User" ADD COLUMN "emailBound" BOOLEAN NOT NULL DEFAULT false;

-- Backfill: accounts registered through an invite addressed to that same email,
-- and the setup-wizard admin (an admin that redeemed no invite and was not
-- created through SSO).
UPDATE "User" SET "emailBound" = true
WHERE "id" IN (
  SELECT i."usedById" FROM "InviteToken" i
  JOIN "User" u ON u."id" = i."usedById"
  WHERE i."email" IS NOT NULL AND lower(trim(i."email")) = u."email"
);
UPDATE "User" SET "emailBound" = true
WHERE "role" = 'admin' AND "ssoSubject" IS NULL
  AND "id" NOT IN (SELECT "usedById" FROM "InviteToken" WHERE "usedById" IS NOT NULL);
