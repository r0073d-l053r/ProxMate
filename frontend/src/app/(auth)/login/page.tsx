"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, LogIn, ShieldCheck, KeyRound, Building2 } from "lucide-react";
import { startAuthentication } from "@simplewebauthn/browser";
import { api, apiError, apiBaseUrl } from "@/lib/api";
import { useAuthStore, useHydrated } from "@/lib/auth-store";
import { setEnrollmentToken } from "@/lib/enrollment";
import type { AuthUser } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/form-field";

export default function LoginPage() {
  const router = useRouter();
  const setUser = useAuthStore((s) => s.setUser);
  const user = useAuthStore((s) => s.user);
  const hydrated = useHydrated();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [ready, setReady] = useState(false);
  const [setupComplete, setSetupComplete] = useState(true);
  const [adminExists, setAdminExists] = useState(true);
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [sso, setSso] = useState<{ enabled: boolean; label: string } | null>(null);

  // Redirect to setup if not configured; to dashboard if already signed in.
  useEffect(() => {
    if (!hydrated) return;
    let active = true;

    if (user) {
      api
        .get<{ setupComplete: boolean }>("/setup/status")
        .then((res) => {
          if (!active) return;
          if (res.data.setupComplete) {
            router.replace("/");
          } else {
            router.replace("/setup");
          }
        })
        .catch(() => {
          if (active) router.replace("/");
        });
      return;
    }

    api
      .get<{ setupComplete: boolean; adminExists: boolean }>("/setup/status")
      .then((res) => {
        if (!active) return;
        setSetupComplete(res.data.setupComplete);
        setAdminExists(res.data.adminExists);
        setReady(true);
      })
      .catch(() => {
        if (active) setReady(true);
      });

    return () => {
      active = false;
    };
  }, [hydrated, user, router]);

  // SSO: load the button label, and surface any error bounced back from the callback.
  useEffect(() => {
    api
      .get<{ enabled: boolean; label: string }>("/auth/sso/info")
      .then((r) => setSso(r.data))
      .catch(() => {});
    const err = new URLSearchParams(window.location.search).get("sso_error");
    if (err) {
      toast.error(err);
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await api.post<{
        user?: AuthUser;
        twoFactorRequired?: boolean;
        challenge?: string;
        mfaEnrollmentRequired?: boolean;
        enrollmentToken?: string;
      }>("/auth/login", { email, password });
      // Required 2FA not set up yet → no session; resume enrollment with the
      // scoped token (this is the recovery path after a mobile tab eviction).
      if (res.data.mfaEnrollmentRequired && res.data.enrollmentToken) {
        setEnrollmentToken(res.data.enrollmentToken);
        router.replace("/setup-2fa");
        return;
      }
      if (res.data.twoFactorRequired && res.data.challenge) {
        setChallenge(res.data.challenge);
        setSubmitting(false);
        return;
      }
      if (res.data.user) {
        setUser(res.data.user);
        router.replace(setupComplete ? "/" : "/setup");
      }
    } catch (err) {
      toast.error(apiError(err));
      setSubmitting(false);
    }
  }

  async function verify2fa(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await api.post<{ user: AuthUser }>("/auth/2fa/verify", { challenge, code });
      setUser(res.data.user);
      router.replace(setupComplete ? "/" : "/setup");
    } catch (err) {
      toast.error(apiError(err));
      setSubmitting(false);
    }
  }

  async function passkeyLogin() {
    setSubmitting(true);
    try {
      const { data: options } = await api.post("/auth/passkeys/auth/options");
      const assertion = await startAuthentication({ optionsJSON: options });
      const res = await api.post<{ user: AuthUser }>("/auth/passkeys/auth/verify", assertion);
      setUser(res.data.user);
      router.replace(setupComplete ? "/" : "/setup");
    } catch (err) {
      // The user dismissing the browser passkey prompt isn't an error worth shouting about.
      if (err instanceof Error && (err.name === "NotAllowedError" || err.name === "AbortError")) {
        setSubmitting(false);
        return;
      }
      toast.error(apiError(err));
      setSubmitting(false);
    }
  }

  if (!ready) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> Loading…
      </div>
    );
  }

  if (!adminExists) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Welcome to ProxMate</CardTitle>
          <CardDescription>No administrator account exists yet.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            ProxMate needs an administrator account to manage invites, users, and the Proxmox connection. Please create the administrator account first.
          </p>
          <Button onClick={() => router.push("/setup")} className="w-full">
            Go to Setup
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (challenge) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="size-5 text-primary" /> Two-factor authentication
          </CardTitle>
          <CardDescription>
            Enter the 6-digit code from your authenticator app — or one of your recovery codes.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={verify2fa} className="grid gap-4">
            <FormField label="Authentication code" htmlFor="code">
              <Input
                id="code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                autoFocus
                autoComplete="one-time-code"
              />
            </FormField>
            <Button type="submit" disabled={submitting} className="mt-2">
              {submitting ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
              Verify
            </Button>
            <button
              type="button"
              onClick={() => {
                setChallenge(null);
                setCode("");
              }}
              className="text-center text-sm text-muted-foreground hover:text-foreground"
            >
              Back to sign in
            </button>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Welcome back. Enter your credentials to continue.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4">
          <FormField label="Email" htmlFor="email">
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              autoFocus
            />
          </FormField>
          <FormField label="Password" htmlFor="password">
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </FormField>
          <Button type="submit" disabled={submitting} className="mt-2">
            {submitting ? <Loader2 className="animate-spin" /> : <LogIn />}
            Sign in
          </Button>
          <div className="text-center text-sm">
            <Link href="/forgot-password" className="text-muted-foreground hover:text-foreground">
              Forgot your password?
            </Link>
          </div>
        </form>
        <div className="relative my-4">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-xs">
            <span className="bg-card px-2 text-muted-foreground">or</span>
          </div>
        </div>
        <Button type="button" variant="outline" onClick={passkeyLogin} disabled={submitting} className="w-full">
          <KeyRound />
          Sign in with a passkey
        </Button>
        {sso?.enabled && (
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              window.location.href = `${apiBaseUrl}/auth/sso/login`;
            }}
            disabled={submitting}
            className="mt-3 w-full"
          >
            <Building2 />
            {sso.label}
          </Button>
        )}
        {!setupComplete && (
          <div className="mt-4 text-center text-sm">
            <span className="text-muted-foreground">Setup is incomplete. </span>
            <button
              type="button"
              onClick={() => router.push("/setup")}
              className="text-primary hover:underline font-medium cursor-pointer"
            >
              Continue Setup
            </button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
