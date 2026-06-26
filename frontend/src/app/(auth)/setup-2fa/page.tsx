"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AxiosError } from "axios";
import { ShieldCheck, Loader2, KeyRound, Copy, Fingerprint } from "lucide-react";
import { startRegistration } from "@simplewebauthn/browser";
import { api, apiError } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { getEnrollmentToken, clearEnrollmentToken } from "@/lib/enrollment";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/form-field";

type Setup = { otpauthUrl: string; secret: string; qrDataUrl: string };

export default function Setup2faPage() {
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [code, setCode] = useState("");
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [addingPasskey, setAddingPasskey] = useState(false);

  // The enrollment token lives in memory only. If it's gone (full reload / mobile
  // tab eviction), there's nothing to resume from — bounce to sign in, where a
  // password re-entry hands back a fresh one. No session ever exists here.
  useEffect(() => {
    const t = getEnrollmentToken();
    if (!t) {
      toast.error("Your setup session expired — sign in to continue.");
      router.replace("/login");
      return;
    }
    setToken(t);
    setReady(true);
  }, [router]);

  const auth = token ? { headers: { Authorization: `Bearer ${token}` } } : undefined;

  /** Treat an expired/inert enrollment token (401) as "go sign in again". */
  function handleError(err: unknown) {
    if (err instanceof AxiosError && err.response?.status === 401) {
      clearEnrollmentToken();
      toast.error("Your setup session expired — sign in to continue.");
      router.replace("/login");
      return;
    }
    toast.error(apiError(err));
  }

  function finishToLogin() {
    clearEnrollmentToken();
    toast.success("Two-step authentication is set up — sign in to finish.");
    router.replace("/login");
  }

  async function startSetup() {
    setBusy(true);
    try {
      const r = await api.post<Setup>("/auth/2fa/setup", undefined, auth);
      setSetup(r.data);
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  async function confirmEnable() {
    setBusy(true);
    try {
      const r = await api.post<{ recoveryCodes: string[] }>("/auth/2fa/enable", { code }, auth);
      setRecoveryCodes(r.data.recoveryCodes);
      setSetup(null);
      setCode("");
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  }

  async function addPasskey() {
    setAddingPasskey(true);
    try {
      const { data: options } = await api.post("/auth/passkeys/register/options", undefined, auth);
      const reg = await startRegistration({ optionsJSON: options });
      await api.post(
        "/auth/passkeys/register/verify",
        { response: reg, name: `Passkey · ${new Date().toLocaleDateString()}` },
        auth,
      );
      finishToLogin();
    } catch (err) {
      if (err instanceof Error && (err.name === "NotAllowedError" || err.name === "AbortError")) {
        setAddingPasskey(false);
        return;
      }
      handleError(err);
      setAddingPasskey(false);
    }
  }

  if (!ready) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> Loading…
      </div>
    );
  }

  // Recovery codes shown once, right after enabling TOTP → then sign in.
  if (recoveryCodes) {
    return (
      <Card className="border-primary/40">
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
            <Button size="sm" onClick={finishToLogin}>
              I&apos;ve saved them — sign in
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="size-5 text-primary" /> Set up two-step authentication
        </CardTitle>
        <CardDescription>
          Your invite requires a second factor. Set one up now — then you&apos;ll sign in with it to
          finish creating your account.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {setup ? (
          <>
            <div className="flex flex-col items-center gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={setup.qrDataUrl} alt="2FA QR code" className="size-44 rounded-md bg-white p-2" />
              <p className="text-center text-xs text-muted-foreground">
                Scan with Google Authenticator, 1Password, Authy, etc. Can&apos;t scan? Enter this key:
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
                inputMode="numeric"
              />
            </FormField>
            <div className="flex gap-2">
              <Button onClick={confirmEnable} disabled={busy || code.length < 6}>
                {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                Enable
              </Button>
              <Button variant="ghost" onClick={() => setSetup(null)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </>
        ) : (
          <>
            <Button onClick={startSetup} disabled={busy}>
              {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
              Set up authenticator app
            </Button>

            <div className="relative my-1">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t" />
              </div>
              <div className="relative flex justify-center text-xs">
                <span className="bg-card px-2 text-muted-foreground">or</span>
              </div>
            </div>

            <Button variant="outline" onClick={addPasskey} disabled={addingPasskey}>
              {addingPasskey ? <Loader2 className="animate-spin" /> : <Fingerprint />}
              Use a passkey instead
            </Button>
            <p className="text-center text-xs text-muted-foreground">
              A passkey (device biometrics or a security key) counts as your second factor on its own.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
