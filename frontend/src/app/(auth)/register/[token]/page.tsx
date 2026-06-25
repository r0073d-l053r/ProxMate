"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, UserPlus, Cpu, MemoryStick, HardDrive, TriangleAlert, ShieldCheck } from "lucide-react";
import { api, apiError } from "@/lib/api";
import { useAuthStore } from "@/lib/auth-store";
import type { AuthResponse, InviteValidation } from "@/lib/types";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { FormField } from "@/components/form-field";
import { formatRam } from "@/lib/format";

export default function RegisterPage() {
  const router = useRouter();
  const { token } = useParams<{ token: string }>();
  const setUser = useAuthStore((s) => s.setUser);

  const [invite, setInvite] = useState<InviteValidation | null>(null);
  const [checking, setChecking] = useState(true);
  const [invalid, setInvalid] = useState(false);

  const [displayName, setDisplayName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let active = true;
    api
      .get<InviteValidation>(`/auth/invite/${token}`)
      .then((res) => active && setInvite(res.data))
      .catch(() => active && setInvalid(true))
      .finally(() => active && setChecking(false));
    return () => {
      active = false;
    };
  }, [token]);

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
      const res = await api.post<AuthResponse>("/auth/register", {
        displayName,
        email,
        password,
        inviteToken: token,
      });
      setUser(res.data.user);
      toast.success("Account created — welcome to ProxMate!");
      router.replace("/");
    } catch (err) {
      toast.error(apiError(err));
      setSubmitting(false);
    }
  }

  if (checking) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" /> Validating invite…
      </div>
    );
  }

  if (invalid || !invite) {
    return (
      <Card>
        <CardHeader>
          <div className="flex size-10 items-center justify-center rounded-md bg-destructive/10 text-destructive">
            <TriangleAlert className="size-5" />
          </div>
          <CardTitle>Invite not valid</CardTitle>
          <CardDescription>
            This invite link is invalid, has expired, or has already been used. Ask your
            administrator for a new one.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => router.replace("/login")} className="w-full">
            Go to sign in
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Create your account</CardTitle>
        <CardDescription>
          {invite.label ? `You've been invited as "${invite.label}". ` : "You've been invited to ProxMate. "}
          Your account includes the resource quota below.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="mb-4 grid grid-cols-3 gap-2 text-center text-sm">
          <div className="rounded-lg border p-2">
            <Cpu className="mx-auto mb-1 size-4 text-muted-foreground" />
            <div className="font-medium">{invite.quotas.maxCpu}</div>
            <div className="text-xs text-muted-foreground">vCPU</div>
          </div>
          <div className="rounded-lg border p-2">
            <MemoryStick className="mx-auto mb-1 size-4 text-muted-foreground" />
            <div className="font-medium">{formatRam(invite.quotas.maxRam)}</div>
            <div className="text-xs text-muted-foreground">RAM</div>
          </div>
          <div className="rounded-lg border p-2">
            <HardDrive className="mx-auto mb-1 size-4 text-muted-foreground" />
            <div className="font-medium">{invite.quotas.maxStorage} GB</div>
            <div className="text-xs text-muted-foreground">Disk</div>
          </div>
        </div>

        {invite.require2fa && (
          <div className="mb-4 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-xs">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="text-muted-foreground">
              This invite requires{" "}
              <span className="font-medium text-foreground">two-step authentication</span>. Right after
              signing up, you&apos;ll set up an authenticator app or a passkey before you can continue.
            </span>
          </div>
        )}

        <form onSubmit={onSubmit} className="grid gap-4">
          <FormField label="Display name" htmlFor="displayName" error={errors.displayName}>
            <Input id="displayName" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoFocus />
          </FormField>
          <FormField label="Email" htmlFor="email" error={errors.email}>
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
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
            <Input id="confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </FormField>
          <Button type="submit" disabled={submitting} className="mt-2">
            {submitting ? <Loader2 className="animate-spin" /> : <UserPlus />}
            Create account
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
