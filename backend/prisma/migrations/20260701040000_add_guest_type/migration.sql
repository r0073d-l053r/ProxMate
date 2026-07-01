-- AlterTable: discriminate QEMU VMs from LXC containers. Existing rows are all
-- full VMs, so default to "qemu" (the original, implicit type).
ALTER TABLE "VirtualMachine" ADD COLUMN "type" TEXT NOT NULL DEFAULT 'qemu';
