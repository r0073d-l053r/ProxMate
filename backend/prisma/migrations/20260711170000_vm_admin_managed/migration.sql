-- Admin-provisioned-for-tenant VMs: the tenant can operate but not resize them
-- (also a quota-safety requirement for quota-exempt grants). Admin-set only.
ALTER TABLE "VirtualMachine" ADD COLUMN "adminManaged" BOOLEAN NOT NULL DEFAULT false;
