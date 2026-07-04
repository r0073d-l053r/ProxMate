-- AlterTable: Community-Edition opt-out from admin broadcast (announcement)
-- emails. Defaults to false (subscribed) for all existing users. Transactional
-- and notification emails are unaffected by this flag.
ALTER TABLE "User" ADD COLUMN "broadcastOptOut" BOOLEAN NOT NULL DEFAULT false;
