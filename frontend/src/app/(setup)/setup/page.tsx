"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowRight, Loader2 } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { useSetupStore } from "@/lib/setup-store";
import { useAuthStore } from "@/lib/auth-store";
import type { AuthResponse } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/form-field";

export default function SetupAdminPage() {
  const router = useRouter();
  const setSetup = useSetupStore((s) => s.set);
  const setAuth = useAuthStore((s) => s.setAuth);

  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [adminExists, setAdminExists] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState(true);

  useEffect(() => {
    let active = true;
    api
      .get<{ adminExists: boolean }>("/setup/status")
      .then((res) => {
        if (active) {
          setAdminExists(res.data.adminExists);
          setLoadingStatus(false);
        }
      })
      .catch(() => {
        if (active) setLoadingStatus(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function validate(): boolean {
    const e: Record<string, string> = {};
    if (!displayName.trim()) e.displayName = "Display name is required";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) e.email = "Enter a valid email address";
    if (password.length < 8) e.password = "Password must be at least 8 characters";
    if (password !== confirm) e.confirm = "Passwords do not match";
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function onSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    if (!validate()) return;
    setSubmitting(true);
    try {
      const res = await api.post<AuthResponse>("/setup/admin", { displayName, email, password });
      setAuth(res.data.token, res.data.user);
      setSetup({ adminEmail: email, adminName: displayName });
      router.push("/setup/proxmox");
    } catch (err) {
      toast.error(apiError(err));
    } finally {
      setSubmitting(false);
    }
  }

  if (loadingStatus) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> Loading…
      </div>
    );
  }

  if (adminExists) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Welcome to ProxMate</CardTitle>
          <CardDescription>
            An administrator account has already been created.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            The initial administrator account has already been set up. Please sign in to continue configuring the Proxmox connection and default settings.
          </p>
          <Button onClick={() => router.push("/login")} className="w-full">
            Go to Sign In
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Welcome to ProxMate</CardTitle>
        <CardDescription>
          Create the administrator account. This account manages invites, users, and the Proxmox
          connection.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4">
          <FormField label="Display name" htmlFor="displayName" error={errors.displayName}>
            <Input
              id="displayName"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Jane Doe"
              autoFocus
            />
          </FormField>
          <FormField label="Email" htmlFor="email" error={errors.email}>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="admin@example.com"
            />
          </FormField>
          <FormField label="Password" htmlFor="password" error={errors.password}>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
            />
          </FormField>
          <FormField label="Confirm password" htmlFor="confirm" error={errors.confirm}>
            <Input
              id="confirm"
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
            />
          </FormField>
          <Button type="submit" disabled={submitting} className="mt-2">
            {submitting ? <Loader2 className="animate-spin" /> : <ArrowRight data-icon="inline-end" />}
            Continue
          </Button>
        </form>
        <div className="mt-4 text-center text-sm">
          <span className="text-muted-foreground">Already have an account? </span>
          <button
            type="button"
            onClick={() => router.push("/login")}
            className="text-primary hover:underline font-medium cursor-pointer"
          >
            Sign in
          </button>
        </div>
      </CardContent>
    </Card>
  );
}
