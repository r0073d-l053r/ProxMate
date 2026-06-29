"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ShieldCheck, ShieldOff, Loader2, KeyRound, Copy, Fingerprint, Plus, Trash2, KeySquare, Terminal } from "lucide-react";
import { startRegistration } from "@simplewebauthn/browser";
import { api, apiError } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { useAuthStore } from "@/lib/auth-store";
import type { MeResponse, SshKey, ApiTokenInfo, CreatedApiToken } from "@/lib/types";
import { PageHeader } from "@/components/dashboard/page-header";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/form-field";

type Status = { enabled: boolean; recoveryCodesLeft: number };
type Setup = { otpauthUrl: string; secret: string; qrDataUrl: string };
type Passkey = { id: string; name: string; createdAt: string; lastUsedAt: string | null };

export default function SecurityPage() {
  const [status, setStatus] = useState<Status | null>(null);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState("");
  const [disableCode, setDisableCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [passkeyList, setPasskeyList] = useState<Passkey[] | null>(null);
  const [addingPasskey, setAddingPasskey] = useState(false);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [sshKeys, setSshKeys] = useState<SshKey[] | null>(null);
  const [keyName, setKeyName] = useState("");
  const [keyValue, setKeyValue] = useState("");
  const [savingKey, setSavingKey] = useState(false);
  const [apiTokens, setApiTokens] = useState<ApiTokenInfo[] | null>(null);
  const [tokenName, setTokenName] = useState("");
  const [creatingToken, setCreatingToken] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const setStoreMfa = useAuthStore((s) => s.setMfaSetupRequired);

  const load = useCallback(() => {
    api
      .get<Status>("/auth/2fa/status")
      .then((r) => setStatus(r.data))
      .catch((e) => toast.error(apiError(e)));
    api
      .get<{ passkeys: Passkey[] }>("/auth/passkeys")
      .then((r) => setPasskeyList(r.data.passkeys))
      .catch((e) => toast.error(apiError(e)));
    api
      .get<SshKey[]>("/ssh-keys")
      .then((r) => setSshKeys(r.data))
      .catch((e) => toast.error(apiError(e)));
    api
      .get<ApiTokenInfo[]>("/api-tokens")
      .then((r) => setApiTokens(r.data))
      .catch((e) => toast.error(apiError(e)));
    // Keep the admin-required-2FA gate accurate as the user enrols/removes methods.
    api
      .get<MeResponse>("/auth/me")
      .then((r) => {
        const required = !!r.data.user.mfaSetupRequired;
        setMfaRequired(required);
        setStoreMfa(required);
      })
      .catch(() => {});
  }, [setStoreMfa]);

  async function saveSshKey() {
    setSavingKey(true);
    try {
      await api.post("/ssh-keys", { name: keyName.trim(), publicKey: keyValue.trim() });
      setKeyName("");
      setKeyValue("");
      toast.success("SSH key saved.");
      load();
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSavingKey(false);
    }
  }

  async function removeSshKey(id: string) {
    try {
      await api.delete(`/ssh-keys/${id}`);
      toast.success("SSH key removed.");
      load();
    } catch (err) {
      toast.error(apiError(err));
    }
  }

  async function createToken() {
    if (!tokenName.trim()) return;
    setCreatingToken(true);
    try {
      const r = await api.post<CreatedApiToken>("/api-tokens", { name: tokenName.trim() });
      setNewToken(r.data.token); // shown once
      setTokenName("");
      const list = await api.get<ApiTokenInfo[]>("/api-tokens");
      setApiTokens(list.data);
      toast.success("API token created — copy it now, it won't be shown again.");
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setCreatingToken(false);
    }
  }

  async function revokeToken(id: string) {
    try {
      await api.delete(`/api-tokens/${id}`);
      setApiTokens((t) => t?.filter((x) => x.id !== id) ?? null);
      toast.success("API token revoked.");
    } catch (err) {
      toast.error(apiError(err));
    }
  }

  async function addPasskey() {
    setAddingPasskey(true);
    try {
      const { data: options } = await api.post("/auth/passkeys/register/options");
      const reg = await startRegistration({ optionsJSON: options });
      await api.post("/auth/passkeys/register/verify", {
        response: reg,
        name: `Passkey · ${new Date().toLocaleDateString()}`,
      });
      toast.success("Passkey added.");
      load();
    } catch (err) {
      if (err instanceof Error && err.name === "InvalidStateError") {
        toast.error("This device already has a passkey for your account.");
      } else if (!(err instanceof Error && (err.name === "NotAllowedError" || err.name === "AbortError"))) {
        toast.error(apiError(err));
      }
    } finally {
      setAddingPasskey(false);
    }
  }

  async function removePasskey(id: string) {
    try {
      await api.delete(`/auth/passkeys/${id}`);
      toast.success("Passkey removed.");
      load();
    } catch (err) {
      toast.error(apiError(err));
    }
  }

  useEffect(load, [load]);

  async function startSetup() {
    setBusy(true);
    try {
      const r = await api.post<Setup>("/auth/2fa/setup");
      setSetup(r.data);
    } catch (e) {
      toast.error(apiError(e));
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnable() {
    setBusy(true);
    try {
      const r = await api.post<{ recoveryCodes: string[] }>("/auth/2fa/enable", { code });
      setRecoveryCodes(r.data.recoveryCodes);
      setSetup(null);
      setCode("");
      toast.success("Two-factor authentication is on.");
      load();
    } catch (e) {
      toast.error(apiError(e));
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    try {
      await api.post("/auth/2fa/disable", { code: disableCode });
      setDisableCode("");
      toast.success("Two-factor authentication disabled.");
      load();
    } catch (e) {
      toast.error(apiError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="Security" description="Protect your account with two-factor authentication." />

      {mfaRequired && (
        <div className="mb-6 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm">
          <p className="font-medium text-amber-600 dark:text-amber-400">
            Two-step authentication is required
          </p>
          <p className="mt-1 text-muted-foreground">
            Your administrator requires a second factor before you can use ProxMate. Set up an
            authenticator app or add a passkey below to continue.
          </p>
        </div>
      )}

      {/* Recovery codes shown once, right after enabling */}
      {recoveryCodes && (
        <Card className="mb-6 border-primary/40">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="size-5 text-primary" /> Save your recovery codes
            </CardTitle>
            <CardDescription>
              Each code works once if you lose your authenticator. Store them somewhere safe — they
              won&apos;t be shown again.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <div className="grid grid-cols-2 gap-2 rounded-md bg-muted/60 p-3 font-mono text-sm">
              {recoveryCodes.map((c) => (
                <span key={c}>{c}</span>
              ))}
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => copyText(recoveryCodes.join("\n"))}>
                <Copy /> Copy all
              </Button>
              <Button size="sm" onClick={() => setRecoveryCodes(null)}>
                I&apos;ve saved them
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {status === null ? (
        <Card>
          <CardContent className="flex items-center justify-center gap-2 py-12 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </CardContent>
        </Card>
      ) : setup ? (
        // Enrollment in progress
        <Card>
          <CardHeader>
            <CardTitle>Set up your authenticator</CardTitle>
            <CardDescription>
              Scan this QR code with Google Authenticator, 1Password, Authy, etc. — then enter the
              6-digit code it shows to confirm.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="flex flex-col items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={setup.qrDataUrl} alt="2FA QR code" className="size-44 rounded-md bg-white p-2" />
              <p className="text-center text-xs text-muted-foreground">
                Can&apos;t scan? Enter this key manually:
                <br />
                <code className="font-mono break-all">{setup.secret}</code>
              </p>
            </div>
            <FormField label="6-digit code" htmlFor="code">
              <Input
                id="code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                autoComplete="one-time-code"
              />
            </FormField>
            <div className="flex gap-2">
              <Button onClick={confirmEnable} disabled={busy}>
                {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                Enable 2FA
              </Button>
              <Button variant="ghost" onClick={() => setSetup(null)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : status.enabled ? (
        // Enabled → status + disable
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-5 text-emerald-500" /> Two-factor authentication is on
            </CardTitle>
            <CardDescription>
              You&apos;ll enter a code from your authenticator each time you sign in.
              {" "}
              {status.recoveryCodesLeft} recovery {status.recoveryCodesLeft === 1 ? "code" : "codes"} left.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <p className="text-sm text-muted-foreground">
              To turn it off, confirm with a current code (or a recovery code):
            </p>
            <div className="flex gap-2">
              <Input
                value={disableCode}
                onChange={(e) => setDisableCode(e.target.value)}
                placeholder="123456"
                className="max-w-40"
                autoComplete="one-time-code"
              />
              <Button variant="destructive" onClick={disable} disabled={busy || !disableCode}>
                {busy ? <Loader2 className="animate-spin" /> : <ShieldOff />}
                Disable 2FA
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        // Not enabled → offer setup
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldOff className="size-5 text-amber-500" /> Two-factor authentication is off
            </CardTitle>
            <CardDescription>
              Add a second step at sign-in using an authenticator app (TOTP). Strongly recommended.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={startSetup} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
              Set up 2FA
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Passkeys */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Fingerprint className="size-5 text-primary" /> Passkeys
          </CardTitle>
          <CardDescription>
            Sign in without a password using your device&apos;s biometrics or a security key.
            Phishing-resistant, and counts as multi-factor on its own.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {passkeyList === null ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : passkeyList.length === 0 ? (
            <p className="text-sm text-muted-foreground">No passkeys yet.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {passkeyList.map((pk) => (
                <li key={pk.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                  <div>
                    <p className="font-medium">{pk.name}</p>
                    <p className="text-xs text-muted-foreground">
                      Added {new Date(pk.createdAt).toLocaleDateString()}
                      {pk.lastUsedAt ? ` · last used ${new Date(pk.lastUsedAt).toLocaleDateString()}` : ""}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removePasskey(pk.id)}
                    aria-label={`Remove ${pk.name}`}
                  >
                    <Trash2 className="text-destructive" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div>
            <Button variant="outline" onClick={addPasskey} disabled={addingPasskey}>
              {addingPasskey ? <Loader2 className="animate-spin" /> : <Plus />}
              Add a passkey
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* SSH keys (reused on cloud-init VM deploys) */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <KeySquare className="size-5 text-primary" /> SSH keys
          </CardTitle>
          <CardDescription>
            Save your SSH public keys here and pick them when deploying a cloud-init VM — no more
            pasting the same key every time.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {sshKeys === null ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : sshKeys.length === 0 ? (
            <p className="text-sm text-muted-foreground">No saved keys yet.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {sshKeys.map((k) => (
                <li key={k.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium">{k.name}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground" title={k.publicKey}>
                      {k.publicKey}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeSshKey(k.id)}
                    aria-label={`Remove ${k.name}`}
                  >
                    <Trash2 className="text-destructive" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="grid gap-2 border-t pt-3">
            <FormField label="Key name" htmlFor="keyName">
              <Input
                id="keyName"
                value={keyName}
                onChange={(e) => setKeyName(e.target.value)}
                placeholder="e.g. laptop"
                maxLength={60}
              />
            </FormField>
            <FormField label="Public key" htmlFor="keyValue">
              <textarea
                id="keyValue"
                value={keyValue}
                onChange={(e) => setKeyValue(e.target.value)}
                placeholder="ssh-ed25519 AAAA… you@laptop"
                className="h-20 w-full resize-none rounded-md border bg-background p-2 font-mono text-xs outline-none focus:ring-2 focus:ring-ring"
              />
            </FormField>
            <div>
              <Button
                variant="outline"
                onClick={saveSshKey}
                disabled={savingKey || !keyName.trim() || !keyValue.trim()}
              >
                {savingKey ? <Loader2 className="animate-spin" /> : <Plus />}
                Save key
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Terminal className="size-5" /> API tokens
          </CardTitle>
          <CardDescription>
            Personal tokens for scripts, a CLI, or Terraform. Send as{" "}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">Authorization: Bearer &lt;token&gt;</code>.
            A token acts as you. See <code className="rounded bg-muted px-1 py-0.5 text-xs">/api/openapi.json</code>{" "}
            for the API.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3">
          {newToken && (
            <div className="grid gap-2 rounded-md border border-primary/40 bg-primary/5 p-3">
              <p className="text-sm font-medium">Your new token — copy it now, it won&apos;t be shown again:</p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded bg-background px-2 py-1.5 font-mono text-xs">{newToken}</code>
                <Button variant="outline" size="sm" onClick={() => copyText(newToken)}>
                  <Copy /> Copy
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setNewToken(null)}>
                  Done
                </Button>
              </div>
            </div>
          )}

          {apiTokens === null ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          ) : apiTokens.length === 0 ? (
            <p className="text-sm text-muted-foreground">No API tokens yet.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {apiTokens.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium">{t.name}</p>
                    <p className="truncate font-mono text-xs text-muted-foreground">
                      {t.prefix}…{t.lastUsedAt ? ` · last used ${new Date(t.lastUsedAt).toLocaleDateString()}` : " · never used"}
                    </p>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => revokeToken(t.id)} aria-label={`Revoke ${t.name}`}>
                    <Trash2 className="text-destructive" />
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <div className="flex items-end gap-2 border-t pt-3">
            <div className="flex-1">
              <FormField label="Token name" htmlFor="tokenName">
                <Input
                  id="tokenName"
                  value={tokenName}
                  onChange={(e) => setTokenName(e.target.value)}
                  placeholder="e.g. ci, laptop, terraform"
                  maxLength={60}
                />
              </FormField>
            </div>
            <Button variant="outline" onClick={createToken} disabled={creatingToken || !tokenName.trim()}>
              {creatingToken ? <Loader2 className="animate-spin" /> : <Plus />}
              Create token
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
