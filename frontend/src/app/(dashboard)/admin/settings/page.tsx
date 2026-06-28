"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Loader2, Plug, Save, RefreshCw, ShieldCheck, ShieldAlert, Mail, Building2, Copy } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import type { AdminSettings, ProxmoxResources, IsolationStatus } from "@/lib/types";
import { cn } from "@/lib/utils";
import { PageHeader } from "@/components/dashboard/page-header";
import { UpdatesCard } from "@/components/admin/updates-card";
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

  // SMTP (email) — optional
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState(587);
  const [smtpSecure, setSmtpSecure] = useState(false);
  const [smtpUser, setSmtpUser] = useState("");
  const [smtpPass, setSmtpPass] = useState("");
  const [smtpFrom, setSmtpFrom] = useState("");
  const [smtpHasPass, setSmtpHasPass] = useState(false);
  const [savingSmtp, setSavingSmtp] = useState(false);
  const [testingSmtp, setTestingSmtp] = useState(false);

  // SSO (OIDC) — optional
  const [ssoEnabled, setSsoEnabled] = useState(false);
  const [ssoIssuer, setSsoIssuer] = useState("");
  const [ssoClientId, setSsoClientId] = useState("");
  const [ssoClientSecret, setSsoClientSecret] = useState("");
  const [ssoScopes, setSsoScopes] = useState("openid profile email");
  const [ssoGroupsClaim, setSsoGroupsClaim] = useState("groups");
  const [ssoAdminGroup, setSsoAdminGroup] = useState("");
  const [ssoAllowSignup, setSsoAllowSignup] = useState(false);
  const [ssoButtonLabel, setSsoButtonLabel] = useState("Sign in with SSO");
  const [ssoHasSecret, setSsoHasSecret] = useState(false);
  const [ssoCallbackUrl, setSsoCallbackUrl] = useState("");
  const [savingSso, setSavingSso] = useState(false);
  const [testingSso, setTestingSso] = useState(false);

  // Network isolation
  const [isolation, setIsolation] = useState<IsolationStatus | null>(null);
  const [togglingIsolation, setTogglingIsolation] = useState(false);
  const [mgmtCidr, setMgmtCidr] = useState("");
  const [enforcing, setEnforcing] = useState(false);
  const [dnsServers, setDnsServers] = useState("");
  const [savingDns, setSavingDns] = useState(false);

  function loadIsolation() {
    api
      .get<IsolationStatus>("/admin/isolation")
      .then((res) => {
        setIsolation(res.data);
        if (res.data.suggestedMgmtCidr) setMgmtCidr(res.data.suggestedMgmtCidr);
        setDnsServers(res.data.dnsServers ?? "");
      })
      .catch(() => setIsolation(null));
  }

  async function saveDnsServers() {
    if (!isolation) return;
    setSavingDns(true);
    try {
      await api.put("/admin/isolation", { enabled: isolation.isolationEnabled, dnsServers });
      toast.success("DNS isolation settings saved — new VMs will use them.");
      loadIsolation();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSavingDns(false);
    }
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
        if (res.data.smtp.configured) {
          const s = res.data.smtp;
          setSmtpHost(s.host);
          setSmtpPort(s.port);
          setSmtpSecure(s.secure);
          setSmtpUser(s.user);
          setSmtpFrom(s.from);
          setSmtpHasPass(s.hasPass);
        }
        setSsoCallbackUrl(res.data.sso.callbackUrl);
        if (res.data.sso.configured) {
          const s = res.data.sso;
          setSsoEnabled(s.enabled);
          setSsoIssuer(s.issuer);
          setSsoClientId(s.clientId);
          setSsoScopes(s.scopes);
          setSsoGroupsClaim(s.groupsClaim);
          setSsoAdminGroup(s.adminGroup);
          setSsoAllowSignup(s.allowSignup);
          setSsoButtonLabel(s.buttonLabel);
          setSsoHasSecret(s.hasSecret);
        }
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

  async function saveSmtp(e: React.FormEvent) {
    e.preventDefault();
    if (!smtpHost.trim()) {
      toast.error("Enter an SMTP host.");
      return;
    }
    setSavingSmtp(true);
    try {
      await api.put("/admin/settings/smtp", {
        host: smtpHost.trim(),
        port: smtpPort,
        secure: smtpSecure,
        user: smtpUser || undefined,
        pass: smtpPass || undefined,
        from: smtpFrom || undefined,
      });
      if (smtpPass) setSmtpHasPass(true);
      setSmtpPass("");
      toast.success("Email settings saved.");
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSavingSmtp(false);
    }
  }

  async function testSmtp() {
    setTestingSmtp(true);
    try {
      await api.post("/admin/settings/smtp/test");
      toast.success("SMTP connection OK.");
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setTestingSmtp(false);
    }
  }

  async function saveSso(e: React.FormEvent) {
    e.preventDefault();
    if (!ssoIssuer.trim() || !ssoClientId.trim()) {
      toast.error("Enter the issuer URL and client ID.");
      return;
    }
    setSavingSso(true);
    try {
      await api.put("/admin/settings/sso", {
        enabled: ssoEnabled,
        issuer: ssoIssuer.trim(),
        clientId: ssoClientId.trim(),
        clientSecret: ssoClientSecret || undefined,
        scopes: ssoScopes || undefined,
        groupsClaim: ssoGroupsClaim || undefined,
        adminGroup: ssoAdminGroup || undefined,
        allowSignup: ssoAllowSignup,
        buttonLabel: ssoButtonLabel || undefined,
      });
      if (ssoClientSecret) setSsoHasSecret(true);
      setSsoClientSecret("");
      toast.success("SSO settings saved.");
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSavingSso(false);
    }
  }

  // Tests the *saved* config (discovery runs server-side) — save before testing.
  async function testSso() {
    setTestingSso(true);
    try {
      await api.post("/admin/settings/sso/test");
      toast.success("Discovery OK — the provider is reachable.");
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setTestingSso(false);
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

      {/* Updates */}
      <div className="mb-6">
        <UpdatesCard />
      </div>

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

            {/* Optional DNS allow-list for tenant isolation */}
            {isolation.isolationEnabled && (
              <div className="grid gap-2">
                <FormField
                  label="DNS servers (optional)"
                  htmlFor="dnsServers"
                  hint="Tenant VMs always resolve names — by default DNS is allowed to any resolver. To tighten, list your DNS server IP(s), comma-separated, and isolation will permit DNS only to those. Leave blank for auto."
                >
                  <Input
                    id="dnsServers"
                    value={dnsServers}
                    onChange={(e) => setDnsServers(e.target.value)}
                    placeholder="e.g. 192.168.60.13"
                  />
                </FormField>
                <Button className="w-fit" disabled={savingDns} onClick={saveDnsServers}>
                  {savingDns ? <Loader2 className="animate-spin" /> : null}
                  Save DNS settings
                </Button>
              </div>
            )}

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

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Mail className="size-4" /> Email (SMTP)
          </CardTitle>
          <CardDescription>
            Optional. Lets ProxMate send password-reset emails — point it at any SMTP relay (e.g. the
            same one your Proxmox uses). Without it, password resets fall back to admin approval.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveSmtp} className="grid gap-4">
            <FormField label="Host" htmlFor="smtpHost">
              <Input
                id="smtpHost"
                value={smtpHost}
                onChange={(e) => setSmtpHost(e.target.value)}
                placeholder="smtp.example.com"
              />
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Port" htmlFor="smtpPort">
                <Input
                  id="smtpPort"
                  type="number"
                  value={smtpPort}
                  onChange={(e) => setSmtpPort(Number(e.target.value))}
                />
              </FormField>
              <FormField label="From address" htmlFor="smtpFrom">
                <Input
                  id="smtpFrom"
                  value={smtpFrom}
                  onChange={(e) => setSmtpFrom(e.target.value)}
                  placeholder="noreply@example.com"
                />
              </FormField>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Username" htmlFor="smtpUser" hint="Blank for unauthenticated relays.">
                <Input id="smtpUser" value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} />
              </FormField>
              <FormField
                label="Password"
                htmlFor="smtpPass"
                hint={smtpHasPass ? "A password is set. Leave blank to keep it." : undefined}
              >
                <Input
                  id="smtpPass"
                  type="password"
                  value={smtpPass}
                  onChange={(e) => setSmtpPass(e.target.value)}
                  placeholder={smtpHasPass ? "••••••••" : ""}
                />
              </FormField>
            </div>
            <label className="flex items-center gap-2 text-sm select-none">
              <input
                type="checkbox"
                checked={smtpSecure}
                onChange={(e) => setSmtpSecure(e.target.checked)}
                className="size-4 rounded border-input accent-primary"
              />
              Use TLS (port 465). Leave off for STARTTLS on 587.
            </label>
            <div className="flex gap-2">
              <Button type="submit" disabled={savingSmtp}>
                {savingSmtp ? <Loader2 className="animate-spin" /> : <Save />}
                Save email settings
              </Button>
              <Button type="button" variant="outline" onClick={testSmtp} disabled={testingSmtp}>
                {testingSmtp ? <Loader2 className="animate-spin" /> : <Plug />}
                Test
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="size-4" /> Single sign-on (OIDC)
          </CardTitle>
          <CardDescription>
            Optional. Let users sign in with your identity provider (Keycloak, Authentik, Auth0, Entra ID,
            Google…). Local passwords keep working alongside it. Save first, then use Test.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={saveSso} className="grid gap-4">
            <FormField
              label="Redirect / callback URL"
              htmlFor="ssoCallback"
              hint="Register this exact URL in your provider as the allowed redirect URI."
            >
              <div className="flex gap-2">
                <Input id="ssoCallback" value={ssoCallbackUrl} readOnly className="font-mono text-xs" />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => copyText(ssoCallbackUrl)}
                  aria-label="Copy callback URL"
                >
                  <Copy />
                </Button>
              </div>
            </FormField>
            <FormField
              label="Issuer URL"
              htmlFor="ssoIssuer"
              hint="The provider's base URL — it must serve /.well-known/openid-configuration."
            >
              <Input
                id="ssoIssuer"
                value={ssoIssuer}
                onChange={(e) => setSsoIssuer(e.target.value)}
                placeholder="https://keycloak.example.com/realms/main"
              />
            </FormField>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Client ID" htmlFor="ssoClientId">
                <Input
                  id="ssoClientId"
                  value={ssoClientId}
                  onChange={(e) => setSsoClientId(e.target.value)}
                  placeholder="proxmate"
                />
              </FormField>
              <FormField
                label="Client secret"
                htmlFor="ssoClientSecret"
                hint={ssoHasSecret ? "A secret is set. Leave blank to keep it." : undefined}
              >
                <Input
                  id="ssoClientSecret"
                  type="password"
                  value={ssoClientSecret}
                  onChange={(e) => setSsoClientSecret(e.target.value)}
                  placeholder={ssoHasSecret ? "••••••••" : ""}
                />
              </FormField>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Scopes" htmlFor="ssoScopes">
                <Input
                  id="ssoScopes"
                  value={ssoScopes}
                  onChange={(e) => setSsoScopes(e.target.value)}
                  placeholder="openid profile email"
                />
              </FormField>
              <FormField label="Login button label" htmlFor="ssoButtonLabel">
                <Input
                  id="ssoButtonLabel"
                  value={ssoButtonLabel}
                  onChange={(e) => setSsoButtonLabel(e.target.value)}
                  placeholder="Sign in with Keycloak"
                />
              </FormField>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <FormField label="Groups claim" htmlFor="ssoGroupsClaim" hint="ID-token claim listing the user's groups.">
                <Input
                  id="ssoGroupsClaim"
                  value={ssoGroupsClaim}
                  onChange={(e) => setSsoGroupsClaim(e.target.value)}
                  placeholder="groups"
                />
              </FormField>
              <FormField label="Admin group" htmlFor="ssoAdminGroup" hint="Members become admins. Blank = no mapping.">
                <Input
                  id="ssoAdminGroup"
                  value={ssoAdminGroup}
                  onChange={(e) => setSsoAdminGroup(e.target.value)}
                  placeholder="proxmate-admins"
                />
              </FormField>
            </div>
            <label className="flex items-center gap-2 text-sm select-none">
              <input
                type="checkbox"
                checked={ssoAllowSignup}
                onChange={(e) => setSsoAllowSignup(e.target.checked)}
                className="size-4 rounded border-input accent-primary"
              />
              Auto-create accounts for new SSO users. Off = only existing/invited accounts may sign in.
            </label>
            <label className="flex items-center gap-2 text-sm select-none">
              <input
                type="checkbox"
                checked={ssoEnabled}
                onChange={(e) => setSsoEnabled(e.target.checked)}
                className="size-4 rounded border-input accent-primary"
              />
              Enable SSO (show the button on the login page).
            </label>
            <div className="flex gap-2">
              <Button type="submit" disabled={savingSso}>
                {savingSso ? <Loader2 className="animate-spin" /> : <Save />}
                Save SSO settings
              </Button>
              <Button type="button" variant="outline" onClick={testSso} disabled={testingSso}>
                {testingSso ? <Loader2 className="animate-spin" /> : <Plug />}
                Test
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
