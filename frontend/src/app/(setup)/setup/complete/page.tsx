"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, Loader2, Rocket } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { useSetupStore } from "@/lib/setup-store";
import { useAuthStore } from "@/lib/auth-store";
import type { AuthResponse } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-2 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="truncate font-medium">{value || "—"}</span>
    </div>
  );
}

export default function SetupCompletePage() {
  const router = useRouter();
  const setup = useSetupStore();
  const resetSetup = useSetupStore((s) => s.reset);
  const setAuth = useAuthStore((s) => s.setAuth);
  const [submitting, setSubmitting] = useState(false);

  async function onFinish() {
    setSubmitting(true);
    try {
      const res = await api.post<AuthResponse>("/setup/complete");
      setAuth(res.data.token, res.data.user);
      resetSetup();
      toast.success("Setup complete — welcome to ProxMate!");
      router.replace("/");
    } catch (err) {
      toast.error(apiError(err));
      setSubmitting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Review &amp; finish</CardTitle>
        <CardDescription>
          Confirm everything looks right. Finishing generates the server&apos;s signing secret and
          signs you in as the administrator.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="divide-y rounded-lg border px-3">
          <Row label="Admin" value={`${setup.adminName} (${setup.adminEmail})`} />
          <Row label="Proxmox host" value={setup.proxmoxHost} />
          <Row label="API token" value={setup.proxmoxTokenId} />
          <Row
            label="Cluster"
            value={
              setup.proxmoxVersion
                ? `VE ${setup.proxmoxVersion} · ${setup.nodeCount} node${setup.nodeCount === 1 ? "" : "s"}`
                : ""
            }
          />
          <Row label="Storage pool" value={setup.defaultStorage} />
          <Row label="Network bridge" value={setup.defaultBridge} />
          <Row label="ISO storage" value={setup.isoStorage} />
        </div>

        <div className="mt-6 flex items-center justify-between gap-2">
          <Button variant="ghost" onClick={() => router.push("/setup/defaults")} disabled={submitting}>
            <ArrowLeft />
            Back
          </Button>
          <Button onClick={onFinish} disabled={submitting}>
            {submitting ? <Loader2 className="animate-spin" /> : <Rocket />}
            Finish setup
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
