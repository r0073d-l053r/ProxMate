"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRight, ArrowLeft, Loader2, Plug, CircleCheck } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { useSetupStore } from "@/lib/setup-store";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/form-field";

export default function SetupProxmoxPage() {
  const router = useRouter();
  const setSetup = useSetupStore((s) => s.set);

  const [host, setHost] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [tokenSecret, setTokenSecret] = useState("");
  const [verifySsl, setVerifySsl] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [testing, setTesting] = useState(false);
  const [tested, setTested] = useState(false);

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!/^https?:\/\/.+/.test(host)) e.host = "Enter a full URL, e.g. https://192.168.1.100:8006";
    if (!tokenId.trim()) e.tokenId = "API token ID is required";
    if (!tokenSecret.trim()) e.tokenSecret = "API token secret is required";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function onTest() {
    if (!validate()) return;
    setTesting(true);
    setTested(false);
    try {
      await api.post("/setup/proxmox", { host, tokenId, tokenSecret, verifySsl });
      const res = await api.post<{ version: string; nodeCount: number }>("/setup/proxmox/test");
      setSetup({
        proxmoxHost: host,
        proxmoxTokenId: tokenId,
        proxmoxVersion: res.data.version,
        nodeCount: res.data.nodeCount,
      });
      setTested(true);
      toast.success(`Connected to Proxmox VE ${res.data.version} (${res.data.nodeCount} node${res.data.nodeCount === 1 ? "" : "s"})`);
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setTesting(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Connect to Proxmox</CardTitle>
        <CardDescription>
          Enter the Proxmox API endpoint and an API token. The token secret is stored encrypted and
          never leaves the server.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onTest();
          }}
          className="grid gap-4"
        >
          <FormField label="Proxmox host URL" htmlFor="host" error={errors.host}>
            <Input
              id="host"
              value={host}
              onChange={(e) => {
                setHost(e.target.value);
                setTested(false);
              }}
              placeholder="https://192.168.1.100:8006"
              autoFocus
            />
          </FormField>
          <FormField
            label="API token ID"
            htmlFor="tokenId"
            error={errors.tokenId}
            hint="e.g. proxmate@pam!dashboard"
          >
            <Input
              id="tokenId"
              value={tokenId}
              onChange={(e) => {
                setTokenId(e.target.value);
                setTested(false);
              }}
              placeholder="proxmate@pam!dashboard"
            />
          </FormField>
          <FormField label="API token secret" htmlFor="tokenSecret" error={errors.tokenSecret}>
            <Input
              id="tokenSecret"
              type="password"
              value={tokenSecret}
              onChange={(e) => {
                setTokenSecret(e.target.value);
                setTested(false);
              }}
              placeholder="••••••••-••••-••••"
            />
          </FormField>

          <label className="flex items-center gap-2 text-sm select-none">
            <input
              type="checkbox"
              checked={verifySsl}
              onChange={(e) => {
                setVerifySsl(e.target.checked);
                setTested(false);
              }}
              className="size-4 rounded border-input accent-primary"
            />
            Verify TLS certificate
            <span className="text-xs text-muted-foreground">(disable for self-signed certs)</span>
          </label>

          <Button type="submit" variant="outline" disabled={testing}>
            {testing ? <Loader2 className="animate-spin" /> : tested ? <CircleCheck /> : <Plug />}
            {tested ? "Connection verified" : "Test connection"}
          </Button>
        </form>

        <div className="mt-4 flex items-center justify-between gap-2">
          <Button variant="ghost" onClick={() => router.push("/setup")}>
            <ArrowLeft />
            Back
          </Button>
          <Button
            disabled={!tested}
            onClick={() => router.push("/setup/defaults")}
          >
            Continue
            <ArrowRight data-icon="inline-end" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
