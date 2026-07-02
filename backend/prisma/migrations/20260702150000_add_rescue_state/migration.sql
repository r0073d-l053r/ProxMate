-- Non-null while a VM is booted into rescue mode: JSON snapshot of the
-- pre-rescue { boot, ide3 } config, restored on exit.
ALTER TABLE "VirtualMachine" ADD COLUMN "rescueBoot" TEXT;
