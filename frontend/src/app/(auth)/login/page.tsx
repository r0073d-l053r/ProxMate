"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, LogIn } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { useAuthStore, useHydrated } from "@/lib/auth-store";
import type { AuthResponse } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/form-field";

export default function LoginPage() {
  const router = useRouter();
  const setAuth = useAuthStore((s) => s.setAuth);
  const token = useAuthStore((s) => s.token);
  const hydrated = useHydrated();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [ready, setReady] = useState(false);
  const [setupComplete, setSetupComplete] = useState(true);
  const [adminExists, setAdminExists] = useState(true);

  // Redirect to setup if not configured; to dashboard if already signed in.
  useEffect(() => {
    if (!hydrated) return;
    let active = true;

    if (token) {
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
  }, [hydrated, token, router]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      const res = await api.post<AuthResponse>("/auth/login", { email, password });
      setAuth(res.data.token, res.data.user);
      if (setupComplete) {
        router.replace("/");
      } else {
        router.replace("/setup");
      }
    } catch (err) {
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
        </form>
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
