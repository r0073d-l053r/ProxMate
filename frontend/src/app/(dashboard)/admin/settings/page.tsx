"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plug, Save, RefreshCw, ShieldCheck, ShieldAlert } from "lucide-react";
import { api, apiError } from "@/lib/api";
import type { AdminSettings, ProxmoxResources, IsolationStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/form-field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

export default function SettingsPage() {
  const [loading, setLoading] = useState(true);
  const [resources, setResources] = useState<ProxmoxResources | null>(null);
  const [resourceError, setResourceError] = useState<string | null>(null);

  // Connection
  const [host, setHost] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [tokenSecret, setTokenSecret] = useState("");
  const [verifySsl, setVerifySsl] = useState(false);
  const [hasSecret, setHasSecret] = useState(false);
  const [savingConn, setSavingConn] = useState(false);
  const [testing, setTesting] = useState(false);

  // Defaults
  const [storage, setStorage] = useState("");
  const [bridge, setBridge] = useState("");
  const [isoStorage, setIsoStorage] = useState("");
  const [savingDefaults, setSavingDefaults] = useState(false);

  // Network isolation
  const [isolation, setIsolation] = useState<IsolationStatus | null>(null);
  const [togglingIsolation, setTogglingIsolation] = useState(false);
  const [mgmtCidr, setMgmtCidr] = useState("");
  const [enforcing, setEnforcing] = useState(false);

  function loadIsolation() {
    api
      .get<IsolationStatus>("/admin/isolation")
      .then((res) => {
        setIsolation(res.data);
        if (res.data.suggestedMgmtCidr) setMgmtCidr(res.data.suggestedMgmtCidr);
      })
      .catch(() => setIsolation(null));
  }

  async function enableEnforcement() {
    if (!mgmtCidr.trim()) {
      toast.error("Enter the management subnet (e.g. 192.168.1.0/24).");
      return;
    }
    setEnforcing(true);
    try {
      await api.post("/admin/isolation/enforce", { managementCidr: mgmtCidr.trim() });
      toast.success("Cluster firewall enabled — tenant isolation is now enforced.");
      loadIsolation();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setEnforcing(false);
    }
  }

  async function disableEnforcement() {
    setEnforcing(true);
    try {
      await api.delete("/admin/isolation/enforce");
      toast.success("Cluster firewall disabled.");
      loadIsolation();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setEnforcing(false);
    }
  }

  async function toggleIsolation(enabled: boolean) {
    setTogglingIsolation(true);
    try {
      await api.put("/admin/isolation", { enabled });
      toast.success(enabled ? "Isolation enabled for new VMs." : "Isolation disabled.");
      loadIsolation();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setTogglingIsolation(false);
    }
  }

  function loadResources() {
    setResourceError(null);
    api
      .get<ProxmoxResources>("/proxmox/resources")
      .then((res) => setResources(res.data))
      .catch((err) => setResourceError(apiError(err)));
  }

  useEffect(() => {
    api
      .get<AdminSettings>("/admin/settings")
      .then((res) => {
        const { proxmox, defaults } = res.data;
        setHost(proxmox.host ?? "");
        setTokenId(proxmox.tokenId ?? "");
        setVerifySsl(proxmox.verifySsl);
        setHasSecret(proxmox.hasSecret);
        setStorage(defaults.storage ?? "");
        setBridge(defaults.bridge ?? "");
        setIsoStorage(defaults.isoStorage ?? "");
      })
      .catch((err) => toast.error(apiError(err)))
      .finally(() => setLoading(false));
    loadResources();
    loadIsolation();
  }, []);

  async function saveConnection(e: React.FormEvent) {
    e.preventDefault();
    setSavingConn(true);
    try {
      await api.put("/admin/settings/proxmox", {
        host,
        tokenId,
        tokenSecret: tokenSecret || undefined,
        verifySsl,
      });
      if (tokenSecret) setHasSecret(true);
      setTokenSecret("");
      toast.success("Connection settings saved.");
      loadResources();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSavingConn(false);
    }
  }

  async function testConnection() {
    setTesting(true);
    try {
      const res = await api.post<{ version: string; nodeCount: number }>(
        "/admin/settings/proxmox/test",
      );
      toast.success(`Connected to Proxmox VE ${res.data.version} (${res.data.nodeCount} nodes)`);
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setTesting(false);
    }
  }

  async function saveDefaults(e: React.FormEvent) {
    e.preventDefault();
    if (!storage || !bridge || !isoStorage) {
      toast.error("Select a value for each default.");
      return;
    }
    setSavingDefaults(true);
    try {
      await api.put("/admin/settings/defaults", { storage, bridge, isoStorage });
      toast.success("Defaults saved.");
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSavingDefaults(false);
    }
  }

  if (loading) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageHeader title="Settings" />
        <div className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader title="Settings" description="Reconfigure the Proxmox connection and VM defaults." />

      {/* Network isolation */}
      {isolation && (
        <Card className="mb-6">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {isolation.enforced ? (
                <ShieldCheck className="size-4 text-emerald-500" />
              ) : (
                <ShieldAlert className="size-4 text-amber-500" />
              )}
              Tenant network isolation
            </CardTitle>
            <CardDescription>
              When enabled, every VM ProxMate creates gets a firewall that blocks access to your LAN,
              other VMs, and the Proxmox host — while still allowing internet access.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <label className="flex items-center gap-2 text-sm select-none">
              <input
                type="checkbox"
                checked={isolation.isolationEnabled}
                disabled={togglingIsolation}
                onChange={(e) => toggleIsolation(e.target.checked)}
                className="size-4 rounded border-input accent-primary"
              />
              Apply isolation firewall to new VMs
            </label>

            <div
              className={cn(
                "rounded-lg border p-3 text-sm",
                isolation.enforced
                  ? "border-emerald-500/30 bg-emerald-500/10"
                  : "border-amber-500/30 bg-amber-500/10",
              )}
            >
              {isolation.enforced ? (
                <p>
                  <span className="font-medium">Isolation is enforced.</span> New VMs are firewalled
                  off from the rest of your infrastructure.
                </p>
              ) : !isolation.clusterFirewallEnabled ? (
                <p>
                  <span className="font-medium">Not enforced yet.</span> ProxMate is configuring each
                  VM&apos;s firewall, but rules only take effect once the{" "}
                  <span className="font-medium">Proxmox cluster firewall</span> is enabled. Until
                  then, VMs share your LAN. See <code>SECURITY.md</code> for the safe steps to enable
                  it (and the recommended dedicated-VLAN setup).
                </p>
              ) : (
                <p>
                  <span className="font-medium">Isolation is disabled.</span> New VMs will be placed
                  on your network without isolation rules.
                </p>
              )}
            </div>

            {/* Guided enforcement: enable/disable the Proxmox cluster firewall */}
            {isolation.isolationEnabled && !isolation.enforced && (
              <div className="grid gap-2">
                <FormField
                  label="Management subnet (kept reachable)"
                  htmlFor="mgmtCidr"
                  hint="Your admin network — an allow-rule is added for web UI (8006) + SSH (22) before enabling, so you aren't locked out."
                >
                  <Input
                    id="mgmtCidr"
                    value={mgmtCidr}
                    onChange={(e) => setMgmtCidr(e.target.value)}
                    placeholder="192.168.1.0/24"
                  />
                </FormField>
                <AlertDialog>
                  <AlertDialogTrigger
                    render={
                      <Button className="w-fit" disabled={enforcing}>
                        {enforcing ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                        Enable enforcement
                      </Button>
                    }
                  />
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Enable the Proxmox cluster firewall?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This turns on the datacenter firewall so per-VM isolation takes effect. An
                        allow-rule for <span className="font-medium">{mgmtCidr || "your subnet"}</span>{" "}
                        (ports 8006 + 22) is added first so you keep management access; Proxmox keeps
                        cluster traffic flowing automatically. You can disable it again here at any time.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction onClick={enableEnforcement}>Enable</AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            )}

            {isolation.enforced && (
              <Button
                variant="outline"
                className="w-fit"
                disabled={enforcing}
                onClick={disableEnforcement}
              >
                {enforcing ? <Loader2 className="animate-spin" /> : <ShieldAlert />}
                Disable enforcement
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Proxmox connection</CardTitle>
          <CardDescription>
            Update the API endpoint or token. Leave the secret blank to keep the current one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveConnection} className="grid gap-4">
            <FormField label="Proxmox host URL" htmlFor="host">
              <Input id="host" value={host} onChange={(e) => setHost(e.target.value)} />
            </FormField>
            <FormField label="API token ID" htmlFor="tokenId">
              <Input id="tokenId" value={tokenId} onChange={(e) => setTokenId(e.target.value)} />
            </FormField>
            <FormField
              label="API token secret"
              htmlFor="tokenSecret"
              hint={hasSecret ? "A secret is currently set. Leave blank to keep it." : "No secret set yet."}
            >
              <Input
                id="tokenSecret"
                type="password"
                value={tokenSecret}
                onChange={(e) => setTokenSecret(e.target.value)}
                placeholder={hasSecret ? "••••••••" : ""}
              />
            </FormField>
            <label className="flex items-center gap-2 text-sm select-none">
              <input
                type="checkbox"
                checked={verifySsl}
                onChange={(e) => setVerifySsl(e.target.checked)}
                className="size-4 rounded border-input accent-primary"
              />
              Verify TLS certificate
            </label>
            <div className="flex gap-2">
              <Button type="submit" disabled={savingConn}>
                {savingConn ? <Loader2 className="animate-spin" /> : <Save />}
                Save changes
              </Button>
              <Button type="button" variant="outline" onClick={testConnection} disabled={testing}>
                {testing ? <Loader2 className="animate-spin" /> : <Plug />}
                Test connection
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>VM defaults</CardTitle>
          <CardDescription>Applied when users create new VMs.</CardDescription>
        </CardHeader>
        <CardContent>
          {resourceError ? (
            <div className="grid gap-3 py-2 text-center">
              <p className="text-sm text-destructive">{resourceError}</p>
              <Button variant="outline" onClick={loadResources} className="justify-self-center">
                <RefreshCw /> Retry
              </Button>
            </div>
          ) : !resources ? (
            <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Fetching resources…
            </div>
          ) : (
            <form onSubmit={saveDefaults} className="grid gap-4">
              <FormField label="Default storage pool">
                <Select value={storage} onValueChange={(v) => setStorage(v as string)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a storage pool" />
                  </SelectTrigger>
                  <SelectContent>
                    {resources.storages.map((s) => (
                      <SelectItem key={s.name} value={s.name}>
                        {s.name}
                        <span className="text-muted-foreground"> · {s.type}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label="Default network bridge">
                <Select value={bridge} onValueChange={(v) => setBridge(v as string)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a bridge" />
                  </SelectTrigger>
                  <SelectContent>
                    {resources.bridges.map((b) => (
                      <SelectItem key={b.name} value={b.name}>
                        {b.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField label="ISO storage">
                <Select value={isoStorage} onValueChange={(v) => setIsoStorage(v as string)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select ISO storage" />
                  </SelectTrigger>
                  <SelectContent>
                    {resources.isoStorages.map((s) => (
                      <SelectItem key={s.name} value={s.name}>
                        {s.name}
                        <span className="text-muted-foreground"> · {s.type}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <Button type="submit" disabled={savingDefaults} className="w-fit">
                {savingDefaults ? <Loader2 className="animate-spin" /> : <Save />}
                Save defaults
              </Button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
