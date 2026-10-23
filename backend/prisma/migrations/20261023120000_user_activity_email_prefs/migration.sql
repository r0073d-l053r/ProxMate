-- Per-user email preferences: activity emails (deploy-for-tenant, VM shares) are
-- on unless opted out; the weekly usage digest is off unless opted in.
ALTER TABLE "User" ADD COLUMN "activityEmailOptOut" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "usageDigestOptIn" BOOLEAN NOT NULL DEFAULT false;
