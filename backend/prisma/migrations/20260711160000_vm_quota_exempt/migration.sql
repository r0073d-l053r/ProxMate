-- Admin-granted VMs that don't count toward the owner's quota.
ALTER TABLE "VirtualMachine" ADD COLUMN "quotaExempt" BOOLEAN NOT NULL DEFAULT false;
