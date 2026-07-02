-- The guest's Tailscale (100.64.0.0/10) address, when Tailscale runs inside it.
ALTER TABLE "VirtualMachine" ADD COLUMN "tailscaleIp" TEXT;
